mod control;
mod local;
mod receive;
mod tasks;

use super::Cache;
use crate::{
    model::{SessionHead, SessionReference},
    pricing::Pricing,
    sync::{
        CapturedSession, Node, Operation, PAYLOAD_VERSION, PairingGrant, Receipt, RescanStatus,
        Upload, worker_store::digest,
    },
};
use anyhow::{Context, Result, ensure};
use base64::{Engine, engine::general_purpose::STANDARD};
use rusqlite::{OptionalExtension, Transaction, params};
use std::sync::LazyLock;

static ACTIVE_RESCANS: LazyLock<String> = LazyLock::new(|| {
    RescanStatus::ALL
        .into_iter()
        .filter(|status| status.is_active())
        .map(|status| format!("'{}'", status.as_str()))
        .collect::<Vec<_>>()
        .join(",")
});

#[cfg(test)]
mod tests;
