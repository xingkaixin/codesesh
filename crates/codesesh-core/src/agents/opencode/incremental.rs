use super::*;
use sha2::{Digest, Sha256};

#[derive(Default)]
pub struct DatabaseSnapshot {
    pub sessions: Vec<ParsedSession>,
    pub upserts: Vec<ParsedSession>,
    pub removed: Vec<SessionReference>,
    pub decoded: Vec<SessionReference>,
    pub(super) fingerprints: HashMap<String, String>,
    pub(super) base_details: HashMap<String, SessionDetail>,
    pub(super) raw_usage: HashMap<String, SessionStats>,
    pub(super) pricing_generation: u64,
}

pub fn refresh(
    root: &Path,
    pricing: &Pricing,
    previous: Option<&DatabaseSnapshot>,
) -> Result<DatabaseSnapshot> {
    refresh_database(
        &root.join("opencode.db"),
        "opencode",
        true,
        pricing,
        previous,
    )
}

pub fn refresh_database(
    path: &Path,
    agent: &str,
    supports_v2: bool,
    pricing: &Pricing,
    previous: Option<&DatabaseSnapshot>,
) -> Result<DatabaseSnapshot> {
    refresh_scoped(path, agent, supports_v2, pricing, previous, None)
}
pub(super) fn refresh_scoped(
    path: &Path,
    agent: &str,
    supports_v2: bool,
    pricing: &Pricing,
    previous: Option<&DatabaseSnapshot>,
    selected: Option<&HashSet<String>>,
) -> Result<DatabaseSnapshot> {
    if !path.exists() {
        return Ok(DatabaseSnapshot {
            removed: previous
                .into_iter()
                .flat_map(|p| p.sessions.iter().map(|s| s.head.reference.clone()))
                .collect(),
            ..Default::default()
        });
    }
    let db = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .with_context(|| format!("opening {agent} database {}", path.display()))?;
    db.execute_batch("BEGIN")?;
    let v2 = supports_v2 && has_v2(&db)?;
    if selected.is_some() && previous.is_some_and(|p| p.pricing_generation != pricing.generation())
    {
        bail!("Pricing changed during OpenCode pagination; restart the source scan");
    }
    let scope = selected
        .map(|selected| paging::expanded_scope(&db, v2, selected, previous))
        .transpose()?;
    let mut fingerprints = fingerprints(&db, v2, scope.as_ref())?;
    if let (Some(scope), Some(previous)) = (&scope, previous) {
        fingerprints.extend(
            previous
                .fingerprints
                .iter()
                .filter(|(id, _)| !scope.contains(*id))
                .map(|(id, hash)| (id.clone(), hash.clone())),
        );
    }
    let reuse = previous.filter(|p| p.pricing_generation == pricing.generation());
    let changed: HashSet<_> = fingerprints
        .iter()
        .filter(|(id, hash)| reuse.and_then(|p| p.fingerprints.get(*id)) != Some(*hash))
        .map(|(id, _)| id.clone())
        .collect();
    let mut details = if v2 {
        read_v2(&db, pricing, reuse, &changed, scope.as_ref())?
    } else {
        read_v1(&db, agent, pricing, reuse, &changed, scope.as_ref())?
    };
    if let (Some(scope), Some(previous)) = (&scope, previous) {
        details.extend(
            previous
                .base_details
                .iter()
                .filter(|(id, _)| !scope.contains(*id))
                .map(|(_, detail)| detail.clone()),
        );
        sort(&mut details);
    }
    let raw_usage = if v2 {
        HashMap::new()
    } else {
        raw_usage(&db, pricing, reuse, &changed, &fingerprints)?
    };
    let child_usage = if v2 {
        HashMap::new()
    } else {
        descendant_usage(&db, &raw_usage)?
    };
    let base_details = details
        .iter()
        .map(|s| (s.head.reference.session_id.clone(), s.clone()))
        .collect();
    let sessions: Vec<_> = details
        .into_iter()
        .map(|mut detail| {
            let mut head = detail.head.clone();
            if !v2 {
                head.version = None;
                head.summary_files = None;
            }
            if let Some(children) = child_usage.get(&head.reference.session_id) {
                detail.head.stats.total_cost += children.total_cost;
                detail.head.stats.total_input_tokens += children.total_input_tokens;
                detail.head.stats.total_output_tokens += children.total_output_tokens;
                if detail.head.stats.total_cost > 0.0 {
                    detail.head.stats.cost_source = Some(
                        if detail.head.stats.cost_source == Some(CostSource::Estimated)
                            || children.cost_source == Some(CostSource::Estimated)
                        {
                            CostSource::Estimated
                        } else {
                            CostSource::Recorded
                        },
                    );
                }
            }
            ParsedSession {
                source: path.into(),
                head,
                detail,
            }
        })
        .collect();
    let old: HashMap<_, _> = previous
        .into_iter()
        .flat_map(|p| {
            p.sessions
                .iter()
                .map(|session| (&session.head.reference, session))
        })
        .collect();
    let upserts = sessions
        .iter()
        .filter(|session| {
            old.get(&session.head.reference)
                .is_none_or(|before| before.head != session.head || before.detail != session.detail)
        })
        .cloned()
        .collect();
    let current: HashSet<_> = sessions.iter().map(|s| s.head.reference.clone()).collect();
    let removed = previous
        .into_iter()
        .flat_map(|p| {
            p.sessions
                .iter()
                .filter(|s| !current.contains(&s.head.reference))
                .map(|s| s.head.reference.clone())
        })
        .collect();
    let decoded = changed.into_iter().map(|id| reference(agent, id)).collect();
    db.execute_batch("COMMIT")?;
    Ok(DatabaseSnapshot {
        sessions,
        upserts,
        removed,
        decoded,
        fingerprints,
        base_details,
        raw_usage,
        pricing_generation: pricing.generation(),
    })
}

fn fingerprints(
    db: &Connection,
    v2: bool,
    scope: Option<&HashSet<String>>,
) -> Result<HashMap<String, String>> {
    let mut hashes = HashMap::new();
    let session_table = if v2 { "session_v2" } else { "session" };
    let session_rows = paging::scoped_rows(
        db,
        &format!("SELECT * FROM {session_table} ORDER BY id"),
        "id",
        scope,
    )?;
    let parent_column = rows(db, &format!("PRAGMA table_info({session_table})"))?
        .iter()
        .any(|row| row["name"] == "parent_id");
    let selected = selected_ids(&session_rows, v2, parent_column);
    for row in session_rows
        .into_iter()
        .filter(|row| selected.contains(&string(&row["id"])))
    {
        let mut hash = Sha256::new();
        hash.update(if v2 {
            b"opencode-v2".as_slice()
        } else {
            b"opencode-v1".as_slice()
        });
        hash.update(serde_json::to_vec(&row)?);
        hashes.insert(string(&row["id"]), hash);
    }
    let message_table = if v2 { "session_message" } else { "message" };
    if table(db, message_table)? {
        let order = if v2 {
            "session_id,seq"
        } else {
            "session_id,time_created,id"
        };
        let mut message_sessions = HashMap::new();
        for row in paging::scoped_rows(
            db,
            &format!("SELECT * FROM {message_table} ORDER BY {order}"),
            "session_id",
            scope,
        )? {
            let id = string(&row["session_id"]);
            if let Some(hash) = hashes.get_mut(&id) {
                hash.update(serde_json::to_vec(&row)?);
                message_sessions.insert(string(&row["id"]), id);
            }
        }
        if !v2 {
            for row in paging::scoped_rows(
                db,
                "SELECT * FROM part ORDER BY message_id,time_created,id",
                "part",
                scope,
            )? {
                if let Some(id) = message_sessions.get(&string(&row["message_id"]))
                    && let Some(hash) = hashes.get_mut(id)
                {
                    hash.update(serde_json::to_vec(&row)?);
                }
            }
        }
    }
    Ok(hashes
        .into_iter()
        .map(|(id, hash)| (id, format!("{:x}", hash.finalize())))
        .collect())
}
fn raw_usage(
    db: &Connection,
    pricing: &Pricing,
    previous: Option<&DatabaseSnapshot>,
    changed: &HashSet<String>,
    fingerprints: &HashMap<String, String>,
) -> Result<HashMap<String, SessionStats>> {
    let mut usage = previous.map(|p| p.raw_usage.clone()).unwrap_or_default();
    usage.retain(|id, _| fingerprints.contains_key(id) && !changed.contains(id));
    if !table(db, "message")? {
        return Ok(usage);
    }
    let mut by_session: HashMap<String, Vec<Message>> = HashMap::new();
    for row in paging::scoped_rows(
        db,
        "SELECT * FROM message ORDER BY session_id,time_created,id",
        "session_id",
        Some(changed),
    )? {
        let id = string(&row["session_id"]);
        if !changed.contains(&id) {
            continue;
        }
        let raw = data(&row)?;
        if !content::internal(&raw["type"]) {
            by_session.entry(id).or_default().push(content::v1_message(
                &row,
                &raw,
                Vec::new(),
                pricing,
            ));
        }
    }
    for (id, messages) in by_session {
        usage.insert(id, content::stats(&messages));
    }
    Ok(usage)
}
