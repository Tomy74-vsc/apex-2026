//! Timing and logging utilities for hot-path performance measurement.

use std::time::Instant;

/// High-resolution timer for measuring function execution in microseconds.
pub struct Timer {
    start: Instant,
}

impl Timer {
    #[inline(always)]
    pub fn new() -> Self {
        Self {
            start: Instant::now(),
        }
    }

    #[inline(always)]
    pub fn elapsed_us(&self) -> f64 {
        self.start.elapsed().as_nanos() as f64 / 1_000.0
    }

    #[inline(always)]
    pub fn elapsed_ms(&self) -> f64 {
        self.start.elapsed().as_nanos() as f64 / 1_000_000.0
    }
}

impl Default for Timer {
    fn default() -> Self {
        Self::new()
    }
}
