use super::{State, decorate, error};
use axum::{
    extract::State as AxumState,
    http::StatusCode,
    response::{IntoResponse, Response, Sse, sse::KeepAlive},
};
use codesesh_core::runtime;
use serde_json::json;
use std::{collections::HashSet, sync::Arc, time::Duration};

pub async fn events(AxumState(state): AxumState<Arc<State>>) -> Response {
    let Ok(permit) = state.streams.clone().try_acquire_owned() else {
        let mut response = error(
            StatusCode::TOO_MANY_REQUESTS,
            "Too many active event streams",
        );
        response
            .headers_mut()
            .insert("retry-after", "1".parse().unwrap());
        return response;
    };
    let mut receiver = state.runtime.subscribe();
    let mut shutdown = state.runtime.shutdown_receiver();
    let mut known: HashSet<_> = state
        .snapshot()
        .iter()
        .map(|s| s.reference.clone())
        .collect();
    let queue = Arc::new(std::sync::Mutex::new(super::event_buffer::Buffer::new(
        permit,
    )));
    let notify = Arc::new(tokio::sync::Notify::new());
    {
        let mut buffer = queue.lock().unwrap();
        buffer.event(
            "connected",
            &json!({"timestamp":chrono::Utc::now().timestamp_millis()}),
        );
        buffer.status(&serde_json::to_value(state.runtime.status().as_ref()).unwrap());
    }
    let producer_queue = queue.clone();
    let producer_notify = notify.clone();
    let task = tokio::spawn(async move {
        let queue = producer_queue;
        let notify = producer_notify;
        loop {
            if *shutdown.borrow() {
                queue.lock().unwrap().close();
                notify.notify_one();
                break;
            }
            tokio::select! {
                result=shutdown.changed()=> {if result.is_err() || *shutdown.borrow() {queue.lock().unwrap().close();notify.notify_one();break;}},
                event=receiver.recv()=>match event {
                    Ok(runtime::Event::Status(status))=>queue.lock().unwrap().status(&serde_json::to_value(status.as_ref()).unwrap()),
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
                            queue.lock().unwrap().fail();notify.notify_one();break;
                        };
                        let payload=serde_json::to_value(codesesh_core::public_contract::SessionsUpdatedEvent {
                            r#type:codesesh_core::public_contract::SessionsUpdatedEventType::SessionsUpdated,
                            changed_agents,new_session_refs:new,total_sessions:snapshot.len() as f64,
                            timestamp:chrono::Utc::now().timestamp_millis() as f64,
                            changed_session_heads:heads,projection_related_session_heads:Some(related),
                            projection_session_order:Some(order),removed_session_refs:removed,
                        }).unwrap();
                        queue.lock().unwrap().event("sessions-updated",&payload);
                    },
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_))=>queue.lock().unwrap().fail(),
                    Err(tokio::sync::broadcast::error::RecvError::Closed)=>queue.lock().unwrap().close(),
                }
            }
            notify.notify_one();
            if queue.lock().unwrap().closed {
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
            let (event,closed,overflow)={let mut queue=queue.lock().unwrap();(queue.pop(),queue.closed,queue.overflow)};
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
    queue: Arc<std::sync::Mutex<super::event_buffer::Buffer>>,
}
impl Drop for Connection {
    fn drop(&mut self) {
        self.queue.lock().unwrap().close();
        self.task.abort();
    }
}
