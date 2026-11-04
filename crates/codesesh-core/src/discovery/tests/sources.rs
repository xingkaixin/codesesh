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
