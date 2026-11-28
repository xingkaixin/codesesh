use std::fmt::Write;

pub(crate) fn hex(bytes: &[u8]) -> String {
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        write!(output, "{byte:02x}").unwrap();
    }
    output
}

pub(crate) fn file_stamp(metadata: &std::fs::Metadata) -> std::io::Result<(f64, String)> {
    let time = metadata
        .modified()?
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    let mut stamp = format!(
        "{}:{}:{}",
        metadata.len(),
        time.as_secs(),
        time.subsec_nanos()
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        // APFS assigns st_dev dynamically on macOS reboot (invalidating all cached file
        // fingerprints), and ctime changes on metadata-only xattr/chmod updates.
        write!(stamp, ":{}", metadata.ino()).unwrap();
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        stamp.push_str(&format!(
            ":{}:{}",
            metadata.creation_time(),
            metadata.file_attributes()
        ));
    }
    Ok((time.as_secs_f64() * 1000.0, stamp))
}
