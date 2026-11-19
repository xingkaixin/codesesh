use crate::discovery::SourcePresence;
use crate::wire::{AgentScanPhase, BackfillPhase, ScanCompleteness, ScanCompletion, ScanPhase};
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_failure_count: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_failure_summary: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackgroundStatus {
    pub active: bool,
    pub pending_agents: Vec<String>,
    pub completed_agents: Vec<String>,
    pub failed_agents: Vec<String>,
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    pub partial_agents: BTreeMap<String, ScanCompletion>,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pricing_history: Option<crate::wire::PricingHistoryStatus>,
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
    #[serde(skip)]
    pending_completions: BTreeMap<String, ScanCompletion>,
}

fn merge_completion(
    existing: Option<ScanCompletion>,
    next: Option<ScanCompletion>,
) -> Option<ScanCompletion> {
    match (existing, next) {
        (None, None) => None,
        (Some(value), None) | (None, Some(value)) => Some(value),
        (Some(left), Some(right)) => {
            if left.completeness == ScanCompleteness::Partial
                || right.completeness == ScanCompleteness::Partial
            {
                let source_failure_count = [&left, &right]
                    .into_iter()
                    .filter(|batch| batch.completeness == ScanCompleteness::Partial)
                    .map(|batch| batch.source_failure_count)
                    .sum();
                let source_failure_summary =
                    left.source_failure_summary.or(right.source_failure_summary);
                Some(ScanCompletion {
                    completeness: ScanCompleteness::Partial,
                    source_failure_count,
                    source_failure_summary,
                })
            } else {
                Some(ScanCompletion {
                    completeness: ScanCompleteness::Complete,
                    source_failure_count: None,
                    source_failure_summary: None,
                })
            }
        }
    }
}

impl ScanStatus {
    pub(super) fn new(agents: impl Iterator<Item = String>) -> Self {
        let now = chrono::Utc::now().timestamp_millis();
        let names: Vec<_> = agents.collect();
        Self {
            pricing_history: None,
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
                            source_failure_count: None,
                            source_failure_summary: None,
                        },
                    )
                })
                .collect(),
            updated_at: now,
            backfill: BackgroundStatus::default(),
            pending_completions: BTreeMap::new(),
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
            self.pending_completions.remove(agent);
            self.backfill.partial_agents.remove(agent);
            let source = self.sources.entry(agent.into()).or_default();
            source.error = error.clone();
            source.complete = false;
        }
        if phase == AgentScanPhase::Scanning {
            if !self
                .backfill
                .pending_agents
                .iter()
                .any(|name| name == agent)
            {
                self.pending_completions.remove(agent);
            }
            if !self.active {
                self.agent_statuses.retain(|_, status| {
                    status.status == AgentScanPhase::Failed
                        || status.completeness == Some(ScanCompleteness::Partial)
                });
                self.started_at = Some(now);
            }
        }
        let started_at = self
            .agent_statuses
            .get(agent)
            .filter(|status| {
                status.status != AgentScanPhase::Failed && status.status != AgentScanPhase::Complete
            })
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
        let (completeness, source_failure_count, source_failure_summary) =
            if phase == AgentScanPhase::Complete {
                match self.pending_completions.remove(agent) {
                    Some(completion) if completion.completeness == ScanCompleteness::Partial => (
                        Some(ScanCompleteness::Partial),
                        completion.source_failure_count,
                        completion.source_failure_summary,
                    ),
                    _ => (Some(ScanCompleteness::Complete), None, None),
                }
            } else {
                (None, None, None)
            };
        self.agent_statuses.insert(
            agent.into(),
            AgentStatus {
                agent_name: agent.into(),
                completeness,
                source_failure_count,
                source_failure_summary,
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
        completion: Option<ScanCompletion>,
    ) {
        let merged = merge_completion(self.pending_completions.remove(agent), completion);
        let partial = merged
            .as_ref()
            .filter(|value| value.completeness == ScanCompleteness::Partial)
            .cloned();
        if let Some(merged) = merged {
            self.pending_completions.insert(agent.into(), merged);
        }
        if let Some(presence) = presence {
            self.sources
                .entry(agent.into())
                .or_default()
                .collected(presence, complete && partial.is_none());
        }
        let backfill = &mut self.backfill;
        let tracked_backfill = backfill.pending_agents.iter().any(|name| name == agent)
            || backfill.failed_agents.iter().any(|name| name == agent)
            || backfill.partial_agents.contains_key(agent);
        if complete && !tracked_backfill {
            return;
        }
        backfill.pending_agents.retain(|name| name != agent);
        backfill.completed_agents.retain(|name| name != agent);
        backfill.failed_agents.retain(|name| name != agent);
        backfill.partial_agents.remove(agent);
        if complete {
            backfill.completed_agents.push(agent.into());
            if let Some(partial) = partial {
                backfill.partial_agents.insert(agent.into(), partial);
            }
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
        status.published("codex", false, None, None, None);
        status.published("codex", true, None, None, None);
        status.published("codex", false, None, None, None);

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

    #[test]
    fn partial_completion_surfaces_wire_diagnostics_without_fabricating_counts() {
        let mut status = status();
        status.published(
            "codex",
            true,
            Some(SourcePresence::Available),
            None,
            Some(ScanCompletion {
                completeness: ScanCompleteness::Partial,
                source_failure_count: None,
                source_failure_summary: Some("truncated rollout".into()),
            }),
        );
        status.update("codex", AgentScanPhase::Complete, None, 2);
        status.update("claudecode", AgentScanPhase::Complete, None, 1);

        let codex = &status.agent_statuses["codex"];
        assert_eq!(codex.completeness, Some(ScanCompleteness::Partial));
        assert_eq!(codex.source_failure_count, None);
        assert_eq!(
            codex.source_failure_summary.as_deref(),
            Some("truncated rollout")
        );
        assert!(!status.sources["codex"].complete);
        assert!(status.backfill.partial_agents.is_empty());

        let wire: crate::wire::ScanStatusEvent =
            serde_json::from_value(serde_json::to_value(&status).unwrap()).unwrap();
        assert_eq!(
            wire.agent_statuses["codex"].completeness,
            Some(ScanCompleteness::Partial)
        );
        assert_eq!(wire.agent_statuses["codex"].source_failure_count, None);
        assert_eq!(
            wire.agent_statuses["codex"]
                .source_failure_summary
                .as_deref(),
            Some("truncated rollout")
        );
        assert!(wire.backfill.partial_agents.is_none());

        status.update("claudecode", AgentScanPhase::Scanning, None, 1);
        assert_eq!(
            status.agent_statuses["codex"].completeness,
            Some(ScanCompleteness::Partial)
        );
    }

    #[test]
    fn partial_backfill_accumulates_diagnostics_and_clears_on_clean_completion() {
        let mut status = status();
        status.published(
            "codex",
            false,
            Some(SourcePresence::Available),
            None,
            Some(ScanCompletion {
                completeness: ScanCompleteness::Partial,
                source_failure_count: Some(1.0),
                source_failure_summary: Some("first corrupt file".into()),
            }),
        );
        status.update("codex", AgentScanPhase::Scanning, None, 1);
        status.published(
            "codex",
            true,
            Some(SourcePresence::Available),
            None,
            Some(ScanCompletion {
                completeness: ScanCompleteness::Partial,
                source_failure_count: Some(2.0),
                source_failure_summary: Some("second corrupt file".into()),
            }),
        );
        status.update("codex", AgentScanPhase::Complete, None, 3);

        let expected = ScanCompletion {
            completeness: ScanCompleteness::Partial,
            source_failure_count: Some(3.0),
            source_failure_summary: Some("first corrupt file".into()),
        };
        assert_eq!(status.backfill.partial_agents.get("codex"), Some(&expected));
        assert_eq!(
            status.agent_statuses["codex"].source_failure_count,
            Some(3.0)
        );

        let wire: crate::wire::ScanStatusEvent =
            serde_json::from_value(serde_json::to_value(&status).unwrap()).unwrap();
        assert_eq!(
            wire.backfill.partial_agents.unwrap().get("codex"),
            Some(&expected)
        );

        status.update("codex", AgentScanPhase::Scanning, None, 3);
        status.published("codex", true, Some(SourcePresence::Available), None, None);
        status.update("codex", AgentScanPhase::Complete, None, 3);

        assert!(status.backfill.partial_agents.is_empty());
        assert_eq!(
            status.agent_statuses["codex"].completeness,
            Some(ScanCompleteness::Complete)
        );
        assert_eq!(status.agent_statuses["codex"].source_failure_count, None);
        assert!(status.sources["codex"].complete);
    }

    #[test]
    fn failed_backfill_clears_when_recovery_completes() {
        let mut status = status();
        status.published("codex", false, None, None, None);
        status.update("codex", AgentScanPhase::Failed, Some("io error".into()), 1);
        assert_eq!(status.backfill.failed_agents, ["codex"]);

        status.update("codex", AgentScanPhase::Scanning, None, 1);
        status.published("codex", true, Some(SourcePresence::Available), None, None);
        status.update("codex", AgentScanPhase::Complete, None, 2);

        assert!(status.backfill.failed_agents.is_empty());
        assert_eq!(status.backfill.completed_agents, ["codex"]);
        assert_eq!(
            status.agent_statuses["codex"].completeness,
            Some(ScanCompleteness::Complete)
        );
    }
}
