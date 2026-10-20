use super::{ChildSummary, Parser, parse, rollout};
use crate::{agents::jsonl, model::SessionDetail, pricing::Pricing};
use anyhow::Result;
use std::{
    collections::HashMap,
    fs::File,
    io::{BufReader, Read, Seek, SeekFrom},
    path::{Path, PathBuf},
};

#[cfg(not(test))]
const CHECKPOINT_MIN_BYTES: u64 = 8 * 1024 * 1024;
#[cfg(test)]
const CHECKPOINT_MIN_BYTES: u64 = 1;
const CHECKPOINT_LIMIT: usize = 2;
const CHECKPOINT_TAIL_BYTES: usize = 64;

/// Parser state for the few large rollouts still being written, and child summaries.
#[derive(Default)]
pub struct Checkpoints {
    pub(super) parsers: Vec<(PathBuf, Checkpoint)>,
    pub(super) children: HashMap<PathBuf, ChildSummary>,
}

pub(super) struct Checkpoint {
    physical: PathBuf,
    offset: u64,
    tail: Vec<u8>,
    generation: u64,
    parser: Parser,
}

impl Checkpoints {
    pub fn parse(
        &mut self,
        path: &Path,
        titles: &HashMap<String, String>,
        pricing: &Pricing,
    ) -> Result<Option<SessionDetail>> {
        let logical = rollout::logical_path(path);
        let previous = self
            .parsers
            .iter()
            .position(|(key, _)| *key == logical)
            .map(|index| self.parsers.remove(index).1);
        let Some(physical) = rollout::physical_path(path)?
            .filter(|physical| physical.extension().is_some_and(|ext| ext == "jsonl"))
        else {
            return parse(path, titles, pricing);
        };
        let Ok(mut file) = File::open(&physical) else {
            return parse(path, titles, pricing);
        };
        let metadata = file.metadata()?;
        let len = metadata.len();
        if len < CHECKPOINT_MIN_BYTES || !jsonl::recently_written(&metadata) {
            return parse(path, titles, pricing);
        }
        let mut resumed = None;
        if let Some(checkpoint) = previous
            && checkpoint.physical == physical
            && checkpoint.generation == pricing.generation()
            && checkpoint.offset <= len
        {
            let mut tail = vec![0; checkpoint.tail.len()];
            file.seek(SeekFrom::Start(checkpoint.offset - tail.len() as u64))?;
            file.read_exact(&mut tail)?;
            if tail == checkpoint.tail {
                resumed = Some(checkpoint);
            }
        }
        let (mut parser, mut offset, mut tail) = match resumed {
            Some(checkpoint) => (Some(checkpoint.parser), checkpoint.offset, checkpoint.tail),
            None => (None, 0, Vec::new()),
        };
        file.seek(SeekFrom::Start(offset))?;
        let mut reader = BufReader::with_capacity(64 * 1024, file);
        let mut line = String::new();
        let mut partial = None;
        loop {
            line.clear();
            let read = jsonl::read_line(&mut reader, &mut line)?;
            if read == 0 {
                break;
            }
            // Codex may still be writing the last line; resume before it.
            if !line.ends_with('\n') {
                partial = Some(std::mem::take(&mut line));
                break;
            }
            let state = match &mut parser {
                Some(state) => state,
                None => match Parser::new(path, &physical, &line)? {
                    Some(state) => parser.insert(state),
                    None => return Ok(None),
                },
            };
            state.feed(&line, pricing);
            offset += read as u64;
            tail = line.as_bytes()[line.len().saturating_sub(CHECKPOINT_TAIL_BYTES)..].to_vec();
        }
        let Some(parser) = parser else {
            return parse(path, titles, pricing);
        };
        let mut current = parser.clone();
        if let Some(line) = &partial {
            current.feed(line, pricing);
        }
        self.parsers.push((
            logical,
            Checkpoint {
                physical,
                offset,
                tail,
                generation: pricing.generation(),
                parser,
            },
        ));
        if self.parsers.len() > CHECKPOINT_LIMIT {
            self.parsers.remove(0);
        }
        Ok(current.finish(titles))
    }

    /// A rollout that stops being written raises no further change, so scans release it here.
    pub fn release_idle(&mut self) {
        self.parsers.retain(|(_, checkpoint)| {
            std::fs::metadata(&checkpoint.physical)
                .is_ok_and(|metadata| jsonl::recently_written(&metadata))
        });
    }
}
