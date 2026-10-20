//! The embedded name map freezes Node 24.21.0 / ICU 78.3 canonicalization.

use chrono::{DateTime, Datelike, Days, FixedOffset, NaiveDate, TimeZone, Timelike, Utc};
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
    pub(crate) fn slot(&self, time: DateTime<Utc>) -> usize {
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
    pub fn date(&self, time: f64) -> NaiveDate {
        let time = crate::time::date_time_clip(time)
            .and_then(DateTime::from_timestamp_millis)
            .unwrap_or(DateTime::UNIX_EPOCH);
        match self.zone {
            Zone::Named(zone) => time.with_timezone(&zone).date_naive(),
            Zone::Offset(zone) => time.with_timezone(&zone).date_naive(),
        }
    }
    pub fn start_of_day(&self, time: f64) -> f64 {
        match self.zone {
            Zone::Named(zone) => start_of_day(&zone, time),
            Zone::Offset(zone) => start_of_day(&zone, time),
        }
    }
    pub fn add_days(&self, time: f64, days: i64) -> Option<f64> {
        match self.zone {
            Zone::Named(zone) => add_days(&zone, time, days),
            Zone::Offset(zone) => add_days(&zone, time, days),
        }
    }
}

fn start_of_day<Z: TimeZone>(zone: &Z, time: f64) -> f64 {
    zone.timestamp_millis_opt(time as i64)
        .single()
        .and_then(|d| {
            zone.from_local_datetime(&d.date_naive().and_hms_opt(0, 0, 0)?)
                .earliest()
        })
        .map(|d| d.timestamp_millis() as f64)
        .unwrap_or(time)
}

fn add_days<Z: TimeZone>(zone: &Z, time: f64, days: i64) -> Option<f64> {
    let date = zone.timestamp_millis_opt(time as i64).single()?;
    let date = if days >= 0 {
        date.checked_add_days(Days::new(days as u64))?
    } else {
        date.checked_sub_days(Days::new(days.unsigned_abs()))?
    };
    Some(date.timestamp_millis() as f64)
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
