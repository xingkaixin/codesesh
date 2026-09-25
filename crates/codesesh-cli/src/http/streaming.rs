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
    reference: codesesh_core::contract::SessionReference,
    cursor: Option<String>,
    aliases: std::collections::HashMap<codesesh_core::contract::SessionReference, String>,
    guard: tokio::sync::OwnedSemaphorePermit,
) -> Response {
    let (sender, mut receiver) = mpsc::channel(BUFFERED_CHUNKS);
    let output = sender.clone();
    tokio::spawn(async move {
        let result = runtime
            .read(move |connection| {
                let head = codesesh_core::storage::head_from_connection(connection, &reference)?
                    .ok_or(DetailNotReady)?;
                let mut writer = ChunkWriter {
                    sender,
                    buffer: Vec::with_capacity(CHUNK_BYTES),
                };
                writer.write_all(b"{\"messages\":[")?;
                let mut first = true;
                let detail = codesesh_core::storage::visit_detail_messages(
                    connection,
                    head,
                    cursor.as_deref(),
                    |message| {
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
                let mut footer = serde_json::to_value(super::wire::detail(detail)?)?;
                footer
                    .as_object_mut()
                    .expect("detail is a JSON object")
                    .remove("messages");
                let footer = serde_json::to_vec(&footer)?;
                writer.write_all(b"],")?;
                writer.write_all(&footer[1..])?;
                writer.flush()?;
                Ok(())
            })
            .await;
        if let Err(error) = result {
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
            let _ = output.send(Err(io::Error::new(kind, error))).await;
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
