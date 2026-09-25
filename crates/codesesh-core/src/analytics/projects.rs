use super::{DashboardCostFacts, DashboardScope, Metrics, attribution, project_key};
use crate::{
    contract::{CostSource, SessionHead},
    query::{SessionTree, in_window},
};
use serde_json::{Value, json};
use std::collections::HashMap;

#[derive(Default)]
struct ProjectMetrics {
    total: Metrics,
    estimated: bool,
    agents: Vec<(String, Metrics)>,
}
impl ProjectMetrics {
    fn agent(&mut self, name: &str) -> &mut Metrics {
        let index = self
            .agents
            .iter()
            .position(|(n, _)| n == name)
            .unwrap_or_else(|| {
                self.agents.push((name.to_owned(), Metrics::default()));
                self.agents.len() - 1
            });
        &mut self.agents[index].1
    }
}

pub fn attach_project_metrics(
    projects: &[Value],
    sessions: &[SessionHead],
    from: Option<f64>,
    to: Option<f64>,
    facts: Option<&DashboardCostFacts>,
) -> Vec<Value> {
    let tree = SessionTree::new(sessions);
    let mut metrics = HashMap::<String, ProjectMetrics>::new();
    for &entry in &tree.entries {
        let s = tree.sessions[entry];
        if !in_window(s.time_updated, from, to) {
            continue;
        }
        let m = metrics.entry(project_key(s)).or_default();
        m.total.sessions += 1;
        m.agent(&s.reference.agent_name.to_lowercase()).sessions += 1;
    }
    let contributions = attribution::contributions(
        &tree,
        &DashboardScope::default(),
        from,
        to.unwrap_or(f64::INFINITY),
        facts,
    );
    for c in &contributions {
        if !c.has_usage {
            continue;
        }
        let s = tree.sessions[c.entry];
        let m = metrics.entry(project_key(s)).or_default();
        m.total.messages += c.usage.messages;
        m.total.tokens += c.usage.tokens;
        let a = m.agent(&s.reference.agent_name.to_lowercase());
        a.messages += c.usage.messages;
        a.tokens += c.usage.tokens;
    }
    for c in &contributions {
        if c.cost <= 0.0 {
            continue;
        }
        let s = tree.sessions[c.entry];
        let m = metrics.entry(project_key(s)).or_default();
        m.total.cost += c.cost;
        if c.source == CostSource::Estimated {
            m.estimated = true;
        }
        m.agent(&s.reference.agent_name.to_lowercase()).cost += c.cost;
    }
    projects
        .iter()
        .map(|p| {
            let mut p = p.clone();
            let key = format!(
                "{}:{}",
                p["identityKind"].as_str().unwrap_or(""),
                p["identityKey"].as_str().unwrap_or("")
            );
            let mut empty = ProjectMetrics::default();
            let m = metrics.get_mut(&key).unwrap_or(&mut empty);
            p["sessionCount"] = json!(m.total.sessions);
            p["messages"] = json!(m.total.messages);
            p["tokens"] = json!(m.total.tokens);
            p["cost"] = json!(m.total.cost);
            if m.total.cost > 0.0 {
                p["cost_source"] = json!(if m.estimated { "estimated" } else { "recorded" });
            } else if let Some(p) = p.as_object_mut() {
                p.remove("cost_source");
            }
            m.agents.sort_by(|a, b| b.1.sessions.cmp(&a.1.sessions));
            p["agentStats"] = json!(
                m.agents
                    .iter()
                    .map(|(name, m)| {
                        let mut a = m.value();
                        a["name"] = json!(name);
                        a
                    })
                    .collect::<Vec<_>>()
            );
            p
        })
        .collect()
}

pub fn summarize_projects(projects: &[Value]) -> Value {
    let mut sessions = 0_u64;
    let mut tokens = 0.0;
    let mut cost = 0.0;
    let mut latest = None;
    for project in projects {
        sessions += project["sessionCount"].as_u64().unwrap_or(0);
        tokens += project["tokens"].as_f64().unwrap_or(0.0);
        cost += project["cost"].as_f64().unwrap_or(0.0);
        if let Some(time) = project["lastActivity"].as_f64() {
            latest = Some(latest.map_or(time, |old: f64| old.max(time)));
        }
    }
    json!({"projects":projects.len(),"sessions":sessions,"tokens":tokens,"cost":cost,"latestActivity":latest})
}
