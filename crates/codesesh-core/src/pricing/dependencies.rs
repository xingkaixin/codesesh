use super::{Price, Pricing};
use std::{cell::RefCell, collections::HashMap};

pub(crate) type PriceDependencies = HashMap<String, Option<Price>>;

thread_local! {
    static CAPTURES: RefCell<Vec<PriceDependencies>> = const { RefCell::new(Vec::new()) };
}

struct Capture;
impl Drop for Capture {
    fn drop(&mut self) {
        CAPTURES.with(|captures| {
            captures.borrow_mut().pop();
        });
    }
}

pub(crate) fn capture_dependencies<T>(run: impl FnOnce() -> T) -> (T, PriceDependencies) {
    CAPTURES.with(|captures| captures.borrow_mut().push(HashMap::new()));
    let guard = Capture;
    let result = run();
    let dependencies =
        CAPTURES.with(|captures| std::mem::take(captures.borrow_mut().last_mut().unwrap()));
    drop(guard);
    (result, dependencies)
}

pub(super) fn record(model: &str, price: Option<&Price>) {
    CAPTURES.with(|captures| {
        for capture in captures.borrow_mut().iter_mut() {
            if !capture.contains_key(model) {
                capture.insert(model.to_owned(), price.cloned());
            }
        }
    });
}

impl Pricing {
    pub(crate) fn matches_dependencies(&self, dependencies: &PriceDependencies) -> bool {
        dependencies
            .iter()
            .all(|(model, price)| self.resolve_price(model) == price.as_ref())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn captures_resolved_aliases_and_misses_and_cleans_up_after_panics() {
        let pricing = Pricing::bundled();
        let (_, outer) = capture_dependencies(|| {
            pricing.resolve("anthropic/claude-sonnet-4-6@latest");
            let (_, inner) = capture_dependencies(|| {
                pricing.resolve("unknown-dependency-model");
            });
            assert_eq!(inner.get("unknown-dependency-model"), Some(&None));
        });
        assert!(outer["anthropic/claude-sonnet-4-6@latest"].is_some());
        assert_eq!(outer.len(), 2);
        assert!(pricing.matches_dependencies(&outer));
        let _ = std::panic::catch_unwind(|| capture_dependencies(|| panic!("capture cleanup")));
        assert!(CAPTURES.with(|captures| captures.borrow().is_empty()));
    }
}
