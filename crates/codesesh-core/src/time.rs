use std::{
    io,
    path::Path,
    time::{SystemTime, UNIX_EPOCH},
};

pub fn system_time_ms(time: SystemTime) -> f64 {
    let (seconds, nanos) = match time.duration_since(UNIX_EPOCH) {
        Ok(duration) => (duration.as_secs() as f64, duration.subsec_nanos()),
        Err(error) => {
            let duration = error.duration();
            if duration.subsec_nanos() == 0 {
                (-(duration.as_secs() as f64), 0)
            } else {
                (
                    -(duration.as_secs() as f64) - 1.0,
                    1_000_000_000 - duration.subsec_nanos(),
                )
            }
        }
    };
    // Node converts the integral seconds and nanosecond remainder separately.
    seconds * 1000.0 + f64::from(nanos) / 1_000_000.0
}

pub fn file_mtime_ms(path: &Path) -> io::Result<f64> {
    Ok(system_time_ms(path.metadata()?.modified()?))
}

pub fn date_time_clip(value: f64) -> Option<i64> {
    (value.is_finite() && value.abs() <= 8_640_000_000_000_000.0).then(|| value.trunc() as i64)
}
