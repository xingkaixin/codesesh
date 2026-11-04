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
