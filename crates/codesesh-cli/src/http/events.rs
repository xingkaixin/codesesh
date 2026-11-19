use super::{State, decorate, error};
use axum::{
    extract::State as AxumState,
    http::{HeaderValue, StatusCode},
    response::{IntoResponse, Response, Sse, sse::KeepAlive},
};
use codesesh_core::runtime;
use serde_json::json;
use std::{
    collections::HashSet,
    sync::{Arc, Mutex, MutexGuard},
    time::Duration,
};

fn lock_buffer(
    queue: &Mutex<super::event_buffer::Buffer>,
) -> MutexGuard<'_, super::event_buffer::Buffer> {
    queue.lock().unwrap_or_else(|poisoned| {
        let mut guard = poisoned.into_inner();
        guard.fail();
        guard
    })
}

pub async fn events(AxumState(state): AxumState<Arc<State>>) -> Response {
    let Ok(permit) = state.streams.clone().try_acquire_owned() else {
        let mut response = error(
            StatusCode::TOO_MANY_REQUESTS,
            "Too many active event streams",
        );
        response
            .headers_mut()
            .insert("retry-after", HeaderValue::from_static("1"));
        return response;
    };
    let mut receiver = state.runtime.subscribe();
    let Ok(initial_status) = serde_json::to_value(state.runtime.status().as_ref()) else {
        return error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Failed to serialize scan status",
        );
    };
    let mut shutdown = state.runtime.shutdown_receiver();
    let mut known: HashSet<_> = state
        .snapshot()
        .iter()
        .map(|s| s.reference.clone())
        .collect();
    let queue = Arc::new(Mutex::new(super::event_buffer::Buffer::new(permit)));
    let notify = Arc::new(tokio::sync::Notify::new());
    {
        let mut buffer = lock_buffer(&queue);
        buffer.event(
            "connected",
            &json!({"timestamp":chrono::Utc::now().timestamp_millis()}),
        );
        buffer.status(&initial_status);
    }
    let producer_queue = queue.clone();
    let producer_notify = notify.clone();
    let task = tokio::spawn(async move {
        let queue = producer_queue;
        let notify = producer_notify;
        loop {
            if *shutdown.borrow() {
                lock_buffer(&queue).close();
                notify.notify_one();
                break;
            }
            tokio::select! {
                result=shutdown.changed()=> {if result.is_err() || *shutdown.borrow() {lock_buffer(&queue).close();notify.notify_one();break;}},
                event=receiver.recv()=>match event {
                    Ok(runtime::Event::Status(status))=>match serde_json::to_value(status.as_ref()) {
                        Ok(payload)=>lock_buffer(&queue).status(&payload),
                        Err(_)=>lock_buffer(&queue).fail(),
                    },
                    Ok(runtime::Event::Sessions{changed,removed,snapshot})=> {
                        let aliases=state.aliases().await;let snapshot=super::scoped_heads(&snapshot,&state.query_scope);
                        let visible:HashSet<_>=snapshot.iter().map(|s|s.reference.clone()).collect();
                        let mut changed_agents=Vec::new();let mut new=Vec::new();let mut heads=Vec::new();
                        for head in changed.iter().filter(|h|visible.contains(&h.reference)) {
                            if !changed_agents.contains(&head.reference.agent_name) {changed_agents.push(head.reference.agent_name.clone());}
                            if !known.contains(&head.reference) {new.push(head.reference.clone());}
                            let mut head=head.public();decorate(&mut head,&aliases);heads.push(super::wire::referenced(head));
                        }
                        let removed:Vec<_>=removed.iter().filter(|r|known.contains(r)).cloned().collect();
                        for reference in &removed {if !changed_agents.contains(&reference.agent_name) {changed_agents.push(reference.agent_name.clone());}}
                        known=visible;
                        if heads.is_empty() && removed.is_empty() {continue;}
                        let changes:HashSet<_>=changed.iter().map(|s|s.reference.clone()).collect();
                        let time_key=|time:f64|if time==0.0 {0} else {time.to_bits()};
                        let times:HashSet<_>=changed.iter().map(|s|time_key(s.time_updated)).collect();
                        let parents:HashSet<_>=changed.iter().filter_map(|s|s.parent_reference.as_ref()).collect();
                        let related=snapshot.iter().filter(|h|!changes.contains(&h.reference) && (times.contains(&time_key(h.time_updated)) || h.parent_reference.as_ref().is_some_and(|p|changes.contains(p)) || parents.contains(&h.reference))).map(|s|{let mut head=s.public();decorate(&mut head,&aliases);super::wire::referenced(head)}).collect::<Result<Vec<_>,_>>();
                        let order:Vec<_>=snapshot.iter().filter(|s|times.contains(&time_key(s.time_updated))).map(|s|s.reference.clone()).collect();
                        let (Ok(heads),Ok(related))=(heads.into_iter().collect::<Result<Vec<_>,_>>(),related) else {
                            lock_buffer(&queue).fail();notify.notify_one();break;
                        };
                        let Ok(payload)=serde_json::to_value(codesesh_core::wire::SessionsUpdatedEvent {
                            r#type:codesesh_core::wire::SessionsUpdatedEventType::SessionsUpdated,
                            changed_agents,new_session_refs:new,total_sessions:snapshot.len() as f64,
                            timestamp:chrono::Utc::now().timestamp_millis() as f64,
                            changed_session_heads:heads,projection_related_session_heads:Some(related),
                            projection_session_order:Some(order),removed_session_refs:removed,
                        }) else {
                            lock_buffer(&queue).fail();notify.notify_one();break;
                        };
                        lock_buffer(&queue).event("sessions-updated",&payload);
                    },
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_))=>lock_buffer(&queue).fail(),
                    Err(tokio::sync::broadcast::error::RecvError::Closed)=>lock_buffer(&queue).close(),
                }
            }
            notify.notify_one();
            if lock_buffer(&queue).closed {
                break;
            }
        }
    });
    let guard = Connection {
        task,
        queue: queue.clone(),
    };
    let stream = async_stream::stream! {
        let _guard=guard;
        loop {
            let notified=notify.notified();
            let (event,closed,overflow)={let mut queue=lock_buffer(&queue);(queue.pop(),queue.closed,queue.overflow)};
            if let Some(event)=event {yield Ok::<_,std::io::Error>(event);continue;}
            if overflow {yield Err(std::io::Error::other("SSE client fell behind"));break;}
            if closed {break;}
            notified.await;
        }
    };
    Sse::new(stream)
        .keep_alive(
            KeepAlive::new()
                .interval(Duration::from_secs(15))
                .text("keepalive"),
        )
        .into_response()
}

struct Connection {
    task: tokio::task::JoinHandle<()>,
    queue: Arc<Mutex<super::event_buffer::Buffer>>,
}
impl Drop for Connection {
    fn drop(&mut self) {
        lock_buffer(&self.queue).close();
        self.task.abort();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::sync::Semaphore;

    #[tokio::test]
    async fn poisoned_event_buffer_closes_and_releases_permit_on_drop() {
        let streams = Arc::new(Semaphore::new(1));
        let permit = streams.clone().try_acquire_owned().unwrap();
        let queue = Arc::new(Mutex::new(super::super::event_buffer::Buffer::new(permit)));
        let poisoned_queue = queue.clone();
        let _ = std::thread::spawn(move || {
            let _guard = poisoned_queue.lock().unwrap();
            panic!("simulated buffer panic");
        })
        .join();
        assert!(queue.is_poisoned());

        let task = tokio::spawn(std::future::pending::<()>());
        let connection = Connection {
            task,
            queue: queue.clone(),
        };
        drop(connection);

        assert_eq!(streams.available_permits(), 1);
        let guard = lock_buffer(&queue);
        assert!(guard.closed);
        assert!(guard.overflow);
    }
}
