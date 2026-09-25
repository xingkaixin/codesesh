include!(concat!(env!("OUT_DIR"), "/web_assets.rs"));

pub type Asset = (&'static str, &'static [u8]);

fn key(path: &str) -> Option<&str> {
    let path = path.strip_prefix('/').unwrap_or(path);
    if path.contains(['\\', '\0', '?', '#'])
        || path
            .split('/')
            .any(|segment| segment == "." || segment == "..")
        || path.contains("//")
        || path.starts_with('/')
    {
        return None;
    }
    Some(path)
}

pub fn lookup(path: &str) -> Option<Asset> {
    let name = key(path)?;
    let index = WEB_ASSETS
        .binary_search_by_key(&name, |(name, _)| name)
        .ok()?;
    let (name, bytes) = WEB_ASSETS[index];
    Some((mime(name), bytes))
}

pub fn spa(path: &str) -> Option<Asset> {
    key(path)?;
    lookup(path).or_else(|| lookup("index.html"))
}

fn mime(path: &str) -> &'static str {
    match path.rsplit('.').next().unwrap_or("") {
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" | "map" => "application/json; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "ico" => "image/x-icon",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "txt" => "text/plain; charset=utf-8",
        "wasm" => "application/wasm",
        _ => "application/octet-stream",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn asset_paths_cannot_escape_the_embedded_table() {
        for path in [
            "../index.html",
            "/../index.html",
            "/a/../index.html",
            "a\\index.html",
            "//index.html",
            "a//b",
            "a\0b",
        ] {
            assert!(lookup(path).is_none(), "{path:?}");
            assert!(spa(path).is_none(), "{path:?}");
        }
    }

    #[test]
    fn generated_web_assets_serve_index_and_keep_binary_bytes() {
        if WEB_ASSETS.is_empty() {
            return;
        }
        let index = lookup("index.html").expect("embedded Web index");
        assert_eq!(index.0, "text/html; charset=utf-8");
        assert!(!index.1.is_empty());
        assert_eq!(spa("/sessions/codex/example"), Some(index));
        assert_eq!(spa("/"), Some(index));
        for (name, bytes) in WEB_ASSETS {
            assert_eq!(lookup(&format!("/{name}")), Some((mime(name), *bytes)));
        }
    }

    #[test]
    fn executable_styles_and_fonts_have_browser_mime_types() {
        assert_eq!(mime("assets/main.js"), "text/javascript; charset=utf-8");
        assert_eq!(mime("assets/main.css"), "text/css; charset=utf-8");
        assert_eq!(mime("assets/font.woff2"), "font/woff2");
        assert_eq!(mime("icon/logo.svg"), "image/svg+xml");
        assert_eq!(mime("unknown.data"), "application/octet-stream");
    }
}
