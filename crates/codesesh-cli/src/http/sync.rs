use super::{State, error, retry};
use axum::{
    Json,
    extract::{Path, State as AxumState},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};
use codesesh_core::sync::{
    PAYLOAD_VERSION, PROTOCOL_VERSION, Upload, WorkerHello, check_compatibility,
};
use serde::Deserialize;
use serde_json::json;
use std::sync::Arc;

const MINIMUM_WORKER_VERSION: &str = "1.1.1";

fn compatibility(version: &str, protocol: u32, payload: u32) -> Option<Response> {
    check_compatibility(version,env!("CARGO_PKG_VERSION"),MINIMUM_WORKER_VERSION,protocol,payload).err().map(|reason| (StatusCode::CONFLICT,Json(json!({"error":reason,"hubVersion":env!("CARGO_PKG_VERSION"),"minimumWorkerVersion":MINIMUM_WORKER_VERSION}))).into_response())
}

async fn authenticate(state: &State, headers: &HeaderMap) -> Result<String, Response> {
    let credential = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .filter(|v| v.len() == 64)
        .ok_or_else(|| error(StatusCode::UNAUTHORIZED, "Worker credential required"))?
        .to_owned();
    state
        .runtime
        .hub_control(move |cache| cache.authenticate_worker(&credential))
        .await
        .map_err(|failure| {
            if failure.is::<codesesh_core::runtime::ReadBusy>() {
                retry("Hub is busy")
            } else {
                error(
                    StatusCode::UNAUTHORIZED,
                    "Worker credential is invalid or revoked",
                )
            }
        })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Pair {
    token: String,
    name: String,
    hello: WorkerHello,
}

pub async fn pair(AxumState(state): AxumState<Arc<State>>, Json(request): Json<Pair>) -> Response {
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
            cache.pair_worker(
                &request.token,
                &request.name,
                &request.hello.version,
                &request.hello.stream_id,
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
    let node = match authenticate(&state, &headers).await {
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
    let node = match authenticate(&state, &headers).await {
        Ok(node) => node,
        Err(response) => return response,
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
    match state.runtime.hub_control(|cache|cache.nodes()).await {
        Ok(nodes)=>Json(json!({"nodes":nodes,"protocolVersion":PROTOCOL_VERSION,"payloadVersion":PAYLOAD_VERSION})).into_response(),
        Err(_)=>retry("Node state is temporarily unavailable"),
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
