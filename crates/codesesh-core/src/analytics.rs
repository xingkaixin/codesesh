mod active_hours;
mod attribution;
pub(crate) use active_hours::active_hours;
mod facts;
mod projects;
mod read;
mod response;
mod time_zone;
pub use facts::*;
pub use projects::{attach_project_metrics, summarize_projects};
#[cfg(test)]
pub(crate) use read::load_cost_facts;
pub use read::load_scoped_cost_facts;
pub use response::{DashboardResponseOptions, DashboardTimings, dashboard_response};
pub use time_zone::DashboardTimeZone;

use crate::{
    model::{CostSource, SessionHead},
    session_list::{SessionTree, in_window},
    wire::{
        DashboardAgentStat, DashboardAggregate, DashboardDailyBucket, DashboardPreviousTotals,
        DashboardProjectRollup, DashboardProjectStat, DashboardTotals, ModelCostEntry,
        ModelDistributionEntry, ScopeCounts, closed, referenced,
    },
};
use chrono::{Days, NaiveDate};
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
    pub(crate) fn matches(&self, session: &SessionHead) -> bool {
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
    pub cost_facts: Option<&'a CostFactsIndex>,
    pub time_zone: &'a DashboardTimeZone,
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
    agent_names: Vec<String>,
    agent_keys: HashSet<String>,
    daily: BTreeMap<NaiveDate, Daily>,
    models: Vec<(String, f64, HashSet<usize>)>,
    model_costs: Vec<SessionModelCostFact>,
    projects: Vec<Project>,
    project_indices: HashMap<String, usize>,
    project_keys: HashSet<String>,
    recent: Vec<usize>,
    sparkline: HashMap<NaiveDate, usize>,
}
impl Acc {
    fn new(names: &[String], scope: &DashboardScope, end: NaiveDate) -> Self {
        let agents: Vec<_> = names
            .iter()
            .filter(|n| scope.agent.as_ref().is_none_or(|a| *a == n.to_lowercase()))
            .map(|n| (n.clone(), Metrics::default()))
            .collect();
        let agent_names = agents.iter().map(|(n, _)| n.to_lowercase()).collect();
        let mut sparkline = HashMap::new();
        for slot in 0..14 {
            if let Some(d) = end.checked_sub_days(Days::new(13 - slot)) {
                sparkline.insert(d, slot as usize);
            }
        }
        Self {
            metrics: Metrics::default(),
            recorded: 0.0,
            estimated: 0.0,
            cache_read: 0.0,
            agents,
            agent_names,
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
            .agent_names
            .iter()
            .position(|n| n == name)
            .unwrap_or_else(|| {
                self.agents.push((name.to_owned(), Metrics::default()));
                self.agent_names.push(name.to_lowercase());
                self.agents.len() - 1
            });
        &mut self.agents[index].1
    }
    fn project(&mut self, s: &SessionHead, key: &str) -> &mut Project {
        let index = if let Some(&index) = self.project_indices.get(key) {
            index
        } else {
            let index = self.projects.len();
            self.project_indices.insert(key.to_owned(), index);
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
    let date = |time| options.time_zone.date(time);
    let mut acc = Acc::new(options.by_agent_names, options.scope, date(to));
    // Lowercased agent names and project keys per session, instead of one allocation per fact.
    let agents: Vec<_> = tree
        .sessions
        .iter()
        .map(|s| s.reference.agent_name.to_lowercase())
        .collect();
    let project_keys: Vec<_> = tree.sessions.iter().map(|s| project_key(s)).collect();
    if fill_days && let Some(from) = from {
        let mut current = date(from);
        let end = date(to);
        while current <= end {
            acc.daily.insert(current, Daily::default());
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
        let agent = agents[entry].clone();
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
            .entry(date(session.time_updated))
            .or_default()
            .sessions += 1;
        acc.project_keys.insert(project_keys[entry].clone());
        let project = acc.project(session, &project_keys[entry]);
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
        let metric = acc.agent(&agents[contribution.entry]);
        metric.messages += usage.messages;
        metric.tokens += usage.tokens;
        let bucket = acc.daily.entry(date(contribution.time)).or_default();
        bucket.messages += usage.messages;
        bucket.input += (usage.input - usage.cache_read - usage.cache_create).max(0.0);
        bucket.output += usage.output;
        bucket.cache_read += usage.cache_read;
        bucket.cache_create += usage.cache_create;
        let project = acc.project(session, &project_keys[contribution.entry]);
        project.metrics.messages += usage.messages;
        project.metrics.tokens += usage.tokens;
    }
    for contribution in &contributions {
        let cost = contribution.cost;
        if cost <= 0.0 {
            continue;
        }
        let session = tree.sessions[contribution.entry];
        let estimated = contribution.source == crate::model::CostSource::Estimated;
        acc.metrics.cost += cost;
        if estimated {
            acc.estimated += cost;
        } else {
            acc.recorded += cost;
        }
        acc.agent(&agents[contribution.entry]).cost += cost;
        let key = date(contribution.time);
        acc.daily.entry(key).or_default().cost += cost;
        let slot = acc.sparkline.get(&key).copied();
        let project = acc.project(session, &project_keys[contribution.entry]);
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

pub(crate) fn build_dashboard(
    sessions: &[SessionHead],
    options: &DashboardOptions<'_>,
) -> anyhow::Result<DashboardAggregate> {
    let tree = SessionTree::new(sessions);
    let mut acc = accumulate(&tree, options, options.from, options.to, true);
    let latest = acc.recent.first().map(|&i| tree.sessions[i]);
    let source = |estimated| {
        if estimated {
            CostSource::Estimated
        } else {
            CostSource::Recorded
        }
    };
    let totals = DashboardTotals {
        sessions: acc.metrics.sessions,
        messages: acc.metrics.messages,
        tokens: acc.metrics.tokens,
        cost: acc.metrics.cost,
        cost_recorded: acc.recorded,
        cost_estimated: acc.estimated,
        cache_read_tokens: acc.cache_read,
        cost_source: (acc.metrics.cost > 0.0).then(|| source(acc.estimated > 0.0)),
        latest_activity: latest.map(|s| s.time_updated).filter(|&time| time != 0.0),
        latest_activity_project: latest.map(|s| s.project_identity.display_name.clone()),
        latest_activity_agent: latest.map(|s| s.reference.agent_name.to_lowercase()),
        previous: options.compare.map(|(from, to)| {
            let m = accumulate(&tree, options, Some(from), to, false).metrics;
            DashboardPreviousTotals {
                sessions: m.sessions,
                messages: m.messages,
                tokens: m.tokens,
                cost: m.cost,
            }
        }),
    };
    acc.agents
        .retain(|(_, m)| m.sessions > 0 || m.messages > 0 || m.tokens > 0.0 || m.cost > 0.0);
    acc.agents
        .sort_by(|(_, a), (_, b)| b.sessions.cmp(&a.sessions).then(b.cost.total_cmp(&a.cost)));
    let per_agent = acc
        .agents
        .iter()
        .map(|(name, m)| {
            let info = options.agent_info.and_then(|map| map.get(name));
            let field = |key| info.and_then(|i| i.get(key));
            DashboardAgentStat {
                sessions: m.sessions,
                messages: m.messages,
                tokens: m.tokens,
                cost: m.cost,
                name: name.clone(),
                display_name: field("displayName")
                    .and_then(Value::as_str)
                    .unwrap_or(name)
                    .to_owned(),
                icon: field("icon")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_owned(),
                icon_colored: field("iconColored").and_then(Value::as_bool),
            }
        })
        .collect();
    let daily_activity = acc
        .daily
        .iter()
        .map(|(date, b)| DashboardDailyBucket {
            date: date.format("%Y-%m-%d").to_string(),
            sessions: b.sessions,
            messages: b.messages,
            cost: b.cost,
            input: b.input,
            output: b.output,
            cache_read: b.cache_read,
            cache_create: b.cache_create,
        })
        .collect();
    acc.models.sort_by(|a, b| b.1.total_cmp(&a.1));
    let model_distribution = acc
        .models
        .iter()
        .map(|(model, tokens, sessions)| ModelDistributionEntry {
            model: model.clone(),
            tokens: *tokens,
            sessions: sessions.len(),
        })
        .collect();
    acc.model_costs.sort_by(|a, b| b.cost.total_cmp(&a.cost));
    let model_cost = options.cost_facts.map(|_| {
        acc.model_costs
            .iter()
            .take(20)
            .map(|m| ModelCostEntry {
                model: m.model.clone(),
                cost: m.cost,
                cost_recorded: m.cost_recorded,
                cost_estimated: m.cost - m.cost_recorded,
            })
            .collect()
    });
    acc.projects
        .sort_by(|a, b| b.metrics.cost.total_cmp(&a.metrics.cost));
    let per_project = acc
        .projects
        .iter_mut()
        .take(12)
        .map(|p| {
            p.agents.sort_by(|a, b| b.1.cmp(&a.1));
            Ok(DashboardProjectStat {
                sessions: p.metrics.sessions,
                messages: p.metrics.messages,
                tokens: p.metrics.tokens,
                cost: p.metrics.cost,
                identity_kind: closed(p.kind.clone())?,
                identity_key: p.key.clone(),
                display_name: p.name.clone(),
                agents: p.agents.iter().map(|(name, _)| name.clone()).collect(),
                sparkline: p.sparkline.clone(),
                cost_source: (p.metrics.cost > 0.0).then(|| source(p.estimated)),
            })
        })
        .collect::<Result<_, serde::de::value::Error>>()?;
    let remainder = &acc.projects[acc.projects.len().min(12)..];
    // Float Sum uses negative zero for an empty iterator; the wire contract uses positive zero.
    let project_rollup = DashboardProjectRollup {
        projects: remainder.len(),
        sessions: remainder.iter().map(|p| p.metrics.sessions).sum(),
        tokens: remainder.iter().fold(0.0, |sum, p| sum + p.metrics.tokens),
        cost: remainder.iter().fold(0.0, |sum, p| sum + p.metrics.cost),
    };
    let recent_sessions = acc
        .recent
        .iter()
        .map(|&i| referenced(tree.sessions[i].clone()))
        .collect::<Result<_, _>>()?;
    Ok(DashboardAggregate {
        totals,
        scope_counts: ScopeCounts {
            projects: acc.project_keys.len(),
            agents: acc.agent_keys.len(),
        },
        per_agent,
        daily_activity,
        model_distribution,
        model_cost,
        per_project,
        project_rollup,
        recent_sessions,
    })
}

#[cfg(test)]
mod tests;
