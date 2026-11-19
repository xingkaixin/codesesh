use axum::{
    body::{Body, Bytes},
    http::header,
    response::Response,
};
use serde::Serialize;
use std::io::{self, Write};
use tokio::sync::mpsc;

const CHUNK_BYTES: usize = 64 * 1024;
const BUFFERED_CHUNKS: usize = 2;
const INTERNAL_PAGE_LIMIT: usize = 200;

pub fn json_with_guard<T, G>(data: T, guard: G) -> Response
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

pub async fn detail(
    runtime: codesesh_core::runtime::Runtime,
    pricing: codesesh_core::pricing::Pricing,
    reference: codesesh_core::model::SessionReference,
    cursor: Option<String>,
    message_limit: Option<usize>,
    aliases: std::collections::HashMap<codesesh_core::model::SessionReference, String>,
    guard: tokio::sync::OwnedSemaphorePermit,
) -> Response {
    let (sender, mut receiver) = mpsc::channel(BUFFERED_CHUNKS);
    tokio::spawn(async move {
        let pricing = std::sync::Arc::new(pricing);
        let aliases = std::sync::Arc::new(aliases);
        let mut page_cursor = cursor;
        let mut initial_update = None;
        let mut emitted_any = false;
        let mut first_page = true;
        // Materialize each bounded page inside runtime.read() and drop the SQLite read
        // transaction + reader permit before awaiting slow client backpressure.
        loop {
            let step_runtime = runtime.clone();
            let step_pricing = pricing.clone();
            let step_aliases = aliases.clone();
            let step_reference = reference.clone();
            let step_cursor = page_cursor.clone();
            let step_initial_update = initial_update;
            let page_result = step_runtime
                .read(move |connection| {
                    let head =
                        codesesh_core::storage::head_from_connection(connection, &step_reference)?
                            .ok_or(DetailNotReady)?;
                    let mut writer = ChunkBuffer::default();
                    if first_page {
                        writer.write_all(b"{\"messages\":[")?;
                    }
                    let mut page_emitted = 0usize;
                    let mut has_emitted = emitted_any;
                    let page_limit = message_limit.unwrap_or(INTERNAL_PAGE_LIMIT);
                    let (mut detail, total) = codesesh_core::storage::visit_detail_message_page(
                        connection,
                        head,
                        step_cursor.as_deref(),
                        Some(page_limit),
                        |mut message| {
                            message.cost_breakdown = step_pricing.message_cost_breakdown(&message);
                            let message = super::wire::message(message)?;
                            if has_emitted {
                                writer.write_all(b",")?;
                            }
                            has_emitted = true;
                            page_emitted += 1;
                            serde_json::to_writer(&mut writer, &message)?;
                            Ok(())
                        },
                    )?
                    .ok_or(DetailNotReady)?;
                    if !first_page
                        && detail.message_update
                            != Some(codesesh_core::model::MessageUpdate::Append)
                    {
                        anyhow::bail!("session changed while streaming transcript");
                    }
                    let effective_update = if first_page {
                        detail.message_update
                    } else {
                        step_initial_update
                    };
                    let next_cursor = detail.message_cursor.clone();
                    let sent = next_cursor
                        .as_deref()
                        .and_then(codesesh_core::storage::cursor_message_count)
                        .unwrap_or(total);
                    let done = message_limit.is_some() || page_emitted == 0 || sent >= total;
                    if done {
                        detail.message_update = effective_update;
                        super::decorate(&mut detail.head, &step_aliases);
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
                    }
                    Ok(DetailPage {
                        chunks: writer.finish(),
                        next_cursor,
                        initial_update: effective_update,
                        emitted_any: has_emitted,
                        done,
                    })
                })
                .await;
            match page_result {
                Ok(page) => {
                    for chunk in page.chunks {
                        if sender.send(Ok(chunk)).await.is_err() {
                            return;
                        }
                    }
                    if page.done {
                        return;
                    }
                    page_cursor = page.next_cursor;
                    initial_update = page.initial_update;
                    emitted_any = page.emitted_any;
                    first_page = false;
                }
                Err(error) => {
                    let kind = if error
                        .downcast_ref::<codesesh_core::runtime::ReadBusy>()
                        .is_some()
                    {
                        io::ErrorKind::WouldBlock
                    } else if error.downcast_ref::<DetailNotReady>().is_some() {
                        io::ErrorKind::NotFound
                    } else {
                        io::ErrorKind::Other
                    };
                    let _ = sender.send(Err(io::Error::new(kind, error))).await;
                    return;
                }
            }
        }
    });
    let first = match receiver.recv().await {
        Some(Ok(first)) => first,
        Some(Err(error)) if error.kind() == io::ErrorKind::WouldBlock => {
            return super::retry("Session details busy; retry later");
        }
        Some(Err(error)) if error.kind() == io::ErrorKind::NotFound => {
            return super::retry("Session detail not ready; retry later");
        }
        _ => {
            return super::error(
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                "Failed to load session",
            );
        }
    };
    let stream = async_stream::stream! {
        let _guard = guard;
        yield Ok(first);
        while let Some(chunk) = receiver.recv().await { yield chunk; }
    };
    Response::builder()
        .header(header::CONTENT_TYPE, "application/json; charset=UTF-8")
        .body(Body::from_stream(stream))
        .unwrap()
}

#[derive(Debug)]
struct DetailNotReady;
impl std::fmt::Display for DetailNotReady {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("session detail not ready")
    }
}
impl std::error::Error for DetailNotReady {}

struct DetailPage {
    chunks: Vec<Bytes>,
    next_cursor: Option<String>,
    initial_update: Option<codesesh_core::model::MessageUpdate>,
    emitted_any: bool,
    done: bool,
}

#[derive(Default)]
struct ChunkBuffer {
    chunks: Vec<Bytes>,
    buffer: Vec<u8>,
}

impl ChunkBuffer {
    fn finish(mut self) -> Vec<Bytes> {
        if !self.buffer.is_empty() {
            self.chunks.push(Bytes::from(self.buffer));
        }
        self.chunks
    }
}

impl Write for ChunkBuffer {
    fn write(&mut self, mut bytes: &[u8]) -> io::Result<usize> {
        let size = bytes.len();
        if self.buffer.capacity() == 0 {
            self.buffer.reserve(CHUNK_BYTES);
        }
        while !bytes.is_empty() {
            let count = bytes.len().min(CHUNK_BYTES - self.buffer.len());
            self.buffer.extend_from_slice(&bytes[..count]);
            bytes = &bytes[count..];
            if self.buffer.len() == CHUNK_BYTES {
                let full = std::mem::replace(&mut self.buffer, Vec::with_capacity(CHUNK_BYTES));
                self.chunks.push(Bytes::from(full));
            }
        }
        Ok(size)
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

struct ChunkWriter {
    sender: mpsc::Sender<io::Result<Bytes>>,
    buffer: Vec<u8>,
}
impl Write for ChunkWriter {
    fn write(&mut self, mut bytes: &[u8]) -> io::Result<usize> {
        let size = bytes.len();
        while !bytes.is_empty() {
            let count = bytes.len().min(CHUNK_BYTES - self.buffer.len());
            self.buffer.extend_from_slice(&bytes[..count]);
            bytes = &bytes[count..];
            if self.buffer.len() == CHUNK_BYTES {
                self.flush()?;
            }
        }
        Ok(size)
    }
    fn flush(&mut self) -> io::Result<()> {
        if self.buffer.is_empty() {
            return Ok(());
        }
        let bytes = std::mem::replace(&mut self.buffer, Vec::with_capacity(CHUNK_BYTES));
        self.sender
            .blocking_send(Ok(Bytes::from(bytes)))
            .map_err(|_| io::Error::new(io::ErrorKind::BrokenPipe, "response reader disconnected"))
    }
}

#[cfg(test)]
mod tests;
