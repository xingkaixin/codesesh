use axum::{
    body::{Body, Bytes},
    http::{HeaderValue, header},
    response::Response,
};
use serde::Serialize;
use std::io::{self, Seek, Write};
use tokio::sync::mpsc;

const CHUNK_BYTES: usize = 64 * 1024;
const BUFFERED_CHUNKS: usize = 2;
const DETAIL_IN_MEMORY_LIMIT: usize = 8 * 1024 * 1024;

pub fn json_with_guard<T, G>(data: T, guard: G) -> Response
where
    T: Serialize + Send + 'static,
    G: Send + 'static,
{
    let _guard = guard;
    let bytes = match serde_json::to_vec(&data) {
        Ok(bytes) => bytes,
        Err(_) => {
            return super::error(
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                "Failed to serialize response",
            );
        }
    };
    let len = bytes.len();
    Response::builder()
        .header(header::CONTENT_TYPE, "application/json; charset=UTF-8")
        .header(header::CONTENT_LENGTH, HeaderValue::from(len))
        .body(Body::from(bytes))
        .unwrap()
}

pub fn json_stream_with_guard<T, G>(data: T, guard: G) -> Response
where
    T: Serialize + Send + 'static,
    G: Send + 'static,
{
    let stream = async_stream::stream! {
        let _guard = guard;
        let (sender, mut receiver) = mpsc::channel(BUFFERED_CHUNKS);
        let worker = tokio::task::spawn_blocking(move || {
            let mut writer = ChunkWriter { sender, buffer: Vec::with_capacity(CHUNK_BYTES) };
            if let Err(error) = serde_json::to_writer(&mut writer, &data).map_err(io::Error::other).and_then(|()| writer.flush()) {
                let _ = writer.sender.blocking_send(Err(error));
            }
        });
        while let Some(chunk) = receiver.recv().await {
            yield chunk;
        }
        if let Err(error) = worker.await {
            yield Err(io::Error::other(error));
        }
    };
    Response::builder()
        .header(header::CONTENT_TYPE, "application/json; charset=UTF-8")
        .body(Body::from_stream(stream))
        .unwrap()
}

struct ChunkWriter {
    sender: mpsc::Sender<io::Result<Bytes>>,
    buffer: Vec<u8>,
}

impl Write for ChunkWriter {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        let mut remaining = bytes;
        while !remaining.is_empty() {
            let space = CHUNK_BYTES.saturating_sub(self.buffer.len());
            let take = remaining.len().min(space);
            self.buffer.extend_from_slice(&remaining[..take]);
            remaining = &remaining[take..];
            if self.buffer.len() >= CHUNK_BYTES {
                self.flush()?;
            }
        }
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        if self.buffer.is_empty() {
            return Ok(());
        }
        let chunk = Bytes::from(std::mem::replace(
            &mut self.buffer,
            Vec::with_capacity(CHUNK_BYTES),
        ));
        self.sender
            .blocking_send(Ok(chunk))
            .map_err(|_| io::Error::new(io::ErrorKind::BrokenPipe, "response receiver dropped"))
    }
}

pub async fn detail(
    runtime: codesesh_core::runtime::Runtime,
    pricing: codesesh_core::pricing::Pricing,
    reference: codesesh_core::model::SessionReference,
    cursor: Option<String>,
    message_limit: Option<usize>,
    aliases: std::collections::HashMap<codesesh_core::model::SessionReference, String>,
    guard: tokio::sync::OwnedSemaphorePermit,
) -> Response {
    let result = runtime
        .read(move |connection| {
            let head = codesesh_core::storage::head_from_connection(connection, &reference)?
                .ok_or(DetailNotReady)?;
            let mut spool = tempfile::spooled_tempfile(DETAIL_IN_MEMORY_LIMIT);
            let mut writer = io::BufWriter::with_capacity(CHUNK_BYTES, &mut spool);
            writer.write_all(b"{\"messages\":[")?;
            let mut first = true;
            let (detail, total) = codesesh_core::storage::visit_detail_message_page(
                connection,
                head,
                cursor.as_deref(),
                message_limit,
                |mut message| {
                    message.cost_breakdown = pricing.message_cost_breakdown(&message);
                    let message = super::wire::message(message)?;
                    if !first {
                        writer.write_all(b",")?;
                    }
                    first = false;
                    serde_json::to_writer(&mut writer, &message)?;
                    Ok(())
                },
            )?
            .ok_or(DetailNotReady)?;
            let mut detail = detail;
            super::decorate(&mut detail.head, &aliases);
            let mut detail = super::wire::detail(detail)?;
            detail.message_total = message_limit.map(|_| total as f64);
            let mut footer = serde_json::to_value(detail)?;
            footer
                .as_object_mut()
                .expect("detail is a JSON object")
                .remove("messages");
            let footer = serde_json::to_vec(&footer)?;
            writer.write_all(b"],")?;
            writer.write_all(&footer[1..])?;
            writer.flush()?;
            drop(writer);
            spool.rewind()?;
            Ok(spool.into_inner())
        })
        .await;
    let data = match result {
        Ok(data) => data,
        Err(error) if error.is::<codesesh_core::runtime::ReadBusy>() => {
            return super::retry("Session details busy; retry later");
        }
        Err(error) if error.is::<DetailNotReady>() => {
            return super::retry("Session detail not ready; retry later");
        }
        Err(_) => {
            return super::error(
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                "Failed to load session",
            );
        }
    };
    let content_length = match &data {
        tempfile::SpooledData::InMemory(cursor) => Some(cursor.get_ref().len()),
        tempfile::SpooledData::OnDisk(file) => file.metadata().ok().map(|m| m.len() as usize),
    };
    let stream = async_stream::stream! {
        let _guard = guard;
        match data {
            tempfile::SpooledData::InMemory(cursor) => {
                let bytes = Bytes::from(cursor.into_inner());
                let mut offset = 0;
                while offset < bytes.len() {
                    let end = (offset + CHUNK_BYTES).min(bytes.len());
                    yield Ok::<_, io::Error>(bytes.slice(offset..end));
                    offset = end;
                }
            }
            tempfile::SpooledData::OnDisk(file) => {
                use futures_util::StreamExt;
                let mut chunks = tokio_util::io::ReaderStream::with_capacity(tokio::fs::File::from_std(file), CHUNK_BYTES);
                while let Some(chunk) = chunks.next().await { yield chunk; }
            }
        }
    };
    let mut builder =
        Response::builder().header(header::CONTENT_TYPE, "application/json; charset=UTF-8");
    if let Some(len) = content_length {
        builder = builder.header(header::CONTENT_LENGTH, HeaderValue::from(len));
    }
    builder.body(Body::from_stream(stream)).unwrap()
}

#[derive(Debug)]
struct DetailNotReady;
impl std::fmt::Display for DetailNotReady {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("session detail not ready")
    }
}
impl std::error::Error for DetailNotReady {}

#[cfg(test)]
mod tests;
