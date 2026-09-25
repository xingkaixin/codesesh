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

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn preserves_node_stat_fractional_milliseconds() {
        let time = UNIX_EPOCH + Duration::new(1_790_326_157, 365_505_600);
        assert_eq!(system_time_ms(time), 1_790_326_157_365.505_6);
        let rounding_edge = Duration::new(1_790_326_157, 600);
        assert_eq!(
            system_time_ms(UNIX_EPOCH + rounding_edge),
            1_790_326_157_000.000_5
        );
        assert_ne!(
            system_time_ms(UNIX_EPOCH + rounding_edge),
            rounding_edge.as_secs_f64() * 1000.0
        );
        assert_eq!(
            system_time_ms(UNIX_EPOCH - Duration::new(1, 250_000)),
            -1000.25
        );
    }

    #[test]
    fn truncates_only_when_converting_to_a_javascript_date() {
        assert_eq!(date_time_clip(1000.875), Some(1000));
        assert_eq!(date_time_clip(-1000.875), Some(-1000));
        assert_eq!(date_time_clip(-0.875), Some(0));
        assert_eq!(
            date_time_clip(8_640_000_000_000_000.0),
            Some(8_640_000_000_000_000)
        );
        assert_eq!(date_time_clip(8_640_000_000_000_001.0), None);
        assert_eq!(date_time_clip(f64::NAN), None);
        assert_eq!(date_time_clip(f64::INFINITY), None);
    }
}
