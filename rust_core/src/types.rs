//! Shared data structures for FFI communication.
//! All structs must be #[repr(C)] for stable ABI layout.

/// Feature vector dimensions — must match TypeScript FEATURE_COUNT
pub const FEATURE_COUNT: usize = 12;

/// HMM state count (Accumulation, Trending, Mania, Distribution)
pub const HMM_STATES: usize = 4;

/// TFT sequence length
pub const TFT_SEQ_LEN: usize = 128;

/// Feature vector passed from TypeScript via FFI.
/// 12 features × f64 = 96 bytes.
#[repr(C)]
#[derive(Debug, Clone, Copy)]
pub struct FeatureVector {
    pub ofi: f64,
    pub hawkes_buy: f64,
    pub hawkes_sell: f64,
    pub hmm_state0: f64,
    pub hmm_state1: f64,
    pub hmm_state2: f64,
    pub hmm_state3: f64,
    pub nlp_score: f64,
    pub smart_money: f64,
    pub realized_vol: f64,
    pub liquidity_sol: f64,
    pub price_usdc: f64,
}

/// Inference result returned to TypeScript.
#[repr(C)]
#[derive(Debug, Clone, Copy)]
pub struct InferenceResult {
    pub signal: f64,     // -1.0 (sell) to 1.0 (buy)
    pub confidence: f64, // 0.0 to 1.0
    pub regime: u32,     // 0=Accumulation, 1=Trending, 2=Mania, 3=Distribution
    pub error_code: i32, // 0 = OK
}

impl Default for InferenceResult {
    fn default() -> Self {
        Self {
            signal: 0.0,
            confidence: 0.0,
            regime: 0,
            error_code: 0,
        }
    }
}
