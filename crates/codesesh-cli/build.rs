use std::{env, fs, path::Path};

fn collect(root: &Path, directory: &Path, files: &mut Vec<String>) {
    for entry in fs::read_dir(directory).expect("Cannot read Web assets directory") {
        let entry = entry.expect("Cannot read Web asset entry");
        let file_type = entry.file_type().expect("Cannot read Web asset type");
        let path = entry.path();
        assert!(
            !file_type.is_symlink(),
            "Web assets must not contain symlinks: {}",
            path.display()
        );
        if file_type.is_dir() {
            collect(root, &path, files);
        } else if file_type.is_file() {
            let relative = path.strip_prefix(root).unwrap();
            let name = relative
                .to_str()
                .expect("Web asset filename must be valid UTF-8")
                .replace('\\', "/");
            files.push(name);
        }
    }
}

fn main() {
    println!("cargo:rerun-if-env-changed=CODESESH_SKIP_WEB_ASSETS");
    let manifest = env::var_os("CARGO_MANIFEST_DIR").unwrap();
    let root = Path::new(&manifest).join("../../apps/web/dist");
    println!("cargo:rerun-if-changed={}", root.display());
    let output = env::var_os("OUT_DIR").unwrap();
    let output = Path::new(&output);
    if env::var("CODESESH_SKIP_WEB_ASSETS").as_deref() == Ok("1") {
        assert!(
            env::var("PROFILE").as_deref() != Ok("release"),
            "Release builds must embed Web assets; unset CODESESH_SKIP_WEB_ASSETS"
        );
        println!("cargo:warning=Web assets explicitly disabled for this debug build");
        fs::write(
            output.join("web_assets.rs"),
            "static WEB_ASSETS: &[(&str, &[u8])] = &[];\n",
        )
        .unwrap();
        return;
    }
    assert!(
        root.join("index.html").is_file(),
        "Web build is missing: run pnpm --filter @codesesh/web build before Cargo. For debug-only backend checks, explicitly set CODESESH_SKIP_WEB_ASSETS=1"
    );
    let mut files = Vec::new();
    collect(&root, &root, &mut files);
    files.sort_unstable();
    let embedded = output.join("web-assets");
    fs::create_dir_all(&embedded).unwrap();
    let mut source = String::from("static WEB_ASSETS: &[(&str, &[u8])] = &[\n");
    for (index, name) in files.iter().enumerate() {
        fs::copy(root.join(name), embedded.join(index.to_string())).expect("Cannot copy Web asset");
        source.push_str(&format!(
            "({name:?}, include_bytes!(concat!(env!(\"OUT_DIR\"), \"/web-assets/{index}\"))),\n"
        ));
    }
    source.push_str("];\n");
    fs::write(output.join("web_assets.rs"), source).unwrap();
}
