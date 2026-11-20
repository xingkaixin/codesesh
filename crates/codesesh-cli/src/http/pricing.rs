use super::{
    State,
    catalog::{
        ANALYTICS_REVISION_QUERY, DashboardWindow, cached_catalog, resolve_dashboard_window,
    },
    error, etag,
    params::Params,
};
use axum::{
    Json,
    body::Bytes,
    extract::{RawQuery, State as AxumState},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};
use codesesh_core::{
    pricing::{PricingController, PricingSnapshot, normalize_override_model_key},
    state::{StateStore, UpsertModelPriceOverride},
    wire::{
        PricingModelActionRequest, PricingOverrideKind, PricingOverridesResponse,
        PricingRatePerMillion, PricingRefreshResponse, UnmatchedModelsResponse,
        UpsertPricingOverrideRequest,
    },
};
use serde::de::DeserializeOwned;
use serde_json::json;
use std::{borrow::Cow, sync::Arc};

const MAX_RATE_PER_MILLION: f64 = 1_000_000.0;

struct ApiError(StatusCode, Cow<'static, str>);

impl ApiError {
    fn static_msg(status: StatusCode, message: &'static str) -> Self {
        Self(status, Cow::Borrowed(message))
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        error(self.0, &self.1)
    }
}

fn parse_window(raw: Option<&str>, options: &super::Options) -> Result<DashboardWindow, ApiError> {
    let query = Params::new(raw);
    resolve_dashboard_window(&query, options)
        .map_err(|message| ApiError(StatusCode::BAD_REQUEST, Cow::Owned(message)))
}

fn parse_body<T: DeserializeOwned>(bytes: &[u8]) -> Result<T, ApiError> {
    serde_json::from_slice(bytes)
        .map_err(|_| ApiError::static_msg(StatusCode::BAD_REQUEST, "Invalid pricing payload"))
}

fn valid_rates(rates: &PricingRatePerMillion) -> bool {
    [
        rates.input,
        rates.output,
        rates.cache_read,
        rates.cache_write,
    ]
    .into_iter()
    .all(|value| value.is_finite() && (0.0..=MAX_RATE_PER_MILLION).contains(&value))
}

async fn ensure_saved_available(state: &State) -> Result<(), ApiError> {
    let saved = state.saved.clone();
    let available = tokio::task::spawn_blocking(move || {
        saved
            .lock()
            .map(|guard| guard.is_some())
            .map_err(|_| anyhow::anyhow!("state lock poisoned"))
    })
    .await;
    match available {
        Ok(Ok(true)) => Ok(()),
        Ok(Ok(false)) => Err(ApiError::static_msg(
            StatusCode::SERVICE_UNAVAILABLE,
            "Pricing override storage is unavailable",
        )),
        _ => Err(ApiError::static_msg(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Failed to access pricing override storage",
        )),
    }
}

async fn with_saved_write<T: Send + 'static>(
    state: &State,
    failure_message: &'static str,
    f: impl FnOnce(&mut StateStore) -> anyhow::Result<Result<T, ApiError>> + Send + 'static,
) -> Result<T, ApiError> {
    let saved = state.saved.clone();
    let result = tokio::task::spawn_blocking(move || {
        let mut guard = saved
            .lock()
            .map_err(|_| anyhow::anyhow!("state lock poisoned"))?;
        let Some(store) = guard.as_mut() else {
            return Ok(Err(ApiError::static_msg(
                StatusCode::SERVICE_UNAVAILABLE,
                "Pricing override storage is unavailable",
            )));
        };
        f(store)
    })
    .await;
    match result {
        Ok(Ok(inner)) => inner,
        _ => Err(ApiError::static_msg(
            StatusCode::INTERNAL_SERVER_ERROR,
            failure_message,
        )),
    }
}

async fn load_overrides(state: &State) -> Result<PricingOverridesResponse, ApiError> {
    let saved = state.saved.clone();
    let pricing = state.pricing.clone();
    let result = tokio::task::spawn_blocking(move || -> anyhow::Result<_> {
        let records = {
            let guard = saved
                .lock()
                .map_err(|_| anyhow::anyhow!("state lock poisoned"))?;
            match guard.as_ref() {
                Some(store) => store.list_model_price_overrides()?,
                None => Vec::new(),
            }
        };
        let snapshot = pricing.snapshot()?;
        Ok(PricingOverridesResponse {
            overrides: snapshot.pricing.describe_overrides(&records),
        })
    })
    .await;
    match result {
        Ok(Ok(response)) => Ok(response),
        _ => Err(ApiError::static_msg(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Failed to load pricing overrides",
        )),
    }
}

enum UnmatchedLookup {
    NotModified {
        etag: String,
    },
    Loaded {
        value: UnmatchedModelsResponse,
        etag: String,
    },
}

async fn load_unmatched(
    state: &State,
    headers: HeaderMap,
    from: Option<f64>,
    to: Option<f64>,
) -> Result<UnmatchedLookup, ApiError> {
    let failure = || {
        ApiError::static_msg(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Failed to load unmatched models",
        )
    };
    let snapshot = state.pricing.snapshot().map_err(|_| failure())?;
    let cache = state.pricing_unmatched_cache.clone();
    let query_scope = state.query_scope.clone();
    let etag_namespace = state.etag_namespace;
    state
        .runtime
        .read(move |conn| {
            let revision =
                conn.query_row(ANALYTICS_REVISION_QUERY, [], |row| row.get::<_, i64>(0))?;
            let generation = snapshot.generation();
            let tag = etag::weak_etag(
                etag_namespace,
                &json!(["pricing-unmatched", revision, generation, from, to]),
            );
            if etag::matches_if_none_match(&headers, &tag) {
                return Ok(UnmatchedLookup::NotModified { etag: tag });
            }
            let key = json!(["pricing-unmatched", generation, from, to]);
            let value = cached_catalog(&cache, revision, key, || {
                Ok(UnmatchedModelsResponse {
                    unmatched_models: codesesh_core::query_unmatched_models(
                        conn,
                        &query_scope,
                        from,
                        to,
                        &snapshot.pricing,
                    )?,
                })
            })?;
            Ok(UnmatchedLookup::Loaded { value, etag: tag })
        })
        .await
        .map_err(|_| failure())
}

fn replace_overrides(
    pricing: &PricingController,
    store: &StateStore,
) -> anyhow::Result<(PricingSnapshot, PricingOverridesResponse)> {
    let records = store.list_model_price_overrides()?;
    let new_snapshot = pricing.replace_overrides(records.clone())?;
    let response = PricingOverridesResponse {
        overrides: new_snapshot.pricing.describe_overrides(&records),
    };
    Ok((new_snapshot, response))
}

pub async fn refresh(AxumState(state): AxumState<Arc<State>>) -> Response {
    let result = tokio::spawn(async move {
        crate::pricing_refresh::refresh_once(
            &state.pricing,
            &state.runtime,
            codesesh_core::pricing::MODELS_DEV_URL,
            true,
        )
        .await
    })
    .await;
    match result {
        Ok(Ok(changed)) => Json(PricingRefreshResponse { changed }).into_response(),
        Ok(Err(_)) => error(StatusCode::BAD_GATEWAY, "Could not refresh model prices"),
        Err(_) => error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Pricing refresh task failed",
        ),
    }
}

pub async fn overrides(AxumState(state): AxumState<Arc<State>>) -> Response {
    load_overrides(&state).await.map(Json).into_response()
}

pub async fn unmatched(
    AxumState(state): AxumState<Arc<State>>,
    RawQuery(raw): RawQuery,
    headers: HeaderMap,
) -> Response {
    match async {
        let window = parse_window(raw.as_deref(), &state.options)?;
        load_unmatched(&state, headers, window.from, window.base_to).await
    }
    .await
    {
        Ok(UnmatchedLookup::NotModified { etag: tag }) => etag::not_modified(&tag),
        Ok(UnmatchedLookup::Loaded { value, etag: tag }) => {
            let mut response = Json(value).into_response();
            etag::apply_headers(&mut response, &tag);
            response
        }
        Err(error) => error.into_response(),
    }
}

pub async fn models(AxumState(state): AxumState<Arc<State>>, RawQuery(raw): RawQuery) -> Response {
    async {
        let query = Params::new(raw.as_deref());
        let limit = query
            .limit(50, 200)
            .map_err(|message| ApiError(StatusCode::BAD_REQUEST, Cow::Owned(message)))?;
        let snapshot = state.pricing.snapshot().map_err(|_| {
            ApiError::static_msg(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Failed to load official models",
            )
        })?;
        Ok::<_, ApiError>(Json(
            snapshot
                .pricing
                .list_official_models(query.optional("q"), limit),
        ))
    }
    .await
    .into_response()
}

pub async fn put_override(AxumState(state): AxumState<Arc<State>>, bytes: Bytes) -> Response {
    async {
        let _guard = state.pricing_write_lock.lock().await;
        ensure_saved_available(&state).await?;
        let body: UpsertPricingOverrideRequest = parse_body(&bytes)?;
        let model_key = normalize_override_model_key(&body.model).ok_or_else(|| {
            ApiError::static_msg(StatusCode::BAD_REQUEST, "Invalid override model")
        })?;
        let snapshot = state.pricing.snapshot().map_err(|_| {
            ApiError::static_msg(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Failed to load pricing snapshot",
            )
        })?;
        let (target_model, rates) = match body.kind {
            PricingOverrideKind::Remap => {
                let target = body
                    .target_model
                    .as_deref()
                    .and_then(normalize_override_model_key)
                    .ok_or_else(|| {
                        ApiError::static_msg(
                            StatusCode::BAD_REQUEST,
                            "Remap pricing override requires a valid target model",
                        )
                    })?;
                if snapshot
                    .pricing
                    .official_price_hash_and_json(&target)
                    .is_none()
                {
                    return Err(ApiError::static_msg(
                        StatusCode::BAD_REQUEST,
                        "Target model does not have official pricing",
                    ));
                }
                (Some(target), None)
            }
            PricingOverrideKind::Manual => {
                let rates = body.rates.ok_or_else(|| {
                    ApiError::static_msg(
                        StatusCode::BAD_REQUEST,
                        "Manual pricing override requires rates",
                    )
                })?;
                if !valid_rates(&rates) {
                    return Err(ApiError::static_msg(
                        StatusCode::BAD_REQUEST,
                        "Pricing rates must be finite and between 0 and 1000000",
                    ));
                }
                (None, Some(rates))
            }
        };
        let official_for_model = snapshot.pricing.official_price_hash_and_json(&model_key);
        let display_model = body.model;
        let kind = body.kind;
        let pricing = state.pricing.clone();
        let (new_snapshot, response) =
            with_saved_write(&state, "Failed to save pricing override", move |store| {
                let existed = store
                    .list_model_price_overrides()?
                    .iter()
                    .any(|record| record.model_key == model_key);
                store.upsert_model_price_override(UpsertModelPriceOverride {
                    model_key: model_key.clone(),
                    display_model,
                    kind,
                    target_model,
                    rates,
                })?;
                if !existed && let Some((hash, json)) = official_for_model {
                    store.acknowledge_official_price(
                        &model_key,
                        &hash,
                        &json,
                        chrono::Utc::now().timestamp_millis(),
                    )?;
                }
                Ok(Ok(replace_overrides(&pricing, store)?))
            })
            .await?;
        crate::pricing_refresh::reprice_history(&state.runtime, new_snapshot);
        Ok::<_, ApiError>(Json(response))
    }
    .await
    .into_response()
}

pub async fn acknowledge_override(
    AxumState(state): AxumState<Arc<State>>,
    bytes: Bytes,
) -> Response {
    async {
        let _guard = state.pricing_write_lock.lock().await;
        ensure_saved_available(&state).await?;
        let body: PricingModelActionRequest = parse_body(&bytes)?;
        let model_key = normalize_override_model_key(&body.model).ok_or_else(|| {
            ApiError::static_msg(StatusCode::BAD_REQUEST, "Invalid override model")
        })?;
        let snapshot = state.pricing.snapshot().map_err(|_| {
            ApiError::static_msg(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Failed to load pricing snapshot",
            )
        })?;
        let (official_hash, official_json) = snapshot
            .pricing
            .official_price_hash_and_json(&model_key)
            .ok_or_else(|| {
                ApiError::static_msg(
                    StatusCode::BAD_REQUEST,
                    "Model does not have official pricing",
                )
            })?;
        with_saved_write(
            &state,
            "Failed to acknowledge official pricing",
            move |store| {
                let acknowledged = store.acknowledge_official_price(
                    &model_key,
                    &official_hash,
                    &official_json,
                    chrono::Utc::now().timestamp_millis(),
                )?;
                if !acknowledged {
                    return Ok(Err(ApiError::static_msg(
                        StatusCode::NOT_FOUND,
                        "Pricing override not found",
                    )));
                }
                Ok(Ok(()))
            },
        )
        .await?;
        load_overrides(&state).await.map(Json)
    }
    .await
    .into_response()
}

pub async fn delete_override(AxumState(state): AxumState<Arc<State>>, bytes: Bytes) -> Response {
    async {
        let _guard = state.pricing_write_lock.lock().await;
        ensure_saved_available(&state).await?;
        let body: PricingModelActionRequest = parse_body(&bytes)?;
        let model_key = normalize_override_model_key(&body.model).ok_or_else(|| {
            ApiError::static_msg(StatusCode::BAD_REQUEST, "Invalid override model")
        })?;
        let pricing = state.pricing.clone();
        let (new_snapshot, response) =
            with_saved_write(&state, "Failed to delete pricing override", move |store| {
                if !store.delete_model_price_override(&model_key)? {
                    return Ok(Err(ApiError::static_msg(
                        StatusCode::NOT_FOUND,
                        "Pricing override not found",
                    )));
                }
                Ok(Ok(replace_overrides(&pricing, store)?))
            })
            .await?;
        crate::pricing_refresh::reprice_history(&state.runtime, new_snapshot);
        Ok::<_, ApiError>(Json(response))
    }
    .await
    .into_response()
}
