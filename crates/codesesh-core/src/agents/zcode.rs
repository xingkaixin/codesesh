use crate::{agents::codex::ParsedSession, pricing::Pricing};
use std::path::Path;

pub fn scan(root: &Path, pricing: &Pricing) -> anyhow::Result<Vec<ParsedSession>> {
    super::opencode::scan_database(&root.join("cli/db/db.sqlite"), "zcode", false, pricing)
}

pub fn refresh(
    root: &Path,
    pricing: &Pricing,
    previous: Option<&super::opencode::DatabaseSnapshot>,
) -> anyhow::Result<super::opencode::DatabaseSnapshot> {
    super::opencode::refresh_database(
        &root.join("cli/db/db.sqlite"),
        "zcode",
        false,
        pricing,
        previous,
    )
}
