use axum::response::sse::Event;
use serde_json::{Value, json};
use std::collections::VecDeque;
use tokio::sync::OwnedSemaphorePermit;

struct Frame {
    event: Event,
    critical: bool,
}
pub struct Buffer {
    frames: VecDeque<Frame>,
    replaceable: bool,
    last_milestone: Option<Value>,
    critical: usize,
    pub closed: bool,
    pub overflow: bool,
    permit: Option<OwnedSemaphorePermit>,
}
impl Buffer {
    pub fn new(permit: OwnedSemaphorePermit) -> Self {
        Self {
            frames: VecDeque::new(),
            replaceable: false,
            last_milestone: None,
            critical: 0,
            closed: false,
            overflow: false,
            permit: Some(permit),
        }
    }
    pub fn event(&mut self, name: &str, data: &Value) {
        if self.freeze() {
            self.append(name, data, true);
        }
    }
    pub fn status(&mut self, data: &Value) {
        if self.closed {
            return;
        }
        let milestone = milestone(data);
        if self.last_milestone.as_ref() != Some(&milestone) {
            if !self.freeze() {
                return;
            }
            self.last_milestone = Some(milestone);
            self.append("scan-status", data, true);
        } else if self.replaceable {
            self.frames.back_mut().unwrap().event = frame("scan-status", data);
        } else {
            self.append("scan-status", data, false);
            self.replaceable = true;
        }
    }
    fn append(&mut self, name: &str, data: &Value, critical: bool) {
        if self.closed {
            return;
        }
        if critical && self.critical >= 64 {
            self.fail();
            return;
        }
        self.frames.push_back(Frame {
            event: frame(name, data),
            critical,
        });
        self.critical += usize::from(critical);
    }
    fn freeze(&mut self) -> bool {
        if self.replaceable {
            if self.critical >= 64 {
                self.fail();
                return false;
            }
            self.frames.back_mut().unwrap().critical = true;
            self.critical += 1;
            self.replaceable = false;
        }
        !self.closed
    }
    pub fn pop(&mut self) -> Option<Event> {
        let frame = self.frames.pop_front()?;
        self.critical -= usize::from(frame.critical);
        if self.frames.is_empty() {
            self.replaceable = false;
        }
        Some(frame.event)
    }
    pub fn fail(&mut self) {
        self.close();
        self.overflow = true;
    }
    pub fn close(&mut self) {
        self.frames.clear();
        self.replaceable = false;
        self.critical = 0;
        self.closed = true;
        self.permit.take();
    }
}
fn frame(name: &str, data: &Value) -> Event {
    Event::default().event(name).data(data.to_string())
}
fn milestone(status: &Value) -> Value {
    let sorted = |value: &Value, fields: &[&str]| {
        let mut entries: Vec<_> = value
            .as_object()
            .into_iter()
            .flat_map(|m| m.iter())
            .collect();
        entries.sort_by(|(a, _), (b, _)| codesesh_core::locale::compare(a, b));
        entries
            .into_iter()
            .map(|(name, value)| {
                let mut entry = vec![json!(name)];
                entry.extend(fields.iter().map(|field| value[*field].clone()));
                Value::Array(entry)
            })
            .collect::<Vec<_>>()
    };
    json!([
        status["active"],
        status["phase"],
        status["totalAgents"],
        status["pendingAgents"],
        status["scanningAgents"],
        status["completedAgents"],
        sorted(
            &status["agentStatuses"],
            &[
                "status",
                "error",
                "completeness",
                "sourceFailureCount",
                "sourceFailureSummary"
            ]
        ),
        status["backfill"]["active"],
        status["backfill"]["currentAgent"],
        status["backfill"]["pendingAgents"],
        status["backfill"]["completedAgents"],
        status["backfill"]["failedAgents"],
        status["backfill"]["progress"]["phase"],
        sorted(
            &status["backfill"]["partialAgents"],
            &["completeness", "sourceFailureCount", "sourceFailureSummary"]
        )
    ])
}
