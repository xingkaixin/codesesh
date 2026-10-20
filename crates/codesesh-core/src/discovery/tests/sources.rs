use super::*;

#[test]
fn path_overrides_expand_and_fallbacks_preserve_precedence() {
    let temporary = tempfile::tempdir().unwrap();
    let mut env = environment(temporary.path());
    env.variables
        .insert("CODEX_HOME".into(), " ~/custom ".into());
    assert_eq!(env.data_root("codex"), Some(env.home.join("custom")));
    env.variables.insert("CODEX_HOME".into(), "relative".into());
    assert_eq!(env.data_root("codex"), Some(env.cwd.join("relative")));
    env.variables.insert("CODEX_HOME".into(), " \t ".into());
    assert_eq!(env.data_root("codex"), Some(env.home.join(".codex")));
    std::fs::create_dir_all(env.cwd.join("data/pi")).unwrap();
    assert_eq!(env.source("pi").unwrap().scan_path, env.cwd.join("data/pi"));
    std::fs::create_dir_all(env.home.join(".pi/agent/sessions")).unwrap();
    assert_eq!(
        env.source("pi").unwrap().scan_path,
        env.home.join(".pi/agent/sessions")
    );
}

#[test]
fn pi_paths_follow_upstream_overrides() {
    let temporary = tempfile::tempdir().unwrap();
    let mut env = environment(temporary.path());
    env.variables
        .insert("PI_CODING_AGENT_DIR".into(), "~/agent".into());
    let agent = env.home.join("agent");
    assert_eq!(env.source("pi").unwrap().scan_path, agent.join("sessions"));
    std::fs::create_dir_all(&agent).unwrap();
    std::fs::write(agent.join("settings.json"), r#"{"sessionDir":"relative"}"#).unwrap();
    assert_eq!(env.source("pi").unwrap().scan_path, agent.join("sessions"));
    std::fs::write(agent.join("settings.json"), r#"{"sessionDir":"~/stored"}"#).unwrap();
    assert_eq!(env.source("pi").unwrap().scan_path, env.home.join("stored"));
    env.variables
        .insert("PI_CODING_AGENT_SESSION_DIR".into(), "~/override".into());
    assert_eq!(
        env.source("pi").unwrap().scan_path,
        env.home.join("override")
    );
}

#[test]
fn platform_paths_and_opencode_override_match_existing_rules() {
    let temporary = tempfile::tempdir().unwrap();
    let mut env = environment(temporary.path());
    assert!(env.data_root("zcode").is_none());
    env.platform = "darwin".into();
    assert_eq!(
        env.data_root("deepchat"),
        Some(env.home.join("Library/Application Support/DeepChat"))
    );
    assert_eq!(env.data_root("zcode"), Some(env.home.join(".zcode")));
    env.platform = "win32".into();
    assert_eq!(env.data_home(), env.home.join("AppData/Local"));
    assert_eq!(
        env.source("opencode").unwrap().scan_path,
        env.home.join(".local/share/opencode/opencode.db")
    );
    env.variables
        .insert("OPENCODE_DB".into(), ":memory:".into());
    assert!(env.source("opencode").is_none());
    env.variables
        .insert("OPENCODE_DB".into(), "other.sqlite".into());
    assert_eq!(
        env.source("opencode").unwrap().scan_path,
        env.home.join(".local/share/opencode/other.sqlite")
    );
    assert_eq!(selected_sources(&env, &["CODEX".into()]).len(), 1);
}

#[test]
fn counts_and_registry_cover_all_nineteen_agents() {
    let catalog = agents::catalog_counts(&HashMap::from([("kimi".into(), 2), ("codex".into(), 3)]));
    assert_eq!(catalog.len(), 19);
    assert_eq!(catalog.iter().map(|agent| agent.count).sum::<usize>(), 5);
    assert_eq!(catalog.iter().filter(|agent| agent.available).count(), 2);
}

#[test]
fn every_catalog_entry_has_a_source_resolver_and_scanner() {
    let temporary = tempfile::tempdir().unwrap();
    let mut env = environment(temporary.path());
    env.platform = "darwin".into();
    env.variables.insert(
        "CURSOR_DATA_PATH".into(),
        temporary
            .path()
            .join("cursor")
            .to_string_lossy()
            .into_owned(),
    );
    let pricing = Pricing::bundled();
    for agent in agents::catalog(0) {
        let source = env
            .source(&agent.name)
            .unwrap_or_else(|| panic!("missing resolver for {}", agent.name));
        assert!(
            agents::scan_agent(&agent.name, &source.scan_path, &source.data_root, &pricing)
                .unwrap()
                .is_empty()
        );
    }
}
