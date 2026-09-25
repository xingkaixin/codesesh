use icu_collator::{
    Collator, CollatorBorrowed,
    options::{AlternateHandling, CollatorOptions, Strength},
};
use icu_locale::locale;
use std::{cmp::Ordering, sync::LazyLock};

static COLLATOR: LazyLock<CollatorBorrowed<'static>> = LazyLock::new(|| {
    let mut options = CollatorOptions::default();
    options.strength = Some(Strength::Tertiary);
    options.alternate_handling = Some(AlternateHandling::NonIgnorable);
    Collator::try_new(locale!("en-US").into(), options).expect("compiled English collation data")
});

pub fn compare(left: &str, right: &str) -> Ordering {
    COLLATOR.compare(left, right)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_node_24_21_icu_78_3_en_us_sort() {
        // Frozen from Node localeCompare('en-US'); stable equal entries stay in source order.
        let mut input = vec![
            "z", "Z", "a", "A", "á", "ä", "å", "é", "e\u{301}", "e", "E", "a2", "a10", "a-1",
            "a_1", "a 1", "a.1", "/", "_", "-", ".", "!", "?", "中文", "中国", "中", "文", "会话",
            "🦀", "😀", "🚀", "💻", "😃", "ß", "ss", "Ｓ", "s", "S", "", "\0", "\u{200b}",
        ];
        let expected = vec![
            "", "\0", "\u{200b}", "_", "-", "!", "?", ".", "/", "💻", "🦀", "😀", "😃", "🚀", "a",
            "A", "á", "å", "ä", "a 1", "a_1", "a-1", "a.1", "a10", "a2", "e", "E", "é", "e\u{301}",
            "s", "S", "Ｓ", "ss", "ß", "z", "Z", "中", "中国", "中文", "会话", "文",
        ];
        input.sort_by(|a, b| compare(a, b));
        assert_eq!(input, expected);
        assert_eq!(compare("é", "e\u{301}"), Ordering::Equal);
        assert_eq!(compare("", "\0"), Ordering::Equal);
        assert_eq!(compare("a2", "a10"), Ordering::Greater);
    }
}
