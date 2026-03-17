## Learned User Preferences
- Treat the assistant as the Lead Engineer for the APEX-2026 HFT Solana bot, prioritizing ultra-low latency and capital preservation.
- Prefer Bun as the only runtime (no Node.js, npm, yarn, or npx) with strict ESNext TypeScript and no implicit any.
- Always favor parallel, non-blocking flows (Promise.all / Promise.allSettled / Promise.any) and RPC racing across multiple Solana endpoints.
- Require on-chain safety checks to go through Guard.ts, keeping public interfaces and shared types (like SecurityReport and validateToken) stable across refactors.
- Expect detailed, emoji-rich logs with execution time in milliseconds for critical paths (Guard, scanners, Sniper, DecisionCore).
- Prefer backward-compatible, additive changes (optional fields, preserved signatures) over breaking API changes, especially for core engine types and methods.
- Use structured timing (t_source, t_recv, t_act) and latency metrics as first-class features for monitoring and ML feature engineering.
- Rely on Jupiter APIs (quote/swap/Ultra) and Jito bundles for execution, but keep all HTTP calls on Bun fetch with explicit timeouts and graceful error handling.
- Default trading mode to paper trading with conservative risk parameters unless the user explicitly switches to live trading.

## Learned Workspace Facts
- The project APEX-2026 is a Solana HFT bot structured around MarketScanner, PumpScanner, Guard, DecisionCore, and Sniper executors.
- Guard.ts centralizes all token safety checks, including parallelized risk analysis, RPC racing, top-10 holder concentration, honeypot detection via Jupiter, and Raydium liquidity and LP-burn estimates.
- MarketScanner and PumpScanner emit MarketEvent objects enriched with triple timestamps (t_source, t_recv, t_act) that DecisionCore uses to compute detailed DecisionLatency metrics.
- DecisionCore combines Guard security results, liquidity, and optional social signals into a final score and priority, then emits tokenScored and readyToSnipe events without changing the external MarketEvent or ScoredToken contracts.
- Sniper.ts now uses Jupiter Ultra Swap API (/ultra/v1/order and /ultra/v1/execute) plus Jito bundles, explicit compute budget tuning, and congestion-aware Jito tips instead of older quote/swap flows.
- Environment configuration expects unified Solana RPC variables (HELIUS_RPC_URL, HELIUS_WS_URL, QUICKNODE_RPC_URL, RPC_URL) and trading parameters (TRADING_MODE, SLIPPAGE_BPS, MIN_LIQUIDITY, MAX_RISK_SCORE, paper trading amounts).

## V3 Roadmap — Architecture & Key Decisions
- V3 target architecture: 3-layer polyglot — Rust .so (hot path inference < 10ms), TypeScript/Bun (orchestration), Python (cold path training/retraining).
- Bun FFI bridge (bun:ffi) loads Rust cdylib (.so) with ~2-5ns overhead per call. Pull-synchronous model only (no Rust→JS callbacks). Export with #[no_mangle] extern "C".
- GC mitigation is critical: pre-allocate all Float64Array/TypedArray at startup via BufferPool (src/bridge/buffer-pool.ts), never new in hot path. JSC GC pauses can reach 5-15ms.
- Feature vector is 12 floats (96 bytes): OFI, hawkesBuy, hawkesSell, hmmState0-3, nlpScore, smartMoney, realizedVol, liquiditySol, priceUsdc. Pass as 12 scalar f64 via FFI for simple models; Float64Array only for TFT sequences (128×12 = 12KB).
- Each feature carries a timestamp to handle multi-source staleness (gRPC 5ms, WebSocket 50-200ms, Telegram 200ms+). Models receive (value, age_ms).
- Yellowstone gRPC (Geyser) is preferred but payant on Helius Business+. Guerrilla plan: Triton Community gRPC (free, limited) + WebSocket accountSubscribe fallback via Promise.any(). ShredStream is aspirational only.
- Jito BAM/ACE is immature (March 2026); stay on classic Jito Bundles with dynamic tips. Prepare abstract ExecutionStrategy interface for future BAM migration.
- DoubleZero/Fiber rejected for guerrilla (requires validator node).
- ONNX Runtime via Rust crate `ort` for sub-ms inference. Sessions must be pre-loaded at startup (10-50ms creation cost). TFT must be compact: hidden_dim=64, 2 attention layers, < 10MB ONNX.
- Shared memory (shm_open+mmap) is overkill for current volume (~100s events/sec). Use FFI direct with TypedArray; migrate to ring buffer only if profiling shows IPC bottleneck.

## V3 Roadmap — 5 Phases (52-76 days)
- Phase 1 (8-12d): Infrastructure — Rust workspace scaffold (rust_core/), Bun FFI bridge (src/bridge/), BufferPool, GeyserStream + StreamRouter, ONNX integration in Rust, Prisma Feature Store (FeatureSnapshot, TokenOutcome, ModelParams tables), Feature Logger in DecisionCore. Three parallel branches: FFI/ONNX, Ingestion, Database.
- Phase 2 (10-14d): Data Omniscience — NLP Pipeline 3-stage via Groq free tier (Stage0 regex, Stage1 Qwen3-Small embeddings < 50ms, Stage2 Llama-4 reasoning < 200ms only if confidence < 0.7), Virality/Velocity scorer, Wallet clustering via Louvain in Rust, SmartMoneyTracker (top 50-100 wallets), OFI Calculator from AMM pool reserves, FeatureAssembler.
- Phase 3 (12-18d): Math Brain — HMM 4-state Hamilton filter in Rust (< 5us), Hawkes bivariate intensity in Rust (< 100us, ring buffer 1024 events), TFT training in PyTorch then export to ONNX (opset 17, < 5ms inference), AIBrain orchestrator (total budget < 10ms: HMM + Hawkes + TFT + Kelly + decision).
- Phase 4 (8-12d): Execution & Risk — Kelly Fractional with dynamic eta by HMM regime (Accumulation 0.3, Trending 0.5, Mania 0.1, Distribution 0.15), CVaR at 5% on last 100 trades, SniperV3 with dynamic Jito tips (regime-aware, capped 0.05 SOL), Drift Protocol integration (margin monitor, liquidation guard), Reward Logger (R_i formula for RL).
- Phase 5 (14-20d): Learning Loop — OpenAI Gym trading env, PPO agent with CVaR-constrained loss, Shadow mode (RL runs parallel, no execution, must beat heuristic on 1000+ trades), hot-swap model weights via double-buffer AtomicUsize in Rust, auto-retrain cron every 6h (promote if Sharpe > current × 1.05), S&P 500 asset-agnostic interface via Alpaca.

## V3 Key File Paths (Target)
- rust_core/ — Cargo workspace: lib.rs, ffi.rs, types.rs, models/{hmm,hawkes,tft}.rs, clustering/{louvain,graph,smart_money}.rs, features/ofi.rs, inference/{onnx_engine,model_cache}.rs
- src/bridge/ — RustBridge.ts, buffer-pool.ts, types.ts, fallback.ts
- src/ingestors/ — GeyserStream.ts (gRPC), StreamRouter.ts (dedup + priority routing), SmartMoneyTracker.ts
- src/nlp/ — NLPPipeline.ts, Stage0_Regex.ts, Stage1_Embeddings.ts, Stage2_Reasoning.ts, BotDetector.ts, ViralityScorer.ts
- src/features/ — OFICalculator.ts, FeatureAssembler.ts
- src/engine/ — AIBrain.ts, OutcomeTracker.ts, RewardLogger.ts, ShadowAgent.ts, ModelUpdater.ts
- src/risk/ — KellyEngine.ts, CVaRManager.ts
- src/executor/ — SniperV3.ts, ExecutionStrategy.ts, JitoBundleStrategy.ts, JitoBAMStrategy.ts (stub), JitoTipOracle.ts
- src/perps/ — DriftConnector.ts, MarginMonitor.ts, LiquidationGuard.ts
- src/connectors/ — AssetConnector.ts, SolanaConnector.ts, AlpacaConnector.ts
- python/ — models/ (TFT), training/ (HMM, Hawkes), rl/ (Gym env, PPO, shadow_eval), retrain_pipeline.py, model_registry.py
