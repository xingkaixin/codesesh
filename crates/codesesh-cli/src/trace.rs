use std::time::Duration;

#[derive(Default)]
pub struct Report {
    phases: Vec<(String, Duration)>,
}

impl Report {
    pub fn record(&mut self, name: impl Into<String>, duration: Duration) {
        self.phases.push((name.into(), duration));
    }

    pub fn print(&self, total_name: &str, duration: Duration) {
        println!("\n=== Performance Report ===\n");
        println!("{total_name}: {:.2}ms", duration.as_secs_f64() * 1000.0);
        for (name, duration) in &self.phases {
            println!("  {name}: {:.2}ms", duration.as_secs_f64() * 1000.0);
        }
    }
}
