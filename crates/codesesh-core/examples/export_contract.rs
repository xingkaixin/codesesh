use codesesh_core::contract::*;
use codesesh_core::public_contract as wire;
use ts_rs::{Config, TS};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let generated = root.join("packages/contract/src/generated");
    if generated.exists() {
        std::fs::remove_dir_all(&generated)?;
    }
    let config = Config::new().with_out_dir(&generated);
    SessionHead::export_all(&config)?;
    wire::WireProjectIdentity::export_all(&config)?;
    wire::WireSessionHead::export_all(&config)?;
    wire::PublicReferencedSessionHead::export_all(&config)?;
    wire::ProjectGroup::export_all(&config)?;
    wire::WireAgentInfo::export_all(&config)?;
    wire::WireSessionFileActivity::export_all(&config)?;
    wire::SessionFileActivityOccurrence::export_all(&config)?;
    wire::WireToolState::export_all(&config)?;
    wire::WireTextPart::export_all(&config)?;
    wire::WireReasoningPart::export_all(&config)?;
    wire::WirePlanPart::export_all(&config)?;
    wire::WireToolPart::export_all(&config)?;
    wire::WireImageDataPart::export_all(&config)?;
    wire::WireImageUrlPart::export_all(&config)?;
    wire::WireMessage::export_all(&config)?;
    wire::WireSessionDetail::export_all(&config)?;
    wire::SessionWindow::export_all(&config)?;
    wire::AppConfig::export_all(&config)?;
    wire::ApiProjectAgentStat::export_all(&config)?;
    wire::ApiProjectGroup::export_all(&config)?;
    wire::ApiProjectSummary::export_all(&config)?;
    wire::ApiProjectPage::export_all(&config)?;
    wire::SessionsUpdatedEvent::export_all(&config)?;
    wire::ScanCompletion::export_all(&config)?;
    wire::AgentScanStatus::export_all(&config)?;
    wire::BackfillProgress::export_all(&config)?;
    wire::BackfillStatus::export_all(&config)?;
    wire::SearchIndexMaintenanceStatus::export_all(&config)?;
    wire::ScanStatusEvent::export_all(&config)?;
    wire::SearchResultParent::export_all(&config)?;
    wire::SearchHighlightRange::export_all(&config)?;
    wire::SearchResult::export_all(&config)?;
    wire::BookmarkRecord::export_all(&config)?;
    wire::AvailableBookmarkView::export_all(&config)?;
    wire::UnavailableBookmarkView::export_all(&config)?;
    wire::ModelCostEntry::export_all(&config)?;
    wire::DashboardAgentStat::export_all(&config)?;
    wire::DashboardDailyBucket::export_all(&config)?;
    wire::ModelDistributionEntry::export_all(&config)?;
    wire::DashboardProjectStat::export_all(&config)?;
    wire::DashboardProjectRollup::export_all(&config)?;
    wire::DashboardPreviousTotals::export_all(&config)?;
    wire::DashboardTotals::export_all(&config)?;
    wire::ScopeCounts::export_all(&config)?;
    wire::DashboardAggregate::export_all(&config)?;
    wire::DashboardActiveHours::export_all(&config)?;
    wire::DashboardWindow::export_all(&config)?;
    wire::FileActivityResult::export_all(&config)?;
    wire::DashboardData::export_all(&config)?;
    wire::BookmarkView::export_all(&config)?;
    wire::WireMessagePart::export_all(&config)?;
    wire::WireImagePart::export_all(&config)?;
    wire::WireSessionListPage::export_all(&config)?;
    // ts-rs has no readonly attribute; preserve the browser identity constraints after export.
    let reference = generated.join("SessionReference.ts");
    let source = std::fs::read_to_string(&reference)?;
    let source = source.replace(
        "export type SessionReference = ",
        "export type SessionReference = Readonly<",
    );
    let position = source
        .rfind(';')
        .ok_or("Missing generated SessionReference declaration")?;
    let source = format!("{}>{}", &source[..position], &source[position..]);
    std::fs::write(reference, source)?;
    for name in ["WireSessionHead.ts", "WireSessionDetail.ts"] {
        let path = generated.join(name);
        let source = std::fs::read_to_string(&path)?;
        std::fs::write(
            path,
            source.replace(
                " reference: SessionReference",
                " readonly reference: SessionReference",
            ),
        )?;
    }
    let catalog: serde_json::Value =
        serde_json::from_str(include_str!("../src/agents/catalog.json"))?;
    std::fs::write(
        generated.join("agent-catalog.ts"),
        format!(
            "// Generated from crates/codesesh-core/src/agents/catalog.json. Do not edit.\nexport const AGENT_CATALOG = {} as const;\n",
            serde_json::to_string_pretty(&catalog)?
        ),
    )?;
    Ok(())
}
