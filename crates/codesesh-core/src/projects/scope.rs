use super::{compute_identity, matches_project_identity, normalize_project_directory};
use crate::contract::{ProjectIdentity, SessionHead};

#[derive(Clone, Debug)]
pub struct ProjectScopeMatcher {
    pub identity: ProjectIdentity,
    pub path: String,
}
pub fn normalize_project_scope_path(path: &str) -> String {
    normalize_project_directory(path).replace('\\', "/")
}
pub fn create_project_scope_matcher(path: &str) -> ProjectScopeMatcher {
    create_project_scope_matcher_from_identity(path, compute_identity(path))
}
pub fn create_project_scope_matcher_from_identity(
    path: &str,
    identity: ProjectIdentity,
) -> ProjectScopeMatcher {
    ProjectScopeMatcher {
        identity,
        path: normalize_project_scope_path(path),
    }
}
pub fn matches_project_scope(session: &SessionHead, scope: &ProjectScopeMatcher) -> bool {
    if matches_project_identity(&session.project_identity, &scope.identity) {
        return true;
    }
    if session.directory.is_empty() {
        return false;
    }
    let path = normalize_project_scope_path(&session.directory);
    path == scope.path
        || path.starts_with(&format!("{}/", scope.path))
        || scope.path.starts_with(&format!("{path}/"))
}
pub fn filter_sessions_by_project_scope<'a>(
    sessions: &'a [SessionHead],
    query_path: &str,
) -> Vec<&'a SessionHead> {
    let scope = create_project_scope_matcher(query_path);
    sessions
        .iter()
        .filter(|session| matches_project_scope(session, &scope))
        .collect()
}
