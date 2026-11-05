use crate::discovery::SourcePresence;
use crate::wire::{AgentScanPhase, BackfillPhase, ScanCompleteness, ScanPhase};
use serde::Serialize;
use std::collections::BTreeMap;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentStatus {
    pub agent_name: String,
    pub status: AgentScanPhase,
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
    pub completeness: Option<ScanCompleteness>,
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
    pub phase: BackfillPhase,
    pub processed: usize,
    pub total: usize,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanStatus {
    pub sources: BTreeMap<String, crate::discovery::AgentCollectionStatus>,
    #[serde(rename = "type")]
    pub kind: &'static str,
    pub phase: ScanPhase,
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
            sources: names
                .iter()
                .map(|name| (name.clone(), Default::default()))
                .collect(),
            kind: "scan-status",
            phase: if names.is_empty() {
                ScanPhase::Idle
            } else {
                ScanPhase::Initializing
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
                            status: AgentScanPhase::Pending,
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
        phase: AgentScanPhase,
        error: Option<String>,
        count: usize,
    ) {
        let now = chrono::Utc::now().timestamp_millis();
        if phase == AgentScanPhase::Failed {
            let source = self.sources.entry(agent.into()).or_default();
            source.error = error.clone();
            source.complete = false;
        }
        if phase == AgentScanPhase::Scanning && !self.active {
            self.agent_statuses
                .retain(|_, status| status.status == AgentScanPhase::Failed);
            self.started_at = Some(now);
        }
        let started_at = self
            .agent_statuses
            .get(agent)
            .filter(|status| status.status != AgentScanPhase::Failed)
            .and_then(|status| status.started_at)
            .unwrap_or(now);
        let total = if phase == AgentScanPhase::Complete {
            Some(count)
        } else {
            self.agent_statuses
                .get(agent)
                .and_then(|status| status.total)
        };
        let completed_at =
            matches!(phase, AgentScanPhase::Complete | AgentScanPhase::Failed).then_some(now);
        if phase == AgentScanPhase::Failed
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
                completeness: (phase == AgentScanPhase::Complete)
                    .then_some(ScanCompleteness::Complete),
                status: phase,
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
            match status.status {
                AgentScanPhase::Pending => self.pending_agents.push(name.clone()),
                AgentScanPhase::Complete => self.completed_agents.push(name.clone()),
                AgentScanPhase::Failed => (),
                _ => self.scanning_agents.push(name.clone()),
            }
        }
        self.active = !self.pending_agents.is_empty() || !self.scanning_agents.is_empty();
        self.phase = if !self.active {
            ScanPhase::Idle
        } else if self
            .scanning_agents
            .iter()
            .all(|name| self.agent_statuses[name].status == AgentScanPhase::Publishing)
            && self.pending_agents.is_empty()
        {
            ScanPhase::Publishing
        } else {
            ScanPhase::Scanning
        };
        self.updated_at = now;
        self.completed_at = (!self.active).then_some(now);
        self.total_agents = self.agent_statuses.len();
    }

    pub(super) fn published(
        &mut self,
        agent: &str,
        complete: bool,
        presence: Option<SourcePresence>,
        progress: Option<ScanProgress>,
    ) {
        if let Some(presence) = presence {
            self.sources
                .entry(agent.into())
                .or_default()
                .collected(presence, complete);
        }
        let backfill = &mut self.backfill;
        if complete && !backfill.pending_agents.iter().any(|name| name == agent) {
            return;
        }
        backfill.pending_agents.retain(|name| name != agent);
        backfill.completed_agents.retain(|name| name != agent);
        backfill.failed_agents.retain(|name| name != agent);
        if complete {
            backfill.completed_agents.push(agent.into());
            if backfill.current_agent.as_deref() == Some(agent) {
                backfill.current_agent = None;
                backfill.progress = None;
            }
        } else {
            backfill.pending_agents.push(agent.into());
            if progress.is_some() {
                backfill.current_agent = Some(agent.into());
                backfill.progress = progress;
            }
        }
        backfill.active = !backfill.pending_agents.is_empty();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn status() -> ScanStatus {
        ScanStatus::new(["codex".to_owned(), "claudecode".to_owned()].into_iter())
    }

    #[test]
    fn incomplete_batch_after_backfill_completion_moves_agent_back_to_pending() {
        let mut status = status();
        status.published("codex", false, None, None);
        status.published("codex", true, None, None);
        status.published("codex", false, None, None);

        assert_eq!(status.backfill.pending_agents, ["codex"]);
        assert!(status.backfill.completed_agents.is_empty());
        assert!(status.backfill.active);
    }

    #[test]
    fn failure_survives_a_new_round_started_by_another_agent() {
        let mut status = status();
        status.update("codex", AgentScanPhase::Failed, Some("broken".into()), 0);
        status.update("claudecode", AgentScanPhase::Complete, None, 0);
        assert!(!status.active);

        status.update("claudecode", AgentScanPhase::Scanning, None, 0);

        assert_eq!(
            status.agent_statuses["codex"].status,
            AgentScanPhase::Failed
        );
        assert_eq!(
            status.agent_statuses["codex"].error.as_deref(),
            Some("broken")
        );
        assert_eq!(status.sources["codex"].error.as_deref(), Some("broken"));
    }
}
