use super::Options;
use chrono::{DateTime, Local, NaiveDate, TimeZone};

#[derive(Clone)]
pub struct Params {
    pub pairs: Vec<(String, String)>,
}
impl Params {
    pub fn new(query: Option<&str>) -> Self {
        Self {
            pairs: url::form_urlencoded::parse(query.unwrap_or("").as_bytes())
                .into_owned()
                .collect(),
        }
    }
    pub fn get(&self, key: &str) -> Option<&str> {
        self.pairs
            .iter()
            .find(|(k, _)| k == key)
            .map(|(_, v)| v.as_str())
    }
    pub fn optional(&self, key: &str) -> Option<&str> {
        self.get(key).map(str::trim).filter(|v| !v.is_empty())
    }
    pub fn values(&self, keys: &[&str]) -> Vec<String> {
        keys.iter()
            .flat_map(|key| {
                self.pairs
                    .iter()
                    .filter(move |(k, _)| k == key)
                    .flat_map(|(_, v)| v.split(','))
                    .map(str::trim)
                    .filter(|v| !v.is_empty())
                    .map(str::to_owned)
            })
            .collect()
    }
    pub fn limit(&self, default: usize, max: usize) -> Result<usize, String> {
        codesesh_core::query::parse_limit(self.get("limit"), default, max).map_err(str::to_owned)
    }
    pub fn project(&self) -> Result<Option<(&str, &str)>, String> {
        codesesh_core::query::parse_project_filter(self.get("projectKind"), self.get("projectKey"))
            .map_err(str::to_owned)
    }
    pub fn window(&self, options: &Options) -> Result<(Option<f64>, Option<f64>), String> {
        let parse = |key, fallback| match self.optional(key) {
            None => Ok(fallback),
            Some(v) => date(v)
                .map(|v| Some(v as f64))
                .ok_or_else(|| format!("{key} must be a valid date")),
        };
        let from = parse("from", options.default_from)?;
        let to = parse("to", options.default_to)?;
        if from.zip(to).is_some_and(|(a, b)| a > b) {
            return Err("from must not be after to".into());
        }
        Ok((from, to))
    }
}

pub fn date(value: &str) -> Option<i64> {
    if let Ok(value) = DateTime::parse_from_rfc3339(value) {
        return Some(value.timestamp_millis());
    }
    if let Ok(value) = DateTime::parse_from_rfc2822(value) {
        return Some(value.timestamp_millis());
    }
    if let Ok(value) = NaiveDate::parse_from_str(value, "%Y-%m-%d") {
        return Some(value.and_hms_opt(0, 0, 0)?.and_utc().timestamp_millis());
    }
    for format in [
        "%Y-%m-%dT%H:%M:%S%.f",
        "%Y-%m-%d %H:%M:%S%.f",
        "%Y-%m-%dT%H:%M",
    ] {
        if let Ok(value) = chrono::NaiveDateTime::parse_from_str(value, format) {
            return Local
                .from_local_datetime(&value)
                .earliest()
                .map(|v| v.timestamp_millis());
        }
    }
    None
}
