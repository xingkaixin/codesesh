use serde::Serialize;
use std::collections::BTreeMap;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentStatus {
    pub agent_name: String,
    pub status: String,
    pub processed: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total: Option<usize>,
    pub sessions: usize,
    pub updated_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub started_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub completed_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub completeness: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackgroundStatus {
    pub active: bool,
    pub pending_agents: Vec<String>,
    pub completed_agents: Vec<String>,
    pub failed_agents: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_agent: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub progress: Option<ScanProgress>,
}

#[derive(Clone, Debug, Serialize)]
pub struct ScanProgress {
    pub phase: &'static str,
    pub processed: usize,
    pub total: usize,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanStatus {
    #[serde(rename = "type")]
    pub kind: &'static str,
    pub phase: &'static str,
    pub active: bool,
    pub pending_agents: Vec<String>,
    pub scanning_agents: Vec<String>,
    pub completed_agents: Vec<String>,
    pub total_agents: usize,
    pub agent_statuses: BTreeMap<String, AgentStatus>,
    pub updated_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub started_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub completed_at: Option<i64>,
    pub backfill: BackgroundStatus,
    pub search_index_maintenance: BackgroundStatus,
}

impl ScanStatus {
    pub(super) fn new(agents: impl Iterator<Item = String>) -> Self {
        let now = chrono::Utc::now().timestamp_millis();
        let names: Vec<_> = agents.collect();
        Self {
            kind: "scan-status",
            phase: if names.is_empty() {
                "idle"
            } else {
                "initializing"
            },
            active: !names.is_empty(),
            started_at: (!names.is_empty()).then_some(now),
            completed_at: names.is_empty().then_some(now),
            pending_agents: names.clone(),
            scanning_agents: Vec::new(),
            completed_agents: Vec::new(),
            total_agents: names.len(),
            agent_statuses: names
                .into_iter()
                .map(|agent| {
                    (
                        agent.clone(),
                        AgentStatus {
                            agent_name: agent,
                            status: "pending".into(),
                            processed: 0,
                            total: None,
                            sessions: 0,
                            updated_at: now,
                            started_at: None,
                            completed_at: None,
                            error: None,
                            completeness: None,
                        },
                    )
                })
                .collect(),
            updated_at: now,
            backfill: BackgroundStatus::default(),
            search_index_maintenance: BackgroundStatus::default(),
        }
    }

    pub(super) fn update(
        &mut self,
        agent: &str,
        state: String,
        error: Option<String>,
        count: usize,
    ) {
        let now = chrono::Utc::now().timestamp_millis();
        if state == "scanning" && !self.active {
            self.agent_statuses.clear();
            self.started_at = Some(now);
        }
        let started_at = self
            .agent_statuses
            .get(agent)
            .and_then(|status| status.started_at)
            .unwrap_or(now);
        let total = if state == "complete" {
            Some(count)
        } else {
            self.agent_statuses
                .get(agent)
                .and_then(|status| status.total)
        };
        let completed_at = matches!(state.as_str(), "complete" | "failed").then_some(now);
        if state == "failed"
            && self
                .backfill
                .pending_agents
                .iter()
                .any(|name| name == agent)
        {
            self.backfill.pending_agents.retain(|name| name != agent);
            if !self.backfill.failed_agents.iter().any(|name| name == agent) {
                self.backfill.failed_agents.push(agent.into());
            }
            self.backfill.active = !self.backfill.pending_agents.is_empty();
            if self.backfill.current_agent.as_deref() == Some(agent) {
                self.backfill.current_agent = None;
                self.backfill.progress = None;
            }
        }
        self.agent_statuses.insert(
            agent.into(),
            AgentStatus {
                agent_name: agent.into(),
                completeness: (state == "complete").then(|| "complete".into()),
                status: state,
                processed: count,
                total,
                started_at: Some(started_at),
                completed_at,
                sessions: count,
                updated_at: now,
                error,
            },
        );
        self.pending_agents.clear();
        self.scanning_agents.clear();
        self.completed_agents.clear();
        for (name, status) in &self.agent_statuses {
            match status.status.as_str() {
                "pending" => self.pending_agents.push(name.clone()),
                "complete" => self.completed_agents.push(name.clone()),
                "failed" => (),
                _ => self.scanning_agents.push(name.clone()),
            }
        }
        self.active = !self.pending_agents.is_empty() || !self.scanning_agents.is_empty();
        self.phase = if !self.active {
            "idle"
        } else if self
            .scanning_agents
            .iter()
            .all(|name| self.agent_statuses[name].status == "publishing")
            && self.pending_agents.is_empty()
        {
            "publishing"
        } else {
            "scanning"
        };
        self.updated_at = now;
        self.completed_at = (!self.active).then_some(now);
        self.total_agents = self.agent_statuses.len();
    }

    pub(super) fn backfill(&mut self, agent: &str, complete: bool) {
        self.backfill.pending_agents.retain(|name| name != agent);
        self.backfill.failed_agents.retain(|name| name != agent);
        if complete {
            if !self
                .backfill
                .completed_agents
                .iter()
                .any(|name| name == agent)
            {
                self.backfill.completed_agents.push(agent.into());
            }
        } else {
            self.backfill.pending_agents.push(agent.into());
        }
        self.backfill.active = !self.backfill.pending_agents.is_empty();
        if complete && self.backfill.current_agent.as_deref() == Some(agent) {
            self.backfill.current_agent = None;
            self.backfill.progress = None;
        }
    }
}
