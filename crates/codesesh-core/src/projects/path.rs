pub fn windows(path: &str) -> bool {
    path.starts_with("\\\\")
        || (path.as_bytes().get(1) == Some(&b':')
            && matches!(path.as_bytes().get(2), Some(b'/' | b'\\')))
}

pub fn normalize(path: &str) -> String {
    if path.is_empty() {
        return String::new();
    }
    let win = windows(path) || (!path.starts_with('/') && cfg!(windows));
    let mut value = if win {
        path.replace('\\', "/")
    } else {
        path.to_owned()
    };
    if !(value.starts_with('/') || win && value.as_bytes().get(1) == Some(&b':')) {
        value = format!(
            "{}/{}",
            std::env::current_dir()
                .unwrap_or_default()
                .to_string_lossy()
                .replace('\\', "/"),
            value
        );
    }
    let (prefix, rest) = if win && value.starts_with("//") {
        let mut parts = value[2..].splitn(3, '/');
        (
            format!(
                "//{}/{}",
                parts.next().unwrap_or(""),
                parts.next().unwrap_or("")
            ),
            parts.next().unwrap_or("").to_owned(),
        )
    } else if win && value.as_bytes().get(1) == Some(&b':') {
        (
            value[..2].to_owned(),
            value[2..].trim_start_matches('/').to_owned(),
        )
    } else {
        (String::new(), value.trim_start_matches('/').to_owned())
    };
    let mut parts = Vec::new();
    for part in rest.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            _ => parts.push(part),
        }
    }
    let result = format!("{prefix}/{}", parts.join("/"));
    if win {
        result.replace('/', "\\")
    } else {
        result
    }
}

pub fn join(base: &str, name: &str) -> String {
    normalize(&format!(
        "{}{name}",
        if base.ends_with('/') || (windows(base) && base.ends_with('\\')) {
            base.to_owned()
        } else {
            format!("{base}{}", if windows(base) { "\\" } else { "/" })
        }
    ))
}

pub fn parent(path: &str) -> String {
    let win = windows(path);
    let separator = if win { '\\' } else { '/' };
    let trimmed = path.trim_end_matches(separator);
    if win && trimmed.starts_with("\\\\") && trimmed[2..].split('\\').count() <= 2 {
        return path.to_owned();
    }
    match trimmed.rfind(separator) {
        Some(0) => "/".into(),
        Some(2) if win && trimmed.as_bytes().get(1) == Some(&b':') => trimmed[..3].into(),
        Some(index) => trimmed[..index].into(),
        None => path.to_owned(),
    }
}

pub fn fallback_display_name(input: &str) -> String {
    if input == "/" {
        return "(root)".into();
    }
    let trimmed = input.trim_end_matches(['/', '\\']);
    trimmed
        .rsplit(['/', '\\'])
        .find(|part| !part.is_empty())
        .unwrap_or(trimmed)
        .into()
}
