use codesesh_core::contract::*;
use ts_rs::{Config, TS};
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let config = Config::new().with_out_dir("crates/codesesh-core/bindings");
    SessionIndex::export_all(&config)?;
    SessionDetail::export_all(&config)?;
    Ok(())
}
