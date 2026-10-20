use crate::{agents::ParsedSession, pricing::Pricing};
use std::path::Path;

pub fn scan(root: &Path, pricing: &Pricing) -> anyhow::Result<Vec<ParsedSession>> {
    super::opencode::scan_database(&root.join("cli/db/db.sqlite"), "zcode", false, pricing)
}
