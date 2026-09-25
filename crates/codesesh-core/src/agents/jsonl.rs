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
        if self.reader.read_line(&mut self.line)? == 0 {
            return Ok(None);
        }
        Ok(Some(&self.line))
    }
}
