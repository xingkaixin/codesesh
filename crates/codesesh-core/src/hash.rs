use std::fmt::Write;

pub(crate) fn hex(bytes: &[u8]) -> String {
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        write!(output, "{byte:02x}").unwrap();
    }
    output
}

#[cfg(test)]
mod tests {
    use sha2::{Digest, Sha256};

    #[test]
    fn sha256_preserves_lowercase_zero_padded_encoding() {
        assert_eq!(super::hex(&[0, 1, 15, 16, 255]), "00010f10ff");
        assert_eq!(
            super::hex(&Sha256::digest(b"abc")),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }
}
