use std::{borrow::Cow, collections::HashMap, sync::LazyLock};

static MULTIPLIERS: LazyLock<HashMap<String, HashMap<String, f64>>> = LazyLock::new(|| {
    serde_json::from_str(include_str!("data/service_tiers.json"))
        .expect("bundled service tier multipliers")
});

/// Names the price of a request served on a recorded service tier, such as `gpt-5.5@fast`.
pub fn priced_model<'a>(model: Option<&'a str>, tier: Option<&str>) -> Option<Cow<'a, str>> {
    let model = model?;
    Some(match tier {
        Some("fast" | "priority") => Cow::Owned(format!("{model}@fast")),
        Some("flex") => Cow::Owned(format!("{model}@flex")),
        _ => Cow::Borrowed(model),
    })
}

pub(super) fn split(model: &str) -> (&str, f64) {
    let Some((base, multipliers)) = model
        .rsplit_once('@')
        .and_then(|(base, tier)| Some((base, MULTIPLIERS.get(tier)?)))
    else {
        return (model, 1.0);
    };
    let normalized = super::normalize(base);
    let mut name = normalized.rsplit('/').next().unwrap_or_default();
    loop {
        if let Some(multiplier) = multipliers.get(name) {
            return (base, *multiplier);
        }
        let Some((variant_of, _)) = name.rsplit_once('-') else {
            return (base, 1.0);
        };
        name = variant_of;
    }
}
