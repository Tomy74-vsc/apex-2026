## Learned User Preferences
- Treat the assistant as the Lead Engineer for the APEX-2026 HFT Solana bot, prioritizing ultra-low latency, capital preservation, and tight execution efficiency on performance-sensitive roadmap work (curve polling, position/exit paths, RPC usage).
- Prefer Bun as the only runtime (no Node.js, npm, yarn, or npx) with strict ESNext TypeScript and no implicit any.
- Always favor parallel, non-blocking flows: Promise.allSettled for independent checks (never Promise.all when individual failures are acceptable), Promise.any for RPC racing across multiple Solana endpoints.
- Require on-chain safety checks to go through Guard.ts, keeping public interfaces and shared types (like SecurityReport and validateToken) stable across refactors.
- Expect detailed, emoji-rich logs with execution time in milliseconds for critical paths (Guard, scanners, Sniper, DecisionCore).
- Prefer backward-compatible, additive changes (optional fields, preserved signatures) over breaking API changes, especially for core engine types and methods.
- Use structured timing (t_source, t_recv, t_act) and latency metrics as first-class features for monitoring and ML feature engineering.
- Rely on Jupiter APIs (quote/swap/Ultra) and Jito bundles for execution, but keep all HTTP calls on Bun fetch with explicit timeouts and graceful error handling.
- Default trading mode to paper trading with conservative risk parameters unless the user explicitly switches to live trading; every external call (RPC, Jupiter, HTTP) must have an explicit timeout and must not block indefinitely. In curve-prediction, legacy-style filters (`MIN_LIQUIDITY`, full `analyzeToken` honeypot and Raydium checks) are not applied on entries unless live trading is enabled with `CURVE_FULL_GUARD=1`; paper curve entries rely on `validateCurve`, `EntryFilter`, and `GraduationPredictor` gates instead.
- When fixing a specific issue, apply targeted minimal changes ("ne touche a rien d'autre") — do not modify surrounding code; typecheck or compile fixes and plan-tied work must stay strictly within the agreed docs: APEX_QUANT_STRATEGY.md, roadmapv3.md, roadmapv4.md, PHASE_AB_VALIDATION.md, and raodmap_final.md for Phase C+ (no unrelated refactors).
- All stateful services (FeatureStore, scanners, trackers) must flush and close gracefully on SIGINT shutdown.
- On Windows, keep console logs readable: UTF-8 where the terminal supports it (e.g. startup/shutdown hooks), and ASCII separators for dashboards when emoji or Unicode risk mojibake.

## Learned Workspace Facts
- The project APEX-2026 is a **curve-prediction-only** bot (`STRATEGY_MODE=curve-prediction` requis ; `MarketScanner.ts` reste en dépôt **DEPRECATED** pour scripts). Chemin actif : PumpScanner → CurveTracker → `DecisionCore.processCurveEvent` → `CurveExecutor`. `Sniper.ts` / Jupiter Ultra reste pour futurs modes ou outils, pas le pipeline courbe. Cursor conventions live in `.cursor/rules/` as domain MDC files instead of legacy `.cursorrules`.
- Guard.ts centralizes legacy token safety via `analyzeToken` / `validateToken` (Promise.allSettled, RPC racing, top-10 holders, Jupiter honeypot, Raydium liquidity and LP-burn, timeouts). For curve-prediction entries, `validateCurveForExecution` always applies synchronous `validateCurve` (progress band, max positions, age); it calls full `analyzeToken` only when `CURVE_FULL_GUARD=1` and `TRADING_MODE=live` with `TRADING_ENABLED=true`.
- PumpScanner émet des `MarketEvent` pour enregistrement courbe ; le pipeline courbe n’utilise plus `processMarketEvent` ni scoring Raydium dans `DecisionCore`.
- `DecisionCore` courbe : `Guard.validateCurveForExecution` → gate optionnelle `CurveTokenAnalyzer` (cache) → `EntryFilter` → `AIBrain.decideCurve` (Kelly seul autorité taille) + `PortfolioGuard` avant `ENTER_CURVE`.
- Sniper.ts uses Jupiter Ultra Swap API (/ultra/v1/order and /ultra/v1/execute) plus Jito bundles, explicit compute budget injection via TransactionMessage.decompile/recompile, and congestion-aware Jito tips.
- Environment configuration expects unified Solana RPC variables (HELIUS_RPC_URL, HELIUS_WS_URL, QUICKNODE_RPC_URL, RPC_URL) and trading parameters (TRADING_MODE, SLIPPAGE_BPS, MIN_LIQUIDITY, MAX_RISK_SCORE, paper trading amounts). WALLET_PRIVATE_KEY for CurveExecutor must be 64-byte secret (Base58 or JSON array); 32-byte Base58 is a public key and will fail.
- StateManager (src/engine/StateManager.ts) pre-caches the latest Solana blockhash in RAM every 400ms for 0ms transaction building.
- MarketScanner filters Token-2022 and known system program IDs (ComputeBudget, SystemProgram, JUP) before emitting events into the pipeline. PumpScanner uses the `ws` npm package for WebSocket (Bun native WebSocket fails HTTP 101 with Solana RPC) with perMessageDeflate: false; public Solana WS primary; Helius WS often 429 on free tier.
- V3 uses a 3-layer polyglot architecture: Rust cdylib for hot path inference (<10ms), TypeScript/Bun for orchestration, Python for cold path ML training, connected via bun:ffi with BufferPool for GC mitigation.
- FeatureStore (bun:sqlite) is append-only with 5s buffer flush, storing feature snapshots, token outcomes, curve_snapshots, curve_outcomes (`labelCurveOutcome` : **première résolution gagne** — `INSERT` ignoré si `mint` déjà présent ; `app` saute aussi `evicted`+`reason===graduated`), optional whale wallet rows when enabled, model params for ML training, and export helpers including labeled curve rows for supervised CSV (`bun run export:ml`, optional `EXPORT_ML_LAST_SNAPSHOT_ONLY` / `--last-snapshot-per-mint`).
- Curve pipeline: `STRATEGY_MODE=curve-prediction` (seul mode supporté au boot) starts CurveTracker (TieredMonitor, BatchPoller) before PumpScanner so `registerNewCurve` never hits a null tiered monitor. `TieredMonitor` emits `syntheticTrade` on bonding-curve reserve deltas (`synthetic: true`) into `CurveTracker.recordTrade`; wallet-level heuristics ignore synthetic rows; velocity uses wallet-first metrics with optional `VELOCITY_FALLBACK_SYNTHETIC` and mixed columns in ML snapshots. New curve registration is gated by `MIN_CURVE_REGISTRATION_SOL` in PumpScanner. Entry gating is `EntryFilter.ts` (velocity first window, trivial-tx on non-synthetic buys, optional `ENTRY_GATE_SOL_FLOOR`). Holder concentration in `GraduationPredictor` uses on-chain top-10 supply when `HOLDER_DISTRIBUTION_ENABLED` and cache is warm, else a volume proxy ; heuristique **0 trade** : `confidence=0.20` dans `predictFromCurveState`. `CurveTokenAnalyzer` pré-chauffe HOT (cache 5 min) et peut enrichir le prédicteur via `fullAnalysis`. `appendHotObservationSnapshot` (every HOT poll) stores predictor features for ML without EntryFilter/Guard/cooldown; trading decisions still flow through `processCurveEvent`. Bonding-curve MTM: `calcPricePerToken`; `PositionManager` normalizes legacy prices on restore (SQLite v2+). Paper curve uses `CurveExecutor`, `ExitEngine` (`PROGRESS_DROP_VETO`, hard max hold), `GraduationExitStrategy`, `PortfolioGuard`, `CurveShadowAgent` after `decideCurve`. `ShadowAgent` legacy reste chargé pour stats dashboard uniquement.
- Social layer is wired in app boot for curve mode: `GrokXScanner` and `NarrativeRadar` call xAI POST `/v1/responses` with `tools: [{ type: "web_search" }]` (legacy `search_parameters` returns HTTP 410). `TelegramTokenScanner`, `TelegramPulse`, `SocialTrendScanner` (DexScreener boosts), `SentimentAggregator`, and `WhaleWalletDB` integrate when env keys and RPC are set.

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

## V3 Implementation Status (24/37 tickets done — 65%)
- DONE: P1.1 FFI Bridge (Rust DLL 110KB, 100ns p50), P1.4 Feature Store, P2.1 NLP Pipeline, P2.1.2 ViralityScorer, P2.2.2 SmartMoneyTracker(TS), P2.3.1 OFI(TS), P2.4.1 FeatureAssembler, P3.1/P3.2 HMM+Hawkes(TS fallback), P3.4.1 AIBrain(0.5ms), P4.1.1 Kelly, P4.1.2 CVaR, P4.4.1 RewardLogger, P5.1-5.3 RL pipeline
- MISSING (data-blocked): P3.1.2/P3.2.2 Python trainers, P3.3 TFT, P1.3 ONNX Rust — need 5000+ Feature Store samples
- MISSING (optional): P1.2 gRPC (payant), P2.2.1 Louvain Rust, P5.4 Asset connectors
- MISSING (execution upgrades): P4.2 SniperV3+BAM, P4.3 Drift Protocol
- AIBrain integrated into DecisionCore (replaces linear scoring), ShadowAgent runs parallel, ModelUpdater watches models/ dir

## V3.1 Roadmap — Bonding Curve Prediction Strategy (roadmapv2.md)
- Reference: Marino et al. (arXiv:2602.14860) — "Predicting the success of new crypto-tokens"
- Strategy: Predictive positioning on Pump.fun bonding curves. Instead of sniping at T=0 (high risk), monitor curve progression and enter when P(graduation) > breakeven threshold.
- Bonding curve is a constant-product AMM: virtualSol × virtualToken = k. Graduation at ~85 SOL real reserves. Fee = 1.25% (125 bps).
- KOTH (King of the Hill) at ~32 SOL. Sweet spot entry zone: 35-55 SOL (~55-75% progress).
- Tiered monitoring: Cold (<25%, poll 60s) → Warm (25-50%, poll 10s) → Hot (>50%, poll 3s). Max 5000 cold, 500 warm, 100 hot curves.
- Graduation predictor: 2-stage system. Stage 1: fast heuristic vetos (<1ms). Stage 2: weighted score (velocity 40%, bot detection 20%, smart money 15%, holder diversity 15%, social 10%) → pGrad.
- Entry condition: pGrad > breakeven × 1.2 (20% safety margin). Breakeven at 50% ≈ 51%, at 75% ≈ 78%.
- Execution: Direct Pump.fun program interaction (NOT Jupiter). BUY discriminator [102,6,61,18,1,218,235,234], SELL [51,230,133,164,1,127,131,173]. 15 accounts for buy instruction. Jito bundles for inclusion.
- Risk: StallDetector (velocity drop), PortfolioGuard (max 5 concurrent, 20% exposure cap, 5% daily loss limit), GraduationExitStrategy, max hold 2h.
- Kelly sizing based on P(graduation) instead of linear score.
- **Mode supporté au runtime :** `curve-prediction` uniquement (legacy Raydium snipe retiré de `DecisionCore` ; `MarketScanner` fichier DEPRECATED).

## V3.1 Bonding Curve — Sprint Plan (4 sprints, 8 weeks)
- Sprint 1 (S1-S2): Foundation — pumpfun.ts constants, bonding-curve.ts types+decoder, curve-math.ts (8 math functions, all bigint), test-curve-decode.ts validation, BatchPoller (getMultipleAccounts batches of 100, RPC racing), TieredMonitor (cold/warm/hot lifecycle), CurveTracker orchestrator, PumpScanner modification (registerNewCurve instead of immediate snipe).
- Sprint 2 (S3-S4): Signals — VelocityAnalyzer (SOL/min, acceleration, peak ratio), BotDetector (fresh wallets, uniform trades, same-block buys), WalletScorer (smart money count, creator history, creator selling = RED FLAG), HolderDistribution (HHI, Gini), BreakevenCurve (min P(grad) for profitability), FeatureAssembler extension (30+ curve features), FeatureStore schema extension.
- Sprint 3 (S5-S6): Prediction+Execution — GraduationPredictor (heuristic + future ML), CurveExecutor (direct Pump.fun instructions), JitoBundler for curves, AIBrain modification (ENTER_CURVE/EXIT_CURVE/HOLD/SKIP), DecisionCore modification (curve-prediction routing), Guard curve-specific checks.
- Sprint 4 (S7-S8): Risk+Live — StallDetector, PortfolioGuard, GraduationExitStrategy, KellyEngine modification (P(grad)-based), app.ts integration.

## V3.1 Key Constants (Pump.fun on-chain)
- PUMP_PROGRAM_ID = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"
- PUMPSWAP_PROGRAM_ID = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA"
- INITIAL_VIRTUAL_TOKEN_RESERVES = 1_073_000_000_000_000n (1.073B, 6 decimals)
- INITIAL_VIRTUAL_SOL_RESERVES = 30_000_000_000n (30 SOL)
- INITIAL_REAL_TOKEN_RESERVES = 793_100_000_000_000n (793.1M tradeable)
- TOKEN_TOTAL_SUPPLY = 1_000_000_000_000_000n (1B total)
- GRADUATION_REAL_SOL_THRESHOLD = 85_000_000_000n (~85 SOL)
- FEE_BASIS_POINTS = 125n (1.25%)
- BONDING_CURVE_ACCOUNT_SIZE = 82 bytes (+ 8 discriminator = 90 total)
- BondingCurveState layout: vTokenReserves(u64@0x00), vSolReserves(u64@0x08), rTokenReserves(u64@0x10), rSolReserves(u64@0x18), totalSupply(u64@0x20), complete(u8@0x28), creator(Pubkey@0x29), isMayhemMode(u8@0x49)

## V3.1 New File Paths
- src/constants/pumpfun.ts — All Pump.fun program IDs, accounts, discriminators, thresholds
- src/types/bonding-curve.ts — BondingCurveState, TrackedCurve, CurveTradeEvent, GraduationEvent, decodeBondingCurve(), deriveBondingCurvePDA()
- src/math/curve-math.ts — calcProgress, calcPricePerToken, calcMarketCapSOL, calcBuyOutput, calcSellOutput, calcRequiredSolForProgress, calcPriceImpact, calcExpectedReturnOnGraduation
- src/modules/curve-tracker/ — CurveTracker.ts, TieredMonitor.ts, BatchPoller.ts
- src/modules/graduation-predictor/ — GraduationPredictor.ts, VelocityAnalyzer.ts, BotDetector.ts, WalletScorer.ts, HolderDistribution.ts, BreakevenCurve.ts
- src/modules/curve-executor/ — CurveExecutor.ts, JitoBundler.ts, GraduationExitStrategy.ts
- src/modules/risk/ — StallDetector.ts, PortfolioGuard.ts
- scripts/test-curve-decode.ts — Live validation script

## Roadmap documents (repo root) — roles
- **roadmap.md** — V3 technical audit (FFI, GC, gRPC vs WS, ONNX, BAM) + Phases 1→5 tickets (rust_core, StreamRouter, SniperV3, Drift, RL, ~52–76 dev-days).
- **roadmapv2.md** — Bonding-curve implementation map (Marino): P0–P4 sprints; Sprint 1–3 largely done under `src/modules/`, `src/constants/pumpfun.ts`; Sprint 4 still partial (HolderDistribution, StallDetector, PortfolioGuard, curve JitoBundler, Kelly P(grad)).
- **roadmapv3.md** — Ops closure + “yeux partout”: TieredMonitor evictions, predictor hardening (`lastPromotedToHot`, SAFETY_MARGIN, min trades), SocialTrendScanner, TelegramTokenScanner, WhaleWalletDB. **Paths:** `src/modules/position/`, `src/modules/curve-executor/GraduationExitStrategy.ts` (not duplicate `src/trading/`).
- **roadmapv4.md** — HFT narrative: WS pool, EntryFilter, Grok, whale bootstrap, FeatureEngineer+LightGBM+PPO+ModelOrchestrator, dashboard WS. **Guérilla caveat:** second Helius key / Alchemy / Grok = optional extended stack; core must run on Helius+QuickNode+Groq+DexScreener unless opted in.
- **APEX_QUANT_STRATEGY.md** — **Quant source of truth** (incl. **§0** mars 2026): ~1.15% blind snipe EV negative; conditional P(grad|vSol,X); breakeven table; **sweet spot ~35–55 SOL (55–75% progress)**; **7-signal fixed weights** (social **w=0.07** constant, **value** social dynamique via aggregator — §0.3); **vetos V1–V5**; **safety_margin(confidence) = 1 + (1−c)×0.8**; exits: **default profil Rotation** — `TIME_STOP_SECONDS`/`HARD_MAX_HOLD_SECONDS` **300 s**, stall **0.05 SOL/min × 90 s** (option Conservation 600 s / 0.1 × 120 s en §0.2); grad **40/35/25%**, **T2 ~60s** (env), T3 trailing + short max hold; Kelly quarter with caps.
- **PHASE_AB_VALIDATION.md** — Checklist paper 2–4 h + envs Phase A/B alignés APEX / roadmapv3 (M1–M4, P2/P3).
- **raodmap_final.md** — Directive **Phase C** (Cursor Composer 2, 23 Mar 2026) : prérequis **Phase A+B ✅** ; plan détaillé pour **intelligence sociale + ML data** (Grok X Search `GrokXScanner`, `NarrativeRadar`, `SentimentAggregator`, intégration `GraduationPredictor`, Telegram/DexScreener, scripts export CSV, etc.). **Nom de fichier** = `raodmap_final.md` (typo volontaire côté repo).

## Où en est le projet (synthèse docs ↔ code, Mar 2026)

- **Stratégie quant (source de vérité)** : `APEX_QUANT_STRATEGY.md` — **§0** tranche sortie **Rotation** vs Conservation et **poids sociaux fixes** ; Marino arXiv:2602.14860, EV snipe T=0 négatif, **sweet spot ~35–55 SOL réel**, breakeven dynamique, **7 signaux + vétos V1–V5**, `safety_margin(confidence)` avec plancher optionnel env `SAFETY_MARGIN_BASE`, Kelly fractionnel + caps, cascade §8 (hard/soft time, stall, régression progress via `PROGRESS_DROP_VETO`, TP partiel, **trailing 15 % sur reliquat post-TP 50 %** dans `ExitEngine`).
- **Plans d’implémentation** : `roadmapv3.md` = fermeture pipeline + modules M1–M7 (chemins réels sous `src/modules/`). `roadmapv4.md` = récit HFT + backlog (WS pool, EntryFilter, Grok, whales, ML) — **certains chemins type `src/trading/` sont des brouillons** ; le code vit sous `src/modules/`. `PHASE_AB_VALIDATION.md` = **gate** paper 2–4 h (envs, logs, SQLite, sélectivité ≪ 100 % HOT).
- **Déjà en place (aligné Phase A+B)** : `PositionManager` (`src/modules/position/`, persist SQLite + restore + **prix spot SOL/raw** via `calcPricePerToken` + **normalisation legacy** lamports/raw au MTM, persist row **v2**), `ExitEngine`, `GraduationExitStrategy`, `PaperTradeLogger`, `CurveTracker` + `TieredMonitor` + `BatchPoller`, `GraduationPredictor` + `BreakevenCurve`, **`EntryFilter`** (`src/modules/entry/EntryFilter.ts` → `DecisionCore`), `Guard` curve, `AIBrain` curve + Kelly / `MAX_POSITION_SOL`, PumpScanner + paper `CurveExecutor`.
- **Phase C (mars 2026) — déjà câblé** : `GrokXScanner`, `NarrativeRadar`, `SentimentAggregator`, `SocialTrendScanner`, `TelegramTokenScanner`, `WhaleWalletDB`, export `bun run export:ml`, `validateEnv()` (paper sans wallet obligatoire), dashboard + log `🔍 [EVAL]` 5 min. **Encore ouvert** : `WebSocketPool` refactor `PumpScanner`, `DexScreenerMonitor` dédié si besoin, orchestration ML avancée (roadmapv4 §P3). **Guérilla** : Grok/xAI = opt-in (`XAI_API_KEY`).
- **Métriques à surveiller en paper** : taux d’entrée HOT **≪ 100 %**, croissance **`curve_outcomes` / snapshots**, logs `EntryFilter` + `ExitEngine` ; les compteurs **AIBrain “Curve ENTER %”** peuvent compter des **intentions pré-Guard** — ne pas les lire comme taux de fill réel.

## Status post–Phase A (March 2026)
- **Done (Phase A complete):** `PositionManager` (+ SQLite `open_curve_positions` debounced persist, restore on boot, flush on shutdown), `ExitEngine`, `GraduationExitStrategy` (env `GRAD_T1_PCT` / `GRAD_T2_PCT`, `GRAD_T2_DELAY_MS` / `GRAD_T3_DELAY_MS` + legacy `GRAD_EXIT_T2_MS`; défauts APEX **40 / 35 %**, T2 **60 s**), `PaperTradeLogger` → `data/paper_trades.jsonl`, `curveVelocitySingleton`, `app.ts` wiring + `DecisionCore.syncActiveCurveSlotCount` after restore, console portfolio block.
- **Env:** `CURVE_POSITION_PERSIST=0` disables position DB rows; `PAPER_TRADE_LOG=0` disables JSONL; `PAPER_TRADE_LOG_PATH` overrides log file.
- **Validation paper :** checklist **`PHASE_AB_VALIDATION.md`** (2–4 h, SQLite `curve_snapshots` / `curve_outcomes`, logs EntryFilter + ExitEngine).

## Status post–Phase B (March 2026)
- **Done:** `TrackedCurve` lifecycle fields; `TieredMonitor` aggressive evictions + 60s sweep + **no evict** if open position; `BreakevenCurve.safetyMarginFromConfidence` + `calcBreakevenWithConfidence` (APEX §6 + `SAFETY_MARGIN_BASE` plancher optionnel); `GraduationPredictor` **7 poids APEX §5**, **vétos V1→V5** puis gates roadmapv3 (`min_trades`, `early_hot`, `velocity_ratio`); **holder quality** = `(1 − freshWalletRatio) × (1 − top10Conc)` ; bandes `CURVE_ENTRY_*` **partagées** `src/constants/curve-entry-bands.ts` (Guard + prédicteur); heuristique **0 trade** : `confidence=0.20`, bande `CURVE_ENTRY_*` + veto stale age; `getVetoStats()`; `EntryFilter.ts` → `DecisionCore`; `AIBrain` Kelly `b=M−1`, **`MAX_POSITION_SOL`** cap (APEX §7), `MIN_KELLY_FRACTION` skip, `curvePredictionPGrad`; `ExitEngine` **Rotation** + **`TRAILING_REMAINDER_PCT`** + `PROGRESS_DROP_VETO`; `PortfolioGuard` + `CurveTokenAnalyzer`; `app` cache pGrad + dashboard 60s + **`🔍 [EVAL]` 5 min**; **outcomes** : `labelCurveOutcome` idempotent (première écriture) + `evicted`/`graduated` géré côté `app`; **whale** auto ; **social** : `SOCIAL_BLEND_WEIGHT_*`, `NARRATIVE_SOCIAL_MODE`.
- **Still open (Phase C+):** WebSocketPool; PumpSwap post-grad; v2 Sprint 4; éviction COLD « 15 min + pGrad » roadmapv4 (non branchée au prédicteur dans `TieredMonitor`).

## Unified implementation plan (step order; all paths under `src/` unless noted)

**Phase A — DONE** (v3 M1–M4 + v4 P0 core)  
Position book, exit cascade, 3-tranche grad, app + dashboard, **persist + restore + paper trade log**.

**Phase B — DONE** (v3 P2/P3 + APEX §4–8 + v4 1B/1C)  
Key envs: `CURVE_ENTRY_MIN_PROGRESS` / `CURVE_ENTRY_MAX_PROGRESS`, `MIN_TRADING_INTENSITY`, `MIN_TRADE_COUNT`, `MIN_MINUTES_IN_HOT`, `VETO_BOT_RATIO`, `VETO_MAX_AGE_MINUTES`, `TIER_*`, `TIME_STOP_SECONDS`, `HARD_MAX_HOLD_SECONDS`, `STALL_DURATION_SECONDS`, `STALL_SOL_FLOW_MIN`, `STALL_VELOCITY_THRESHOLD` (réservé), `TIME_STOP_MIN_PGRAD`, `LIVE_PGRAD_REFRESH_MS`, `MIN_KELLY_FRACTION`, **`MAX_POSITION_SOL`**, `MIN_VELOCITY_SOL_MIN`, `MAX_TRIVIAL_TX_RATIO`, `TRIVIAL_TX_SOL`. Voir **`PHASE_AB_VALIDATION.md`** + **`APEX_QUANT_STRATEGY.md` §0** pour le run paper.

**Phase C — Infra stability (v4 1A)**  
8. `src/infra/WebSocketPool.ts`: multi-URL failover, ping/pong, resubscribe, dedup by sig/slot; refactor `PumpScanner` to consume pool (`ws`, `perMessageDeflate: false`).

**Phase D — Social + whales (v3 M5–M7 + v4 2A/2B/2C; Grok optional)**  
9. `SocialTrendScanner.ts` + `app.ts` wiring (DexScreener + PumpPortal).  
10. `DexScreenerMonitor.ts` (if not folded into 9) + events for scoring.  
11. `TelegramTokenScanner.ts` (GramJS + DexScreener discovery) → cache → `socialScore` into predictor (APEX social blend).  
12. `WhaleWalletDB.ts` + FeatureStore table + `scripts/discover-whales.ts` (alias de `seed-whales.ts` ; `bun run discover:whales` / `seed:whales`) + boot `loadIntoSmartMoneyTracker()`.  
13. **Optional:** `src/social/GrokXScanner.ts` + `SentimentAggregator.ts` (xAI credits) — **cold path / overlay only**, never sole trigger.

**Phase E — ML flywheel (v4 P3 + roadmap.md Phase 3)**  
14. `FeatureEngineer.ts` — 32 features from `curve_snapshots` + placeholders for social/whale.  
15. `python/train_graduation_model.py`, `export_onnx.py`, hook `retrain_pipeline.py`; promote when AUCPR > threshold.  
16. `ModelOrchestrator.ts` (or extend `ModelUpdater`) + ShadowAgent A/B; Rust `ort` or agreed TS ONNX path.

**Phase F — Execution + risk debt (roadmapv2 P4 + roadmap.md P4)**  
17. `HolderDistribution.ts` (**done** — optionnel RPC `HOLDER_DISTRIBUTION_ENABLED`), `StallDetector.ts` (if not fully subsumed by ExitEngine), `PortfolioGuard.ts` (**done** — `src/modules/risk/PortfolioGuard.ts`), curve `JitoBundler.ts`, `SniperV3`/`JitoTipOracle`, Drift — by priority after data validates edge.

**Validation gates**  
- **A+B:** Suivre **`PHASE_AB_VALIDATION.md`** (2–4 h paper): positions open/close, `paper_trades.jsonl`, evictions > 0, `curve_outcomes` / `curve_snapshots` qui croissent, HOT enter rate **≪ 100%**, vetos + EntryFilter visibles.  
- **C:** DexScreener/PumpPortal lines in logs; whale table non-empty after script.  
- **E:** ML only with **500–1000+** labeled curves minimum for experiments; v4 asks **10k+** for production confidence.
