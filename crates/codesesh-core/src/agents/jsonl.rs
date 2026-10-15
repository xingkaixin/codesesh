use std::io::{self, BufRead, BufReader, Read};

pub(super) struct JsonLines<R> {
    reader: BufReader<R>,
    line: String,
}

impl<R: Read> JsonLines<R> {
    pub(super) fn new(reader: R) -> Self {
        Self {
            reader: BufReader::with_capacity(64 * 1024, reader),
            line: String::new(),
        }
    }

    pub(super) fn next_line(&mut self) -> io::Result<Option<&str>> {
        if self.line.capacity() > 1024 * 1024 {
            self.line = String::new();
        } else {
            self.line.clear();
        }
        if read_line(&mut self.reader, &mut self.line)? == 0 {
            return Ok(None);
        }
        Ok(Some(&self.line))
    }
}

/// `BufRead::read_line` that replaces invalid UTF-8 instead of failing the whole source.
/// The count is in source bytes, which can differ from the replaced line's length.
pub(super) fn read_line(reader: &mut impl BufRead, line: &mut String) -> io::Result<usize> {
    let mut bytes = std::mem::take(line).into_bytes();
    let read = reader.read_until(b'\n', &mut bytes)?;
    *line = String::from_utf8(bytes)
        .unwrap_or_else(|error| String::from_utf8_lossy(error.as_bytes()).into_owned());
    Ok(read)
}

pub(crate) const ACTIVE_WINDOW: std::time::Duration = std::time::Duration::from_secs(10 * 60);

/// Parser checkpoints only pay off for transcripts that are still being appended to.
pub(super) fn recently_written(metadata: &std::fs::Metadata) -> bool {
    match metadata.modified().map(|time| time.elapsed()) {
        Ok(Ok(age)) => age < ACTIVE_WINDOW,
        // An unknown or future mtime gives no evidence that the file is idle.
        _ => true,
    }
}
