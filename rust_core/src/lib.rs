//! APEX-2026 Rust Core — Hot Path Inference Engine
//!
//! Compiled as cdylib (.dll/.so) and loaded via Bun FFI.
//! All exported functions use C ABI (#[no_mangle] extern "C").

pub mod ffi;
pub mod types;
pub mod utils;

// Phase 3 modules (uncomment when implemented)
// pub mod models;
// pub mod clustering;
// pub mod features;
// pub mod inference;
