use super::{State, error, retry};
use axum::{
    Json,
    extract::{Path, State as AxumState},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};
use codesesh_core::sync::{PAYLOAD_VERSION, Upload, WorkerHello, check_compatibility};
use serde::Deserialize;
use serde_json::json;
use std::sync::Arc;

const MINIMUM_WORKER_VERSION: &str = "1.1.1";

fn compatibility(version: &str, protocol: u32, payload: u32) -> Option<Response> {
    check_compatibility(version,env!("CARGO_PKG_VERSION"),MINIMUM_WORKER_VERSION,protocol,payload).err().map(|reason| (StatusCode::CONFLICT,Json(json!({"error":reason,"hubVersion":env!("CARGO_PKG_VERSION"),"minimumWorkerVersion":MINIMUM_WORKER_VERSION}))).into_response())
}

enum InstanceLease {
    Claim,
    Release,
}

async fn authenticate(
    state: &State,
    headers: &HeaderMap,
    lease: InstanceLease,
) -> Result<String, Response> {
    let credential = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .filter(|v| v.len() == 64)
        .ok_or_else(|| error(StatusCode::UNAUTHORIZED, "Worker credential required"))?
        .to_owned();
    let instance = headers
        .get("x-codesesh-worker-instance")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .to_owned();
    state
        .runtime
        .hub_control(move |cache| {
            let node = cache.authenticate_worker(&credential)?;
            match lease {
                InstanceLease::Claim => cache.claim_worker_instance(&node, &instance)?,
                InstanceLease::Release => cache.release_worker_instance(&node, &instance)?,
            }
            Ok(node)
        })
        .await
        .map_err(|failure| {
            if failure.is::<codesesh_core::runtime::ReadBusy>() {
                retry("Hub is busy")
            } else if failure.to_string().starts_with("WORKER_INSTANCE_CONFLICT") {
                error(StatusCode::CONFLICT, &failure.to_string())
            } else {
                error(
                    StatusCode::UNAUTHORIZED,
                    "Worker credential or instance is invalid or revoked",
                )
            }
        })
}

pub async fn goodbye(AxumState(state): AxumState<Arc<State>>, headers: HeaderMap) -> Response {
    match authenticate(&state, &headers, InstanceLease::Release).await {
        Ok(_) => StatusCode::NO_CONTENT.into_response(),
        Err(response) => response,
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Pair {
    token: String,
    name: String,
    hello: WorkerHello,
}

pub async fn pair(
    AxumState(state): AxumState<Arc<State>>,
    headers: HeaderMap,
    Json(request): Json<Pair>,
) -> Response {
    let local_hub_id = headers
        .get("x-codesesh-local-hub-id")
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned);
    let local_proof = headers
        .get("x-codesesh-local-proof")
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned);
    if local_proof.is_some() != local_hub_id.is_some() {
        return error(StatusCode::BAD_REQUEST, "Incomplete local Worker proof");
    }
    if let Some(response) = compatibility(
        &request.hello.version,
        request.hello.protocol_version,
        request.hello.payload_version,
    ) {
        return response;
    }
    match state
        .runtime
        .hub_control(move |cache| {
            cache.pair_worker_with_origin(
                &request.token,
                &request.name,
                &request.hello.version,
                &request.hello.stream_id,
                local_hub_id.as_deref().zip(local_proof.as_deref()),
            )
        })
        .await
    {
        Ok(grant) => Json(grant).into_response(),
        Err(failure) if failure.is::<codesesh_core::runtime::ReadBusy>() => retry("Hub is busy"),
        Err(_) => error(
            StatusCode::UNAUTHORIZED,
            "Pairing failed: token expired, already used, or request invalid",
        ),
    }
}

pub async fn hello(
    AxumState(state): AxumState<Arc<State>>,
    headers: HeaderMap,
    Json(request): Json<WorkerHello>,
) -> Response {
    let node = match authenticate(&state, &headers, InstanceLease::Claim).await {
        Ok(node) => node,
        Err(response) => return response,
    };
    match state
        .runtime
        .hub_control(move |cache| cache.worker_hello(&node, &request, MINIMUM_WORKER_VERSION))
        .await
    {
        Ok(hello) => Json(hello).into_response(),
        Err(failure) if failure.is::<codesesh_core::runtime::ReadBusy>() => retry("Hub is busy"),
        Err(failure) => error(StatusCode::CONFLICT, &failure.to_string()),
    }
}

pub async fn upload(
    AxumState(state): AxumState<Arc<State>>,
    headers: HeaderMap,
    Json(request): Json<Upload>,
) -> Response {
    let version = headers
        .get("x-codesesh-worker-version")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let protocol = headers
        .get("x-codesesh-protocol-version")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);
    if let Some(response) = compatibility(version, protocol, request.payload_version) {
        return response;
    }
    let node = match authenticate(&state, &headers, InstanceLease::Claim).await {
        Ok(node) => node,
        Err(response) => return response,
    };
    let Ok(_global) = state.upload_slots.clone().try_acquire_owned() else {
        return retry("Hub upload capacity is busy");
    };
    let node_slot = match state.node_uploads.lock() {
        Ok(mut slots) => slots
            .entry(node.clone())
            .or_insert_with(|| Arc::new(tokio::sync::Semaphore::new(1)))
            .clone(),
        Err(_) => return retry("Node upload state is unavailable"),
    };
    let Ok(_node) = node_slot.try_acquire_owned() else {
        return retry("This node already has an upload in flight");
    };
    let pricing = match state.pricing.snapshot() {
        Ok(pricing) => pricing,
        Err(_) => return retry("Pricing is temporarily unavailable"),
    };
    match state.runtime.receive_upload(node, request, pricing).await {
        Ok(receipt) => Json(receipt).into_response(),
        Err(failure) if failure.is::<codesesh_core::runtime::ReadBusy>() => retry("Hub is busy"),
        Err(failure) => error(StatusCode::CONFLICT, &failure.to_string()),
    }
}

pub async fn nodes(AxumState(state): AxumState<Arc<State>>) -> Response {
    if !state.hub_enabled {
        return error(StatusCode::NOT_FOUND, "Hub mode is not enabled");
    }
    let local_sessions = state
        .runtime
        .snapshot()
        .iter()
        .filter(|head| head.reference.source_node_id == "local")
        .count();
    let enabled = !state.runtime.status().agent_statuses.is_empty();
    let local = (enabled || local_sessions > 0).then_some(codesesh_core::sync::LocalNode {
        enabled,
        sessions: local_sessions,
    });
    match state
        .runtime
        .hub_control(|cache| Ok((cache.nodes()?, cache.rescan_tasks()?)))
        .await
    {
        Ok((nodes, tasks)) => Json(codesesh_core::sync::HubNodes {
            local: local.filter(|_| !nodes.iter().any(|node| node.id == "local")),
            nodes,
            tasks,
            version: env!("CARGO_PKG_VERSION").into(),
            minimum_worker_version: MINIMUM_WORKER_VERSION.into(),
        })
        .into_response(),
        Err(_) => retry("Node state is temporarily unavailable"),
    }
}

pub async fn pairing_token(AxumState(state): AxumState<Arc<State>>) -> Response {
    if !state.hub_enabled {
        return error(StatusCode::NOT_FOUND, "Hub mode is not enabled");
    }
    match state
        .runtime
        .hub_control(|cache| cache.create_pairing_token())
        .await
    {
        Ok(token) => Json(json!({"token":token,"expiresInSeconds":600})).into_response(),
        Err(_) => retry("Pairing is temporarily unavailable"),
    }
}

pub async fn revoke(AxumState(state): AxumState<Arc<State>>, Path(node): Path<String>) -> Response {
    if !state.hub_enabled {
        return error(StatusCode::NOT_FOUND, "Hub mode is not enabled");
    }
    match state
        .runtime
        .hub_control(move |cache| cache.revoke_worker(&node))
        .await
    {
        Ok(()) => Json(json!({"revoked":true})).into_response(),
        Err(failure) if failure.is::<codesesh_core::runtime::ReadBusy>() => retry("Hub is busy"),
        Err(_) => error(StatusCode::NOT_FOUND, "Unknown node"),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Rescan {
    #[serde(default)]
    node_ids: Vec<String>,
    #[serde(default)]
    agents: Vec<String>,
}

pub async fn rescan(
    AxumState(state): AxumState<Arc<State>>,
    Json(request): Json<Rescan>,
) -> Response {
    if !state.hub_enabled {
        return error(StatusCode::NOT_FOUND, "Hub mode is not enabled");
    }
    match state
        .runtime
        .hub_control(move |cache| {
            cache.request_rescan(&request.node_ids, &request.agents, "manual")
        })
        .await
    {
        Ok(tasks) => Json(json!({"tasks":tasks})).into_response(),
        Err(failure) if failure.is::<codesesh_core::runtime::ReadBusy>() => retry("Hub is busy"),
        Err(failure) => error(StatusCode::BAD_REQUEST, &failure.to_string()),
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Rename {
    name: String,
}

pub async fn rename(
    AxumState(state): AxumState<Arc<State>>,
    Path(node): Path<String>,
    Json(request): Json<Rename>,
) -> Response {
    if !state.hub_enabled {
        return error(StatusCode::NOT_FOUND, "Hub mode is not enabled");
    }
    match state
        .runtime
        .hub_control(move |cache| cache.rename_worker(&node, &request.name))
        .await
    {
        Ok(()) => Json(json!({"renamed":true})).into_response(),
        Err(failure) if failure.is::<codesesh_core::runtime::ReadBusy>() => retry("Hub is busy"),
        Err(failure) => error(StatusCode::BAD_REQUEST, &failure.to_string()),
    }
}

pub async fn recover(
    AxumState(state): AxumState<Arc<State>>,
    headers: HeaderMap,
    Json(request): Json<codesesh_core::sync::Recovery>,
) -> Response {
    let version = headers
        .get("x-codesesh-worker-version")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let protocol = headers
        .get("x-codesesh-protocol-version")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);
    if let Some(response) = compatibility(version, protocol, PAYLOAD_VERSION) {
        return response;
    }
    let node = match authenticate(&state, &headers, InstanceLease::Claim).await {
        Ok(node) => node,
        Err(response) => return response,
    };
    match state
        .runtime
        .hub_control(move |cache| cache.recover_worker(&node, &request))
        .await
    {
        Ok(()) => Json(json!({"recovered":true})).into_response(),
        Err(failure) if failure.is::<codesesh_core::runtime::ReadBusy>() => retry("Hub is busy"),
        Err(failure) => error(StatusCode::CONFLICT, &failure.to_string()),
    }
}
