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
