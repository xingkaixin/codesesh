use super::{ProjectScope, SearchOptions};
use rusqlite::types::Value;

#[derive(Default)]
pub struct Filters {
    pub clauses: Vec<String>,
    pub params: Vec<Value>,
}
impl Filters {
    pub fn text(&mut self, clause: &str, value: &str) {
        self.clauses.push(clause.into());
        self.params.push(value.to_owned().into());
    }
    pub fn where_sql(&self) -> String {
        if self.clauses.is_empty() {
            String::new()
        } else {
            format!(" AND {}", self.clauses.join(" AND "))
        }
    }
}

pub fn like_pattern(value: &str) -> String {
    let mut result = String::from("%");
    for c in value.trim().to_lowercase().chars() {
        if matches!(c, '\\' | '%' | '_') {
            result.push('\\');
        }
        result.push(c);
    }
    result.push('%');
    result
}

pub fn normalize_file(value: &str) -> &str {
    {
        let value = value.trim();
        let value = value.strip_prefix('"').unwrap_or(value);
        value.strip_suffix('"').unwrap_or(value)
    }
}

pub fn file_filter(filters: &mut Filters, value: &str) {
    let path = normalize_file(value);
    if path.encode_utf16().count() >= 3 {
        filters.text(
            "fa.rowid IN (SELECT rowid FROM session_file_activity_path_fts WHERE path MATCH ?)",
            &format!("\"{}\"", path.replace('"', "\"\"")),
        );
    } else {
        filters.text("LOWER(fa.path) LIKE ? ESCAPE '\\'", &like_pattern(value));
    }
}

fn project_scope(filters: &mut Filters, scope: &ProjectScope) {
    filters.clauses.push("((s.project_identity_kind = ? AND s.project_identity_key = ?) OR (s.directory <> '' AND (codesesh_project_scope_path(s.directory) = ? OR instr(codesesh_project_scope_path(s.directory), ? || '/') = 1 OR instr(?, codesesh_project_scope_path(s.directory) || '/') = 1)))".into());
    filters.params.extend([
        scope.identity.kind.clone().into(),
        scope.identity.key.clone().into(),
        scope.path.clone().into(),
        scope.path.clone().into(),
        scope.path.clone().into(),
    ]);
}

pub fn build(options: &SearchOptions) -> Filters {
    let mut filters = Filters::default();
    if let Some(scope) = &options.query_scope {
        if !scope.agents.is_empty() {
            filters.clauses.push(format!(
                "s.agent_name IN ({})",
                vec!["?"; scope.agents.len()].join(",")
            ));
            filters
                .params
                .extend(scope.agents.iter().map(|v| Value::Text(v.clone())));
        }
        if let Some(project) = &scope.project_scope {
            project_scope(&mut filters, project);
        }
    }
    if let Some(agent) = &options.agent {
        filters.text("s.agent_name = ?", agent);
    }
    match (&options.project_kind, &options.project_key) {
        (Some(kind), Some(key)) => {
            filters.text("s.project_identity_kind = ?", kind);
            filters.text("s.project_identity_key = ?", key);
        }
        (None, None) => (),
        _ => filters.clauses.push("0".into()),
    }
    if let Some(scope) = &options.project_scope {
        project_scope(&mut filters, scope);
    }
    if let Some(project) = &options.project {
        filters.clauses.push("(LOWER(s.project_identity_key) LIKE ? ESCAPE '\\' OR LOWER(s.project_display_name) LIKE ? ESCAPE '\\' OR LOWER(s.directory) LIKE ? ESCAPE '\\')".into());
        filters
            .params
            .extend(std::iter::repeat_n(Value::Text(like_pattern(project)), 3));
    }
    for tag in &options.tags {
        filters.text("s.smart_tags_json LIKE ?", &format!("%\"{tag}\"%"));
    }
    for tool in &options.tools {
        let tool = tool.trim().to_lowercase();
        if !tool.is_empty() {
            filters.text("EXISTS (SELECT 1 FROM message_tools mt WHERE mt.tool_name = ? AND mt.agent_name = s.agent_name AND mt.session_id = s.session_id)",&tool);
        }
    }
    if options.file.is_some() || options.file_kind.is_some() {
        let mut files = Filters::default();
        files.clauses.extend([
            "fa.agent_name = s.agent_name".into(),
            "fa.session_id = s.session_id".into(),
        ]);
        if let Some(file) = &options.file {
            file_filter(&mut files, file);
        }
        if let Some(kind) = &options.file_kind {
            files.text("fa.kind = ?", kind);
        }
        filters.clauses.push(format!(
            "EXISTS (SELECT 1 FROM session_file_activity fa WHERE {})",
            files.clauses.join(" AND ")
        ));
        filters.params.extend(files.params);
    }
    for (clause, value) in [
        ("s.activity_time >= ?", options.from),
        ("s.activity_time <= ?", options.to),
    ] {
        if let Some(value) = value {
            filters.clauses.push(clause.into());
            filters.params.push(value.into());
        }
    }
    let mut costs = Vec::new();
    if let Some(value) = options.cost_min {
        costs.push(if options.cost_min_exclusive {
            "SUM(own_cost) > ?"
        } else {
            "SUM(own_cost) >= ?"
        });
        filters.params.push(value.into());
    }
    if let Some(value) = options.cost_max {
        costs.push(if options.cost_max_exclusive {
            "SUM(own_cost) < ?"
        } else {
            "SUM(own_cost) <= ?"
        });
        filters.params.push(value.into());
    }
    if !costs.is_empty() {
        filters.clauses.push(format!("EXISTS (WITH RECURSIVE session_subtree(agent_name,session_id,own_cost) AS (SELECT s.agent_name,s.session_id,s.total_cost UNION SELECT child.agent_name,child.session_id,child.total_cost FROM sessions child JOIN session_subtree parent ON child.parent_agent_name = parent.agent_name AND child.parent_session_id = parent.session_id WHERE child.publication_id IS NULL) SELECT SUM(own_cost) FROM session_subtree HAVING {})",costs.join(" AND ")));
    }
    filters
}
