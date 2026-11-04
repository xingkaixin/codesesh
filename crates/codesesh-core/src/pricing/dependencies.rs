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
