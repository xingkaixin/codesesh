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
            if entry.file_name() == "precompressed" {
                continue;
            }
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

fn fnv1a_etag(bytes: &[u8]) -> String {
    let mut hash: u128 = 0x6c62_272e_07bb_0142_62b8_2175_6295_c58d;
    for &byte in bytes {
        hash ^= u128::from(byte);
        hash = hash.wrapping_mul(0x0000_0000_0100_0000_0000_0000_0000_013b);
    }
    format!("\"{:032x}\"", hash)
}

fn main() {
    println!("cargo:rerun-if-env-changed=CODESESH_SKIP_WEB_ASSETS");
    let manifest = env::var_os("CARGO_MANIFEST_DIR").unwrap();
    let root = Path::new(&manifest).join("../../apps/web/dist");
    let precompressed = root.join("precompressed");
    println!("cargo:rerun-if-changed={}", root.display());
    let output = env::var_os("OUT_DIR").unwrap();
    let output = Path::new(&output);
    let header = concat!(
        "#[derive(Clone, Copy, Debug, PartialEq, Eq)]\n",
        "pub struct EmbeddedAsset {\n",
        "    pub name: &'static str,\n",
        "    pub raw: &'static [u8],\n",
        "    pub br: Option<&'static [u8]>,\n",
        "    pub gz: Option<&'static [u8]>,\n",
        "    pub etag: &'static str,\n",
        "    pub etag_br: &'static str,\n",
        "    pub etag_gz: &'static str,\n",
        "}\n",
    );
    if env::var("CODESESH_SKIP_WEB_ASSETS").as_deref() == Ok("1") {
        assert!(
            env::var("PROFILE").as_deref() != Ok("release"),
            "Release builds must embed Web assets; unset CODESESH_SKIP_WEB_ASSETS"
        );
        println!("cargo:warning=Web assets explicitly disabled for this debug build");
        fs::write(
            output.join("web_assets.rs"),
            format!("{header}static WEB_ASSETS: &[EmbeddedAsset] = &[];\n"),
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
    let mut source = format!("{header}static WEB_ASSETS: &[EmbeddedAsset] = &[\n");
    let mut has_precompressed_js = false;
    for (index, name) in files.iter().enumerate() {
        let raw_path = root.join(name);
        let raw_bytes = fs::read(&raw_path).expect("Cannot read Web asset");
        let etag = fnv1a_etag(&raw_bytes);
        let etag_hash = etag.trim_matches('"');
        let etag_br = format!("\"{etag_hash}-br\"");
        let etag_gz = format!("\"{etag_hash}-gz\"");
        fs::write(embedded.join(index.to_string()), &raw_bytes).expect("Cannot write Web asset");

        let br_src = precompressed.join(format!("{name}.br"));
        let has_br = br_src.is_file();
        let br_expr = if has_br {
            fs::copy(&br_src, embedded.join(format!("{index}.br")))
                .expect("Cannot copy precompressed .br asset");
            format!("Some(include_bytes!(concat!(env!(\"OUT_DIR\"), \"/web-assets/{index}.br\")))")
        } else {
            "None".to_owned()
        };

        let gz_src = precompressed.join(format!("{name}.gz"));
        let has_gz = gz_src.is_file();
        let gz_expr = if has_gz {
            fs::copy(&gz_src, embedded.join(format!("{index}.gz")))
                .expect("Cannot copy precompressed .gz asset");
            format!("Some(include_bytes!(concat!(env!(\"OUT_DIR\"), \"/web-assets/{index}.gz\")))")
        } else {
            "None".to_owned()
        };

        if name.starts_with("assets/") && name.ends_with(".js") && has_br && has_gz {
            has_precompressed_js = true;
        }

        source.push_str(&format!(
            "EmbeddedAsset {{ name: {name:?}, raw: include_bytes!(concat!(env!(\"OUT_DIR\"), \"/web-assets/{index}\")), br: {br_expr}, gz: {gz_expr}, etag: {etag:?}, etag_br: {etag_br:?}, etag_gz: {etag_gz:?} }},\n"
        ));
    }
    assert!(
        has_precompressed_js,
        "Precompressed Web assets are missing under {}; run pnpm --filter @codesesh/web build",
        precompressed.display()
    );
    source.push_str("];\n");
    fs::write(output.join("web_assets.rs"), source).unwrap();
}
