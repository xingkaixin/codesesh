use anyhow::{Context, Result, bail};
use chrono::{Days, Local, NaiveDate, NaiveDateTime, TimeZone};
use clap::Parser;
use std::{net::Ipv4Addr, path::PathBuf};

#[derive(Parser)]
#[command(
    name = "codesesh",
    args_override_self = true,
    version,
    about = "Discover, aggregate, and visualize AI coding agent sessions"
)]
pub struct Args {
    #[arg(short = 'j', long)]
    pub json: bool,
    #[arg(short = 'a', long)]
    pub agent: Option<String>,
    #[arg(short = 'd', long, default_value = "7", default_missing_value="", num_args=0..=1, allow_negative_numbers = true)]
    pub days: String,
    #[arg(short = 'p', long, allow_negative_numbers = true)]
    pub port: Option<String>,
    #[arg(long, default_value = "127.0.0.1")]
    pub host: String,
    #[arg(long)]
    pub remote_access: bool,
    #[arg(long)]
    pub tls_cert: Option<PathBuf>,
    #[arg(long)]
    pub tls_key: Option<PathBuf>,
    #[arg(long)]
    pub trust_proxy: bool,
    #[arg(long)]
    pub public_url: Option<String>,
    #[arg(long = "noOpen", alias = "no-open")]
    pub no_open: bool,
    #[arg(long)]
    pub cwd: Option<String>,
    #[arg(long)]
    pub from: Option<String>,
    #[arg(long)]
    pub to: Option<String>,
    #[arg(short = 's', long)]
    pub session: Option<String>,
    #[arg(long)]
    pub trace: bool,
    #[arg(long = "no-cache", overrides_with = "cache")]
    pub no_cache: bool,
    #[arg(long, default_value="true", default_missing_value="true", num_args=0..=1, action=clap::ArgAction::Set, overrides_with="no_cache")]
    pub cache: bool,
    #[arg(long)]
    pub clear_cache: bool,
}

pub struct Plan {
    pub port: Option<u16>,
    pub from: Option<f64>,
    pub to: Option<f64>,
    pub days: Option<u32>,
    pub cwd: Option<String>,
    pub agents: Vec<String>,
    pub session: Option<(String, String)>,
    pub public_origin: Option<String>,
}

pub fn loopback(host: &str) -> bool {
    let host = host
        .strip_prefix('[')
        .and_then(|host| host.strip_suffix(']'))
        .unwrap_or(host);
    host.eq_ignore_ascii_case("localhost")
        || host == "::1"
        || host.parse::<Ipv4Addr>().is_ok_and(|ip| ip.is_loopback())
}

impl Args {
    pub fn plan(&self) -> Result<Plan> {
        if self.tls_cert.is_some() != self.tls_key.is_some() {
            bail!("TLS requires both --tls-cert and --tls-key.");
        }
        if self.tls_cert.is_some() && self.trust_proxy {
            bail!(
                "Use either --tls-cert/--tls-key or --trust-proxy, not both: only one of them terminates TLS."
            );
        }
        if self.trust_proxy && !loopback(&self.host) {
            bail!(
                "--trust-proxy requires a loopback --host so clients cannot reach the HTTP backend directly."
            );
        }
        if let (Some(cert), Some(key)) = (&self.tls_cert, &self.tls_key) {
            for path in [cert, key] {
                std::fs::read(path).with_context(|| "Unable to read the TLS certificate or key")?;
            }
        }
        let public_origin = if self.trust_proxy {
            let value = self
                .public_url
                .as_deref()
                .filter(|value| !value.is_empty())
                .context(
                    "--trust-proxy requires an HTTPS --public-url for browser startup links.",
                )?;
            let url =
                url::Url::parse(value).context("--public-url must be a valid HTTPS origin.")?;
            if url.scheme() != "https"
                || !url.username().is_empty()
                || url.password().is_some()
                || url.path() != "/"
                || url.query().is_some()
                || url.fragment().is_some()
            {
                bail!(
                    "--public-url must be an HTTPS origin without credentials, path, query, or fragment."
                );
            }
            Some(url.origin().ascii_serialization())
        } else {
            if self
                .public_url
                .as_ref()
                .is_some_and(|value| !value.is_empty())
            {
                bail!("--public-url requires --trust-proxy.");
            }
            None
        };
        if (!loopback(&self.host) || self.trust_proxy || self.tls_cert.is_some())
            && !self.remote_access
        {
            bail!(
                "Refusing to expose CodeSesh on {} without explicit remote access. Add --remote-access to continue.",
                self.host
            );
        }
        let from = parse_date(self.from.as_deref(), false)?;
        let to = parse_date(self.to.as_deref(), true)?;
        if from.zip(to).is_some_and(|(from, to)| from > to) {
            bail!("Invalid time window: from must not be after to");
        }
        let mut days = if from.is_some() {
            None
        } else {
            parse_days(&self.days)
        };
        let from = from.or_else(|| {
            calendar_window_start(
                days,
                to.unwrap_or_else(|| chrono::Utc::now().timestamp_millis() as f64),
            )
        });
        if from.is_none() && days.is_some_and(|days| days > 0) {
            days = None;
        }
        let session = self
            .session
            .as_deref()
            .filter(|session| !session.is_empty())
            .map(|session| {
                let (agent, id) = session
                    .split_once("://")
                    .filter(|(agent, id)| {
                        !agent.is_empty()
                            && agent.bytes().all(|c| c.is_ascii_alphabetic())
                            && !id.is_empty()
                    })
                    .with_context(|| {
                        format!("Invalid session format: {session}. Expected: agent://session-id")
                    })?;
                Ok::<_, anyhow::Error>((agent.to_owned(), id.to_owned()))
            })
            .transpose()?;
        let agents = if let Some((agent, _)) = &session {
            vec![agent.clone()]
        } else {
            self.agent
                .as_deref()
                .filter(|value| !value.is_empty())
                .map(|value| value.split(',').map(|s| s.trim().to_owned()).collect())
                .unwrap_or_default()
        };
        let cwd = self
            .cwd
            .as_ref()
            .filter(|cwd| !cwd.is_empty())
            .map(|cwd| {
                if cwd == "." {
                    std::env::current_dir().map(|path| path.to_string_lossy().into_owned())
                } else {
                    Ok(cwd.clone())
                }
            })
            .transpose()?;
        Ok(Plan {
            port: self
                .port
                .as_deref()
                .map(|value| parse_port(value, self.json))
                .transpose()?,
            from,
            to,
            days,
            cwd,
            agents,
            session,
            public_origin,
        })
    }
}

fn parse_port(value: &str, json_only: bool) -> Result<u16> {
    let value = value.trim_start();
    let negative = value.starts_with('-');
    let digits = value
        .trim_start_matches(['+', '-'])
        .bytes()
        .take_while(u8::is_ascii_digit)
        .collect::<Vec<_>>();
    if digits.is_empty() {
        return Ok(4521);
    }
    let port = std::str::from_utf8(&digits)
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
        .filter(|port| !negative || *port == 0)
        .and_then(|port| u16::try_from(port).ok());
    match port {
        Some(port) => Ok(port),
        None if json_only => Ok(0),
        None => bail!("Port must be an integer between 0 and 65535"),
    }
}

fn parse_days(value: &str) -> Option<u32> {
    let value = value.trim();
    if value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    value
        .parse::<u32>()
        .ok()
        .filter(|days| u64::from(*days) * 86_400_000 <= 9_007_199_254_740_991)
}

fn parse_date(value: Option<&str>, end: bool) -> Result<Option<f64>> {
    let Some(value) = value.filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    if value.len() == 10 && value.as_bytes()[4] == b'-' && value.as_bytes()[7] == b'-' {
        let mut date = NaiveDate::parse_from_str(value, "%Y-%m-%d")
            .with_context(|| format!("Invalid date: {value}"))?;
        if end {
            date = date.succ_opt().context("Invalid date")?;
        }
        let timestamp = local_timestamp(date.and_hms_opt(0, 0, 0).unwrap())?;
        return Ok(Some(timestamp - if end { 1.0 } else { 0.0 }));
    }
    if let Ok(timestamp) = chrono::DateTime::parse_from_rfc3339(value) {
        return Ok(Some(timestamp.timestamp_millis() as f64));
    }
    for format in [
        "%Y-%m-%dT%H:%M:%S%.f",
        "%Y-%m-%d %H:%M:%S%.f",
        "%Y-%m-%dT%H:%M",
    ] {
        if let Ok(timestamp) = NaiveDateTime::parse_from_str(value, format) {
            return local_timestamp(timestamp).map(Some);
        }
    }
    bail!("Invalid date: {value}")
}

fn configured_time_zone() -> Option<chrono_tz::Tz> {
    std::env::var("TZ")
        .ok()
        .and_then(|value| value.trim_start_matches(':').parse().ok())
}
fn local_timestamp(date: NaiveDateTime) -> Result<f64> {
    let timestamp = match configured_time_zone() {
        Some(zone) => zone
            .from_local_datetime(&date)
            .earliest()
            .map(|time| time.timestamp_millis()),
        None => Local
            .from_local_datetime(&date)
            .earliest()
            .map(|time| time.timestamp_millis()),
    };
    Ok(timestamp.context("Invalid local date")? as f64)
}
fn calendar_window_start(days: Option<u32>, timestamp: f64) -> Option<f64> {
    let days = days.filter(|days| *days > 0)?;
    let date = match configured_time_zone() {
        Some(zone) => zone
            .timestamp_millis_opt(timestamp as i64)
            .single()?
            .date_naive(),
        None => Local
            .timestamp_millis_opt(timestamp as i64)
            .single()?
            .date_naive(),
    }
    .checked_sub_days(Days::new(u64::from(days - 1)))?;
    local_timestamp(date.and_hms_opt(0, 0, 0)?).ok()
}
