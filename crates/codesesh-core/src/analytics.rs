mod active_hours;
mod attribution;
pub use active_hours::active_hours;
mod facts;
mod projects;
mod read;
mod response;
mod time_zone;
pub use facts::*;
pub use projects::{attach_project_metrics, summarize_projects};
pub use read::load_cost_facts;
pub use response::{DashboardResponseOptions, dashboard_response};
pub use time_zone::DashboardTimeZone;

use crate::{
    contract::SessionHead,
    query::{SessionTree, in_window},
};
use chrono::{DateTime, Days, Local, NaiveDate};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{BTreeMap, HashMap, HashSet};

#[derive(Clone, Default, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DashboardScope {
    pub agent: Option<String>,
    pub project_kind: Option<String>,
    pub project_key: Option<String>,
}
impl DashboardScope {
    pub fn matches(&self, session: &SessionHead) -> bool {
        self.agent
            .as_ref()
            .is_none_or(|a| *a == session.reference.agent_name.to_lowercase())
            && ((self.project_kind.is_none() && self.project_key.is_none())
                || (self.project_kind.as_ref() == Some(&session.project_identity.kind)
                    && self.project_key.as_ref() == Some(&session.project_identity.key)))
    }
}

pub struct DashboardOptions<'a> {
    pub by_agent_names: &'a [String],
    pub scope: &'a DashboardScope,
    pub from: Option<f64>,
    pub to: f64,
    pub agent_info: Option<&'a HashMap<String, Value>>,
    pub compare: Option<(f64, f64)>,
    pub cost_facts: Option<&'a DashboardCostFacts>,
}

fn date(time: f64) -> NaiveDate {
    crate::time::date_time_clip(time)
        .and_then(DateTime::from_timestamp_millis)
        .unwrap_or(DateTime::UNIX_EPOCH)
        .with_timezone(&Local)
        .date_naive()
}
fn day(time: f64) -> String {
    date(time).format("%Y-%m-%d").to_string()
}
fn project_key(s: &SessionHead) -> String {
    format!("{}:{}", s.project_identity.kind, s.project_identity.key)
}

#[derive(Default)]
struct Metrics {
    sessions: usize,
    messages: usize,
    tokens: f64,
    cost: f64,
}
impl Metrics {
    fn value(&self) -> Value {
        json!({"sessions":self.sessions,"messages":self.messages,"tokens":self.tokens,"cost":self.cost})
    }
}
struct Project {
    kind: String,
    key: String,
    name: String,
    metrics: Metrics,
    estimated: bool,
    agents: Vec<(String, usize)>,
    sparkline: Vec<f64>,
}
#[derive(Default)]
struct Daily {
    sessions: usize,
    messages: usize,
    cost: f64,
    input: f64,
    output: f64,
    cache_read: f64,
    cache_create: f64,
}
struct Acc {
    metrics: Metrics,
    recorded: f64,
    estimated: f64,
    cache_read: f64,
    agents: Vec<(String, Metrics)>,
    agent_keys: HashSet<String>,
    daily: BTreeMap<String, Daily>,
    models: Vec<(String, f64, HashSet<usize>)>,
    model_costs: Vec<SessionModelCostFact>,
    projects: Vec<Project>,
    project_indices: HashMap<String, usize>,
    project_keys: HashSet<String>,
    recent: Vec<usize>,
    sparkline: HashMap<String, usize>,
}
impl Acc {
    fn new(names: &[String], scope: &DashboardScope, to: f64) -> Self {
        let agents = names
            .iter()
            .filter(|n| scope.agent.as_ref().is_none_or(|a| *a == n.to_lowercase()))
            .map(|n| (n.clone(), Metrics::default()))
            .collect();
        let mut sparkline = HashMap::new();
        for slot in 0..14 {
            if let Some(d) = date(to).checked_sub_days(Days::new(13 - slot)) {
                sparkline.insert(d.format("%Y-%m-%d").to_string(), slot as usize);
            }
        }
        Self {
            metrics: Metrics::default(),
            recorded: 0.0,
            estimated: 0.0,
            cache_read: 0.0,
            agents,
            agent_keys: HashSet::new(),
            daily: BTreeMap::new(),
            models: Vec::new(),
            model_costs: Vec::new(),
            projects: Vec::new(),
            project_indices: HashMap::new(),
            project_keys: HashSet::new(),
            recent: Vec::new(),
            sparkline,
        }
    }
    fn agent(&mut self, name: &str) -> &mut Metrics {
        let index = self
            .agents
            .iter()
            .position(|(n, _)| n.to_lowercase() == name)
            .unwrap_or_else(|| {
                self.agents.push((name.to_owned(), Metrics::default()));
                self.agents.len() - 1
            });
        &mut self.agents[index].1
    }
    fn project(&mut self, s: &SessionHead) -> &mut Project {
        let key = project_key(s);
        let index = if let Some(&index) = self.project_indices.get(&key) {
            index
        } else {
            let index = self.projects.len();
            self.project_indices.insert(key, index);
            self.projects.push(Project {
                kind: s.project_identity.kind.clone(),
                key: s.project_identity.key.clone(),
                name: s.project_identity.display_name.clone(),
                metrics: Metrics::default(),
                estimated: false,
                agents: Vec::new(),
                sparkline: vec![0.0; 14],
            });
            index
        };
        &mut self.projects[index]
    }
}

fn accumulate(
    tree: &SessionTree<'_>,
    options: &DashboardOptions<'_>,
    from: Option<f64>,
    to: f64,
    fill_days: bool,
) -> Acc {
    let mut acc = Acc::new(options.by_agent_names, options.scope, to);
    if fill_days && let Some(from) = from {
        let mut current = date(from);
        let end = date(to);
        while current <= end {
            acc.daily
                .insert(current.format("%Y-%m-%d").to_string(), Daily::default());
            let Some(next) = current.succ_opt() else {
                break;
            };
            current = next;
        }
    }
    for &entry in &tree.entries {
        let session = tree.sessions[entry];
        if !options.scope.matches(session) || !in_window(session.time_updated, from, Some(to)) {
            continue;
        }
        let agent = session.reference.agent_name.to_lowercase();
        acc.metrics.sessions += 1;
        acc.agent_keys.insert(agent.clone());
        if let Some((_, metric)) = acc
            .agents
            .iter_mut()
            .find(|(n, _)| n.to_lowercase() == agent)
        {
            metric.sessions += 1;
        }
        acc.daily
            .entry(day(session.time_updated))
            .or_default()
            .sessions += 1;
        acc.project_keys.insert(project_key(session));
        let project = acc.project(session);
        project.metrics.sessions += 1;
        if let Some((_, count)) = project.agents.iter_mut().find(|(name, _)| *name == agent) {
            *count += 1;
        } else {
            project.agents.push((agent, 1));
        }
        let index = acc
            .recent
            .iter()
            .position(|&other| session.time_updated > tree.sessions[other].time_updated)
            .unwrap_or(acc.recent.len());
        if index < 10 {
            acc.recent.insert(index, entry);
            acc.recent.truncate(10);
        }
    }
    let contributions =
        attribution::contributions(tree, options.scope, from, to, options.cost_facts);
    for contribution in &contributions {
        let usage = &contribution.usage;
        if usage.messages == 0
            && usage.tokens <= 0.0
            && usage.input <= 0.0
            && usage.output <= 0.0
            && usage.cache_read <= 0.0
            && usage.cache_create <= 0.0
        {
            continue;
        }
        let session = tree.sessions[contribution.entry];
        acc.metrics.messages += usage.messages;
        acc.metrics.tokens += usage.tokens;
        acc.cache_read += usage.cache_read;
        for (model, &tokens) in &usage.models {
            if tokens <= 0.0 {
                continue;
            }
            if let Some((_, count, entries)) =
                acc.models.iter_mut().find(|(name, _, _)| name == model)
            {
                *count += tokens;
                entries.insert(contribution.entry);
            } else {
                acc.models
                    .push((model.clone(), tokens, HashSet::from([contribution.entry])));
            }
        }
        let metric = acc.agent(&session.reference.agent_name.to_lowercase());
        metric.messages += usage.messages;
        metric.tokens += usage.tokens;
        let bucket = acc.daily.entry(day(contribution.time)).or_default();
        bucket.messages += usage.messages;
        bucket.input += (usage.input - usage.cache_read - usage.cache_create).max(0.0);
        bucket.output += usage.output;
        bucket.cache_read += usage.cache_read;
        bucket.cache_create += usage.cache_create;
        let project = acc.project(session);
        project.metrics.messages += usage.messages;
        project.metrics.tokens += usage.tokens;
    }
    for contribution in &contributions {
        let cost = contribution.cost;
        if cost <= 0.0 {
            continue;
        }
        let session = tree.sessions[contribution.entry];
        let estimated = contribution.source == crate::contract::CostSource::Estimated;
        acc.metrics.cost += cost;
        if estimated {
            acc.estimated += cost;
        } else {
            acc.recorded += cost;
        }
        acc.agent(&session.reference.agent_name.to_lowercase()).cost += cost;
        let key = day(contribution.time);
        acc.daily.entry(key.clone()).or_default().cost += cost;
        let slot = acc.sparkline.get(&key).copied();
        let project = acc.project(session);
        project.metrics.cost += cost;
        project.estimated |= estimated;
        if let Some(slot) = slot {
            project.sparkline[slot] += cost;
        }
        for model in &contribution.model_costs {
            if model.model.is_empty() || model.cost <= 0.0 {
                continue;
            }
            let recorded = model.cost_recorded.clamp(0.0, model.cost);
            if let Some(existing) = acc.model_costs.iter_mut().find(|m| m.model == model.model) {
                existing.cost += model.cost;
                existing.cost_recorded += recorded;
            } else {
                acc.model_costs.push(SessionModelCostFact {
                    model: model.model.clone(),
                    cost: model.cost,
                    cost_recorded: recorded,
                });
            }
        }
    }
    acc
}

pub fn build_dashboard(sessions: &[SessionHead], options: &DashboardOptions<'_>) -> Value {
    let tree = SessionTree::new(sessions);
    let mut acc = accumulate(&tree, options, options.from, options.to, true);
    let mut totals = acc.metrics.value();
    totals["costRecorded"] = json!(acc.recorded);
    totals["costEstimated"] = json!(acc.estimated);
    totals["cacheReadTokens"] = json!(acc.cache_read);
    if acc.metrics.cost > 0.0 {
        totals["cost_source"] = json!(if acc.estimated > 0.0 {
            "estimated"
        } else {
            "recorded"
        });
    }
    if let Some(&latest) = acc.recent.first() {
        let s = tree.sessions[latest];
        if s.time_updated != 0.0 {
            totals["latestActivity"] = json!(s.time_updated);
        }
        totals["latestActivityProject"] = json!(s.project_identity.display_name);
        totals["latestActivityAgent"] = json!(s.reference.agent_name.to_lowercase());
    }
    if let Some((from, to)) = options.compare {
        totals["previous"] = accumulate(&tree, options, Some(from), to, false)
            .metrics
            .value();
    }
    acc.agents
        .retain(|(_, m)| m.sessions > 0 || m.messages > 0 || m.tokens > 0.0 || m.cost > 0.0);
    acc.agents
        .sort_by(|(_, a), (_, b)| b.sessions.cmp(&a.sessions).then(b.cost.total_cmp(&a.cost)));
    let agents: Vec<_> = acc
        .agents
        .iter()
        .map(|(name, m)| {
            let mut v = m.value();
            let info = options.agent_info.and_then(|map| map.get(name));
            v["name"] = json!(name);
            v["displayName"] = info
                .and_then(|i| i.get("displayName"))
                .cloned()
                .unwrap_or(json!(name));
            v["icon"] = info
                .and_then(|i| i.get("icon"))
                .cloned()
                .unwrap_or(json!(""));
            if let Some(icon) = info.and_then(|i| i.get("iconColored")) {
                v["iconColored"] = icon.clone();
            }
            v
        })
        .collect();
    let daily:Vec<_>=acc.daily.iter().map(|(date,b)|json!({"date":date,"sessions":b.sessions,"messages":b.messages,"cost":b.cost,"input":b.input,"output":b.output,"cache_read":b.cache_read,"cache_create":b.cache_create})).collect();
    acc.models.sort_by(|a, b| b.1.total_cmp(&a.1));
    let models:Vec<_>=acc.models.iter().map(|(model,tokens,sessions)|json!({"model":model,"tokens":tokens,"sessions":sessions.len()})).collect();
    acc.model_costs.sort_by(|a, b| b.cost.total_cmp(&a.cost));
    let model_cost=options.cost_facts.map(|_|acc.model_costs.iter().take(20).map(|m|json!({"model":m.model,"cost":m.cost,"costRecorded":m.cost_recorded,"costEstimated":m.cost-m.cost_recorded})).collect::<Vec<_>>());
    acc.projects
        .sort_by(|a, b| b.metrics.cost.total_cmp(&a.metrics.cost));
    let projects: Vec<_> = acc
        .projects
        .iter_mut()
        .take(12)
        .map(|p| {
            p.agents.sort_by(|a, b| b.1.cmp(&a.1));
            let mut v = p.metrics.value();
            v["identityKind"] = json!(p.kind);
            v["identityKey"] = json!(p.key);
            v["displayName"] = json!(p.name);
            v["agents"] = json!(p.agents.iter().map(|(name, _)| name).collect::<Vec<_>>());
            v["sparkline"] = json!(p.sparkline);
            if p.metrics.cost > 0.0 {
                v["cost_source"] = json!(if p.estimated { "estimated" } else { "recorded" });
            }
            v
        })
        .collect();
    let remainder = &acc.projects[acc.projects.len().min(12)..];
    // Float Sum uses negative zero for an empty iterator; the wire contract uses positive zero.
    let rollup = json!({"projects":remainder.len(),"sessions":remainder.iter().map(|p|p.metrics.sessions).sum::<usize>(),"tokens":remainder.iter().fold(0.0, |sum,p|sum+p.metrics.tokens),"cost":remainder.iter().fold(0.0, |sum,p|sum+p.metrics.cost)});
    let recent: Vec<_> = acc
        .recent
        .iter()
        .map(|&i| json!({"reference":tree.sessions[i].reference,"session":tree.sessions[i]}))
        .collect();
    json!({"totals":totals,"scopeCounts":{"projects":acc.project_keys.len(),"agents":acc.agent_keys.len()},"perAgent":agents,"dailyActivity":daily,"modelDistribution":models,"modelCost":model_cost,"perProject":projects,"projectRollup":rollup,"recentSessions":recent})
}

#[cfg(test)]
mod tests;
