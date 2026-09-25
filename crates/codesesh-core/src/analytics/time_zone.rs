//! The embedded name map freezes Node 24.21.0 / ICU 78.3 canonicalization.

use chrono::{DateTime, Datelike, FixedOffset, Timelike, Utc};
use chrono_tz::Tz;
use std::{collections::HashMap, str::FromStr, sync::OnceLock};

#[derive(Clone, Debug)]
enum Zone {
    Named(Tz),
    Offset(FixedOffset),
}

#[derive(Clone, Debug)]
pub struct DashboardTimeZone {
    name: String,
    zone: Zone,
}

impl FromStr for DashboardTimeZone {
    type Err = &'static str;
    fn from_str(input: &str) -> Result<Self, Self::Err> {
        const ERROR: &str = "timeZone must be a valid IANA time zone";
        if input.starts_with(['+', '-', '−']) {
            let normalized = input.replace('−', "-");
            let bytes = normalized.as_bytes();
            let digits = match bytes.len() {
                3 => normalized[1..].to_owned() + "00",
                5 => normalized[1..].to_owned(),
                6 if bytes[3] == b':' => format!("{}{}", &normalized[1..3], &normalized[4..]),
                _ => return Err(ERROR),
            };
            if !digits.bytes().all(|b| b.is_ascii_digit()) {
                return Err(ERROR);
            }
            let hours = digits[..2].parse::<i32>().map_err(|_| ERROR)?;
            let minutes = digits[2..].parse::<i32>().map_err(|_| ERROR)?;
            if hours > 23 || minutes > 59 {
                return Err(ERROR);
            }
            let sign = if bytes[0] == b'-' && (hours > 0 || minutes > 0) {
                '-'
            } else {
                '+'
            };
            let seconds = (hours * 3600 + minutes * 60) * if sign == '-' { -1 } else { 1 };
            return Ok(Self {
                name: format!("{sign}{hours:02}:{minutes:02}"),
                zone: Zone::Offset(FixedOffset::east_opt(seconds).ok_or(ERROR)?),
            });
        }
        static NAMES: OnceLock<HashMap<String, Option<String>>> = OnceLock::new();
        let names = NAMES.get_or_init(|| {
            serde_json::from_str(include_str!("time-zones.json"))
                .expect("embedded Node reference time zones")
        });
        let name = names
            .get(&input.to_ascii_lowercase())
            .and_then(Option::as_ref)
            .ok_or(ERROR)?;
        let zone = name.parse::<Tz>().map_err(|_| ERROR)?;
        Ok(Self {
            name: name.clone(),
            zone: Zone::Named(zone),
        })
    }
}

impl DashboardTimeZone {
    pub fn name(&self) -> &str {
        &self.name
    }
    pub fn slot(&self, time: DateTime<Utc>) -> usize {
        match self.zone {
            Zone::Named(zone) => {
                let time = time.with_timezone(&zone);
                time.weekday().num_days_from_sunday() as usize * 12 + time.hour() as usize / 2
            }
            Zone::Offset(zone) => {
                let time = time.with_timezone(&zone);
                time.weekday().num_days_from_sunday() as usize * 12 + time.hour() as usize / 2
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn matches_intl_canonical_names_and_offset_boundaries() {
        for (input, expected) in [
            ("us/eASTern", "America/New_York"),
            ("etc/utc", "UTC"),
            ("CET", "Europe/Brussels"),
            ("+01", "+01:00"),
            ("−0100", "-01:00"),
            ("-00:00", "+00:00"),
        ] {
            assert_eq!(input.parse::<DashboardTimeZone>().unwrap().name(), expected);
        }
        for input in ["+24:00", "+01:60", "Invalid/Zone", "+é0", "-０1"] {
            assert!(input.parse::<DashboardTimeZone>().is_err());
        }
    }
}
