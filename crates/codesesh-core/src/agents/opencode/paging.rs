use super::*;

pub fn enumerate_session_keys(
    path: &Path,
    agent: &str,
    supports_v2: bool,
) -> Result<Vec<(String, f64)>> {
    if !path.exists() {
        return Ok(Vec::new());
    }
    let db = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .with_context(|| format!("enumerating {agent} at {}", path.display()))?;
    db.execute_batch("BEGIN")?;
    let v2 = supports_v2 && has_v2(&db)?;
    if v2 {
        db.prepare("SELECT id,parent_id,fork_session_id,title,directory,path,version,summary_files,time_created,time_updated,cost,tokens_input,tokens_output,tokens_reasoning,tokens_cache_read,tokens_cache_write FROM session_v2 LIMIT 0")?;
    } else {
        db.prepare("SELECT id,title,time_created,time_updated,slug,directory,version,summary_files FROM session LIMIT 0")?;
    }
    let rows = metadata(&db, v2)?;
    let known: HashSet<_> = rows.iter().map(|row| string(&row["id"])).collect();
    let mut roots = rows
        .into_iter()
        .filter(|row| {
            if v2 {
                row["parent_id"].as_str().is_none_or(|parent| {
                    parent.is_empty() || parent == string(&row["id"]) || !known.contains(parent)
                })
            } else {
                row["parent_id"].is_null() && row["task_type"] != "subagent_child"
            }
        })
        .collect::<Vec<_>>();
    roots.sort_by(|a, b| {
        activity(b)
            .total_cmp(&activity(a))
            .then_with(|| number(&b["time_created"]).total_cmp(&number(&a["time_created"])))
            .then_with(|| crate::locale::compare(&string(&b["id"]), &string(&a["id"])))
    });
    let result = roots
        .into_iter()
        .filter_map(|row| {
            let id = string(&row["id"]);
            (!id.is_empty()).then_some((id, activity(&row)))
        })
        .collect();
    db.execute_batch("COMMIT")?;
    Ok(result)
}
pub fn scan_selected_database(
    path: &Path,
    agent: &str,
    supports_v2: bool,
    pricing: &Pricing,
    selected: &HashSet<String>,
) -> Result<Vec<ParsedSession>> {
    Ok(scan_selected_snapshot(path, agent, supports_v2, pricing, selected, None)?.sessions)
}
pub fn scan_selected_snapshot(
    path: &Path,
    agent: &str,
    supports_v2: bool,
    pricing: &Pricing,
    selected: &HashSet<String>,
    previous: Option<&DatabaseSnapshot>,
) -> Result<DatabaseSnapshot> {
    incremental::refresh_scoped(path, agent, supports_v2, pricing, previous, Some(selected))
}
fn activity(row: &Value) -> f64 {
    row.get("time_updated")
        .filter(|v| !v.is_null())
        .map(number)
        .unwrap_or_else(|| number(&row["time_created"]))
}
pub(super) fn metadata(db: &Connection, v2: bool) -> Result<Vec<Value>> {
    let table = if v2 { "session_v2" } else { "session" };
    let columns = rows(db, &format!("PRAGMA table_info({table})"))?;
    let has = |name: &str| columns.iter().any(|row| row["name"] == name);
    let parent = if has("parent_id") {
        "parent_id"
    } else {
        "NULL AS parent_id"
    };
    let task = if !has("parent_id") && has("task_type") {
        "task_type"
    } else {
        "NULL AS task_type"
    };
    rows(
        db,
        &format!("SELECT id,{parent},{task},time_created,time_updated FROM {table}"),
    )
}
pub(super) fn expanded_scope(
    db: &Connection,
    v2: bool,
    selected: &HashSet<String>,
    previous: Option<&DatabaseSnapshot>,
) -> Result<HashSet<String>> {
    let mut children: HashMap<String, Vec<String>> = HashMap::new();
    for row in metadata(db, v2)? {
        if let Some(parent) = row["parent_id"].as_str() {
            children
                .entry(parent.into())
                .or_default()
                .push(string(&row["id"]));
        }
    }
    if let Some(previous) = previous {
        for (id, detail) in &previous.base_details {
            if let Some(parent) = &detail.head.parent_reference {
                children
                    .entry(parent.session_id.clone())
                    .or_default()
                    .push(id.clone());
            }
        }
    }
    let mut scope = selected.clone();
    let mut pending = selected.iter().cloned().collect::<Vec<_>>();
    while let Some(id) = pending.pop() {
        for child in children.get(&id).into_iter().flatten() {
            if scope.insert(child.clone()) {
                pending.push(child.clone());
            }
        }
    }
    Ok(scope)
}
pub(super) fn scoped_rows(
    db: &Connection,
    query: &str,
    column: &str,
    scope: Option<&HashSet<String>>,
) -> Result<Vec<Value>> {
    let Some(scope) = scope else {
        return rows(db, query);
    };
    let ids = serde_json::to_string(&scope.iter().collect::<Vec<_>>())?;
    let predicate = if column == "part" {
        "message_id IN (SELECT id FROM message WHERE session_id IN (SELECT value FROM json_each(?1)))".to_owned()
    } else {
        format!("{column} IN (SELECT value FROM json_each(?1))")
    };
    let (select, order) = query.split_once(" ORDER BY ").unwrap_or((query, ""));
    let query = format!(
        "{select} WHERE {predicate}{}",
        if order.is_empty() {
            String::new()
        } else {
            format!(" ORDER BY {order}")
        }
    );
    bound_rows(db, &query, [ids])
}
