use super::{CHUNK_BYTES, Operation, enqueue};
use anyhow::{Result, ensure};
use base64::{Engine, engine::general_purpose::STANDARD};
use rusqlite::Transaction;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::io::{self, Write};

pub(super) fn serialized_digest(value: &impl Serialize) -> Result<String> {
    let mut writer = DigestWriter(Sha256::new());
    {
        let mut buffered = io::BufWriter::new(&mut writer);
        serde_json::to_writer(&mut buffered, value)?;
        buffered.flush()?;
    }
    Ok(crate::hash::hex(&writer.0.finalize()))
}

struct DigestWriter(Sha256);

impl Write for DigestWriter {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.0.update(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

pub(super) fn enqueue_snapshot(tx: &Transaction<'_>, snapshot: &impl Serialize) -> Result<()> {
    let mut writer = SnapshotWriter {
        tx,
        transfer_id: uuid::Uuid::new_v4().to_string(),
        buffer: Vec::with_capacity(CHUNK_BYTES),
        hash: Sha256::new(),
        chunks: 0,
        bytes: 0,
    };
    serde_json::to_writer(&mut writer, snapshot)?;
    writer.flush()?;
    enqueue(
        tx,
        &Operation::SnapshotCommit {
            transfer_id: writer.transfer_id,
            chunks: writer.chunks,
            bytes: writer.bytes,
            digest: crate::hash::hex(&writer.hash.finalize()),
            base: None,
            messages: None,
        },
    )
}

struct SnapshotWriter<'a, 'db> {
    tx: &'a Transaction<'db>,
    transfer_id: String,
    buffer: Vec<u8>,
    hash: Sha256,
    chunks: u32,
    bytes: u64,
}

impl SnapshotWriter<'_, '_> {
    fn enqueue_chunk(&mut self) -> Result<()> {
        if self.buffer.is_empty() {
            return Ok(());
        }
        ensure!(self.chunks < u32::MAX, "Session snapshot is too large");
        enqueue(
            self.tx,
            &Operation::SnapshotChunk {
                transfer_id: self.transfer_id.clone(),
                index: self.chunks,
                data: STANDARD.encode(&self.buffer),
            },
        )?;
        self.hash.update(&self.buffer);
        self.bytes += self.buffer.len() as u64;
        self.chunks += 1;
        self.buffer.clear();
        Ok(())
    }
}

impl Write for SnapshotWriter<'_, '_> {
    fn write(&mut self, mut bytes: &[u8]) -> io::Result<usize> {
        let len = bytes.len();
        while !bytes.is_empty() {
            let take = (CHUNK_BYTES - self.buffer.len()).min(bytes.len());
            self.buffer.extend_from_slice(&bytes[..take]);
            bytes = &bytes[take..];
            if self.buffer.len() == CHUNK_BYTES {
                self.enqueue_chunk().map_err(io::Error::other)?;
            }
        }
        Ok(len)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.enqueue_chunk().map_err(io::Error::other)
    }
}
