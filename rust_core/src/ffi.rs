//! FFI exports — all functions callable from Bun via bun:ffi.
//!
//! Convention:
//!   - All functions are `extern "C"` + `#[no_mangle]`
//!   - Return i32 for status codes (0 = OK, negative = error)
//!   - Use raw pointers for buffer I/O (TypedArray on TS side)
//!   - No panics allowed — all errors caught and returned as codes

use crate::utils::Timer;

// ─── P1.1.3 — Ping & Benchmark ────────────────────────────────────────────

/// Returns current timestamp in microseconds (for round-trip latency measurement).
#[no_mangle]
pub extern "C" fn apex_ping() -> f64 {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    now.as_micros() as f64
}

/// Returns the library version as a u32 (major * 10000 + minor * 100 + patch).
#[no_mangle]
pub extern "C" fn apex_version() -> u32 {
    0_01_00 // v0.1.0
}

/// Benchmark: performs N f64 multiplications and returns elapsed microseconds.
/// Simulates inference workload for latency measurement.
#[no_mangle]
pub extern "C" fn apex_bench(iterations: u32) -> f64 {
    let timer = Timer::new();
    let mut acc: f64 = 1.0;
    for i in 0..iterations {
        acc *= 1.0 + (i as f64) * 0.000001;
    }
    // Black-box to prevent optimizer from eliding the loop
    std::hint::black_box(acc);
    timer.elapsed_us()
}

/// Benchmark: reads `input_len` f64 values from `input_ptr`, multiplies each by 2.0,
/// writes to `output_ptr`. Returns elapsed microseconds.
/// Used to benchmark FFI buffer round-trip (TypedArray → Rust → TypedArray).
#[no_mangle]
pub unsafe extern "C" fn apex_bench_buffer(
    input_ptr: *const f64,
    output_ptr: *mut f64,
    len: u32,
) -> f64 {
    if input_ptr.is_null() || output_ptr.is_null() || len == 0 {
        return -1.0;
    }
    let timer = Timer::new();
    let input = std::slice::from_raw_parts(input_ptr, len as usize);
    let output = std::slice::from_raw_parts_mut(output_ptr, len as usize);
    for i in 0..len as usize {
        output[i] = input[i] * 2.0;
    }
    timer.elapsed_us()
}

// ─── Phase 3 stubs (uncomment when models are implemented) ─────────────────

// HMM Hamilton filter — P3.1.1
// #[no_mangle]
// pub extern "C" fn apex_hmm_filter(
//     log_return: f64, realized_vol: f64, ofi: f64,
//     state_probs_out: *mut f64,
// ) -> i32 { 0 }

// Hawkes intensity evaluation — P3.2.1
// #[no_mangle]
// pub extern "C" fn apex_hawkes_intensity(
//     events_ptr: *const f64, events_len: u32, now: f64,
//     lambda_buy_out: *mut f64, lambda_sell_out: *mut f64,
// ) -> i32 { 0 }

// ONNX model loading — P1.3.1
// #[no_mangle]
// pub extern "C" fn apex_load_model(path_ptr: *const i8, model_id: u32) -> i32 { 0 }

// Generic ONNX inference — P1.3.1
// #[no_mangle]
// pub extern "C" fn apex_infer(
//     model_id: u32,
//     input_ptr: *const f64, input_len: u32,
//     output_ptr: *mut f64, output_len: u32,
// ) -> i32 { 0 }
