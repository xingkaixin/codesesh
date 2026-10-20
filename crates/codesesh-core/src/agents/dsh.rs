mod log;
mod project;

use super::claudecode::common::InvalidSession;
use crate::{agents::ParsedSession, model::*, pricing::Pricing, projects::path_identity};
use anyhow::Result;
use std::{
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
    sync::LazyLock,
};

pub fn generation(name: &str) -> Option<(u64, bool)> {
    static NAME: LazyLock<regex::Regex> =
        LazyLock::new(|| regex::Regex::new(r"^session(?:\.v(\d+))?\.jsonl(\.zstd)?$").unwrap());
    let captures = NAME.captures(name)?;
    let version = captures
        .get(1)
        .map_or(Some(0), |version| version.as_str().parse().ok())?;
    Some((version, captures.get(2).is_some()))
}

pub fn scan(root: &Path, pricing: &Pricing) -> Result<Vec<ParsedSession>> {
    scan_selected(root, pricing, None)
}

pub fn scan_changed(
    root: &Path,
    pricing: &Pricing,
    changed_paths: &[PathBuf],
    previous: &[crate::agents::SessionRecord],
) -> Result<super::ScanDelta> {
    let mut affected = changed_paths.to_vec();
    let attachments = root.join("attachments/v1/objects");
    for session in previous {
        if session.head.reference.agent_name != "dsh" {
            continue;
        }
        if changed_paths.iter().any(|changed| {
            (changed.starts_with(&attachments) || attachments.starts_with(changed))
                && session.attachments.matches(changed)
        }) {
            affected.push(session.source.clone());
        }
    }
    let upserts = scan_selected(root, pricing, Some(&affected))?;
    let retained: HashSet<_> = upserts.iter().map(|s| &s.head.reference).collect();
    let removed = previous
        .iter()
        .filter(|session| {
            session.head.reference.agent_name == "dsh"
                && !retained.contains(&session.head.reference)
                && affected.iter().any(|changed| {
                    session.source.starts_with(changed)
                        || session
                            .source
                            .parent()
                            .is_some_and(|parent| changed.starts_with(parent))
                })
        })
        .map(|session| session.head.reference.clone())
        .collect();
    Ok(super::ScanDelta {
        upserts,
        removed,
        complete: false,
    })
}

#[derive(Clone, Debug, Default, serde::Serialize, serde::Deserialize)]
pub struct AttachmentReferences {
    digests: HashSet<String>,
    unavailable: bool,
}
impl AttachmentReferences {
    pub fn from_messages(messages: &[Message]) -> Self {
        use base64::{Engine, engine::general_purpose::STANDARD};
        use sha2::{Digest, Sha256};
        let mut references = Self::default();
        for part in messages.iter().flat_map(|message| &message.parts) {
            match part {
                MessagePart::Image {
                    data: Some(data), ..
                } => {
                    if let Ok(bytes) = STANDARD.decode(data) {
                        references
                            .digests
                            .insert(crate::hash::hex(&Sha256::digest(bytes)));
                    }
                }
                MessagePart::Text { text, .. } if text == "Image attachment unavailable" => {
                    references.unavailable = true;
                }
                _ => {}
            }
        }
        references
    }
    fn matches(&self, changed: &Path) -> bool {
        self.unavailable
            || changed
                .file_name()
                .and_then(|s| s.to_str())
                .filter(|s| s.len() == 64)
                .map_or(!self.digests.is_empty(), |digest| {
                    self.digests.contains(digest)
                })
    }
}

fn scan_selected(
    root: &Path,
    pricing: &Pricing,
    changed_paths: Option<&[PathBuf]>,
) -> Result<Vec<ParsedSession>> {
    let sessions = root.join("sessions");
    let projects = match fs::read_dir(&sessions) {
        Ok(entries) => entries,
        Err(error)
            if matches!(
                error.kind(),
                std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory
            ) =>
        {
            return Ok(Vec::new());
        }
        Err(error) => return Err(error.into()),
    };
    let mut artifacts: Vec<(PathBuf, bool)> = Vec::new();
    for project in projects {
        let project = project?;
        if !project.file_type()?.is_dir() {
            continue;
        }
        if changed_paths.is_some_and(|paths| {
            !paths.iter().any(|changed| {
                project.path().starts_with(changed) || changed.starts_with(project.path())
            })
        }) {
            continue;
        }
        for entry in fs::read_dir(project.path())? {
            let entry = entry?;
            if !entry.file_type()?.is_dir() {
                continue;
            }
            if changed_paths.is_some_and(|paths| {
                !paths.iter().any(|changed| {
                    entry.path().starts_with(changed) || changed.starts_with(entry.path())
                })
            }) {
                continue;
            }
            let Ok(files) = fs::read_dir(entry.path()) else {
                continue;
            };
            // A session carried over to a newer format keeps its older files beside the new one.
            let mut latest = None;
            for file in files.flatten() {
                let Some((version, compressed)) = generation(&file.file_name().to_string_lossy())
                else {
                    continue;
                };
                let Ok(metadata) = fs::metadata(file.path()) else {
                    continue;
                };
                if !metadata.is_file() {
                    continue;
                }
                let order = (version, metadata.modified()?);
                if latest.as_ref().is_none_or(|(latest, _, _)| order > *latest) {
                    latest = Some((order, file.path(), compressed));
                }
            }
            if let Some((_, path, compressed)) = latest {
                artifacts.push((path, compressed));
            }
        }
    }
    let mut seen = HashSet::new();
    let mut parsed = Vec::new();
    for (source, compressed) in artifacts {
        if changed_paths.is_some_and(|paths| {
            !paths.iter().any(|changed| {
                source.starts_with(changed) || changed.starts_with(source.parent().unwrap())
            })
        }) {
            continue;
        }
        let (header, events) = match log::read(&source, compressed) {
            Err(error) if error.is::<InvalidSession>() => continue,
            result => result?,
        };
        let id = project::text(&header["id"]).to_owned();
        let directory = project::text(&header["cwd"]).to_owned();
        let project_key = if header.get("cwd").is_some() {
            log::project(&directory)?
        } else {
            "_no-cwd".into()
        };
        let expected = sessions
            .join(project_key)
            .join(log::encode(&id)?)
            .join(source.file_name().unwrap());
        let identified = source == expected
            || matches!(
                (fs::canonicalize(&source), fs::canonicalize(&expected)),
                (Ok(source), Ok(expected)) if source == expected
            );
        if !identified || !seen.insert(id.clone()) {
            continue;
        }
        let Ok(projection) =
            project::project(&header, &events, &root.join("attachments/v1"), pricing)
        else {
            continue;
        };
        if projection.messages.is_empty() {
            continue;
        }
        let (identity, signature) = path_identity(&directory);
        let fallback = Path::new(directory.trim_end_matches(['/', '\\']))
            .file_name()
            .and_then(|x| x.to_str())
            .unwrap_or("");
        let title = projection
            .title
            .as_deref()
            .and_then(project::title)
            .or_else(|| project::title(fallback))
            .unwrap_or_else(|| "Untitled Session".into());
        let head = SessionHead {
            version: None,
            summary_files: None,
            reference: SessionReference {
                source_node_id: crate::model::local_source_node_id(),
                agent_name: "dsh".into(),
                session_id: id,
            },
            title,
            directory,
            display_title: None,
            parent_reference: header["parentSession"]
                .as_str()
                .filter(|s| !s.is_empty())
                .map(|id| SessionReference {
                    source_node_id: crate::model::local_source_node_id(),
                    agent_name: "dsh".into(),
                    session_id: id.into(),
                }),
            project_identity: identity,
            project_identity_resolver_revision: Some("project-identity-v2".into()),
            project_identity_input_signature: Some(signature),
            time_created: header["createdAt"].as_f64().unwrap_or(0.0),
            time_updated: projection.updated,
            stats: projection.stats,
            model_usage: (!projection.usage.is_empty()).then_some(projection.usage),
            smart_tags: Vec::new(),
            smart_tags_source_updated_at: Some(projection.updated),
            smart_tags_classifier_revision: Some("smart-tags-v1".into()),
        };
        let file_activity = super::file_activity::summarize(&head, &projection.messages);
        parsed.push(ParsedSession {
            source,
            head: head.clone(),
            detail: SessionDetail {
                head: SessionHead {
                    version: Some("0".into()),
                    ..head
                },
                messages: projection.messages,
                detail_freshness: "fresh".into(),
                message_cursor: None,
                message_update: None,
                file_activity,
            },
        });
    }
    Ok(parsed)
}

#[cfg(test)]
mod tests;
