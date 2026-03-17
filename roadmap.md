# APEX-2026 V3 — AUDIT TECHNIQUE & ROADMAP CHIRURGICALE

**Document Classification:** Internal — Engineering Lead Review  
**Auteur:** Staff Quant Developer / Lead Engineer  
**Date:** 17 mars 2026  
**Scope:** Validation technique du Blueprint V3 + Plan d'exécution Phase 1→5  

---

## PARTIE 1 : AUDIT ET VALIDATION TECHNIQUE (Peer Review)

### 1.1 — VERDICT GLOBAL

Le Blueprint V3 est **techniquement ambitieux mais réalisable à 85%**. Les 15% restants ne sont pas des impossibilités — ce sont des choix architecturaux qui nécessitent des compromis pragmatiques par rapport à la vision pure du document. Le principal risque n'est pas technique : c'est la **complexité d'intégration simultanée** de 8+ systèmes hétérogènes (Bun, Rust, Python, gRPC, Shared Memory, ONNX, Jito BAM, Drift) dans un pipeline qui doit tenir sous 150ms bout-en-bout.

---

### 1.2 — VALIDATION COMPOSANT PAR COMPOSANT

#### ✅ Bun FFI vers Rust — VALIDÉ AVEC RÉSERVES

**Faisabilité :** Oui. L'API `bun:ffi` permet de charger des `.so` compilés depuis Rust et d'appeler des fonctions C-ABI avec une surcharge mesurée entre 2 et 5 nanosecondes par appel (benchmarks Bun officiels). C'est effectivement du "quasi zero-overhead" comparé aux 50-200μs d'un appel gRPC local.

**Angles morts identifiés :**

- **Garbage Collector JavaScriptCore (JSC).** Bun utilise JSC, pas V8. Le GC de JSC est concurrent mais ses pauses majeures peuvent atteindre 5-15ms sur un heap > 500MB. Sur le hot path (ingestion → inférence → décision), une pause GC au mauvais moment détruit la fenêtre de 150ms. **Mitigation :** Pré-allouer tous les `TypedArray`/`Buffer` au démarrage. Ne jamais créer d'objets jetables dans la boucle critique. Utiliser `SharedArrayBuffer` pour les buffers passés au Rust — ils vivent hors du heap GC.

- **Types supportés.** Bun FFI supporte les types scalaires (`i32`, `u64`, `f64`, `ptr`) et les `TypedArray` comme `Uint8Array`. Mais le passage d'objets complexes (structs imbriquées) requiert une sérialisation manuelle dans un buffer plat côté TS, puis un parsing côté Rust. Ce n'est PAS du vrai "zero-copy struct passing" — c'est du "zero-copy buffer passing avec sérialisation manuelle". La latence dépend donc de la taille du feature vector.

- **Pas de callbacks asynchrones stables.** Bun FFI ne supporte pas proprement les callbacks Rust → JS (les `JSCallback` sont expérimentaux et leaky). Ça signifie que le modèle d'inférence Rust ne peut pas *push* des résultats vers TS — il faut un modèle **pull synchrone** : TS appelle Rust, Rust répond, TS continue. C'est compatible avec le design mais exclut un modèle event-driven côté Rust.

**Verdict FFI :** 🟢 Go. Mais adopter le pattern "TS appelle, Rust répond synchrone" exclusivement sur le hot path. Exporter les fonctions Rust avec `#[no_mangle] extern "C"`.

---

#### ✅ Yellowstone gRPC — VALIDÉ, COÛT CONDITIONNEL

**Faisabilité :** Oui. Yellowstone gRPC (Geyser plugin) est l'interface standard pour le streaming temps réel des account updates sur Solana. Helius expose Yellowstone gRPC sur son plan Business (payant). Triton offre un accès gRPC sur son tier gratuit avec des rate limits.

**Angles morts identifiés :**

- **Free Tier Reality.** Le plan gratuit Helius (Hacker) n'expose PAS Yellowstone gRPC — il est réservé aux plans payants (Business+, ~$199/mois). QuickNode a un addon gRPC Yellowstone aussi payant. C'est un **conflit direct avec la philosophie Guérilla HFT "100% gratuit"**.

- **Alternative Guérilla :** Utiliser le WebSocket `accountSubscribe` natif de Solana (gratuit sur tous les RPC) sur les comptes de pools ciblés. Latence mesurée : 50-200ms vs 5-10ms pour Yellowstone gRPC. La perte de 40-190ms est significative mais gérable si le reste du pipeline compense. **Plan B** : Triton RPC (plan Community) offre un accès gRPC limité. Combiner Triton gRPC + Helius WebSocket en `Promise.any()` pour le meilleur des deux mondes.

- **ShredStream.** Jito ShredStream (< 1ms pre-validation) est **réservé aux opérateurs de nœuds validateurs ou aux clients enterprise de Jito Labs**. Il n'est pas accessible aux développeurs individuels. Le Blueprint survole ce point — ShredStream est aspirationnel, pas opérationnel pour nous.

**Verdict gRPC :** 🟡 Go conditionnel. Plan A : Triton Community gRPC (gratuit, limité). Plan B : WebSocket classique avec RPC Racing. ShredStream = Phase future quand le fund a du capital pour un nœud dédié.

---

#### ⚠️ Jito BAM / ACE — VALIDÉ PARTIELLEMENT, IMMATURITÉ

**Faisabilité :** Partielle. Le Block Assembly Marketplace (BAM) a été annoncé par Jito Labs comme successeur des bundles classiques. ACE (Application-Controlled Execution) est le framework de plugins associé.

**Angles morts identifiés :**

- **Maturité en mars 2026.** BAM est en phase de rollout progressif. L'API est encore en évolution et la documentation SDK est incomplète. Les plugins ACE nécessitent un déploiement on-chain (programme Solana) ce qui implique des frais de rent et de transactions. Ce n'est pas un simple changement d'API côté client.

- **Accès.** BAM est principalement conçu pour les block builders et les gros searchers. Un petit opérateur peut envoyer des transactions *via* BAM, mais ne peut pas déployer ses propres règles d'ordonnancement (ACE) sans être intégré comme builder. L'avantage anti-sandwich que décrit le Blueprint suppose un niveau d'accès que nous n'avons pas encore.

- **Fallback.** Les Jito Bundles classiques (`sendBundle` via Block Engine) restent fonctionnels et sont notre outil éprouvé. Le code actuel du `Sniper.ts` utilise déjà ce pattern.

**Verdict BAM/ACE :** 🟡 Go progressif. Phase 4 implémente d'abord les Jito Bundles optimisés (V2 amélioré), puis migre vers BAM quand l'API se stabilise. ACE est Phase 5+ (quand on a le capital pour un programme on-chain).

---

#### ✅ ONNX Runtime en Rust — VALIDÉ

**Faisabilité :** Oui. Le crate `ort` (bindings Rust pour ONNX Runtime) est mature, bien maintenu, et supporte l'inférence CPU avec des latences sub-milliseconde pour des modèles tabulaires de petite taille (< 10MB de paramètres).

**Benchmarks réalistes :**
- Modèle HMM (4 états, vecteur 3D) : ~50-100μs par update
- Processus de Hawkes (estimation online) : ~200-500μs par événement
- TFT exporté en ONNX (version compacte, 2-3 couches) : 1-5ms sur CPU pour une séquence de 128 timestamps

**Angles morts identifiés :**

- **Export TFT → ONNX.** Les Temporal Fusion Transformers de PyTorch utilisent des composants dynamiques (Variable Selection Networks, GRN avec gating) qui ne s'exportent pas toujours proprement en ONNX statique. Il faudra potentiellement un modèle simplifié ou utiliser `torch.onnx.export` avec `opset_version >= 17` et des workarounds pour les boucles dynamiques.

- **Taille du modèle.** Un TFT "complet" (6 couches attention, 128 hidden dim) pèse 5-15MB. L'inférence CPU reste sous 5ms. Mais un TFT "institutionnel" (512 hidden, 12 couches) monte à 50-100ms — inacceptable sur le hot path. **Contrainte de design :** Le TFT doit être "compact" : 2-3 couches attention, 64 hidden dim max.

**Verdict ONNX :** 🟢 Go. Mais figer l'architecture TFT à une taille compacte dès le début du training.

---

#### ✅ Mémoire Partagée POSIX — VALIDÉ AVEC COMPLEXITÉ

**Faisabilité :** Oui. `shm_open` + `mmap` est l'IPC le plus rapide possible (zero-copy, pas de context switch kernel). Les benchmarks montrent 50-100ns de latence par lecture/écriture vs 10-50μs pour Unix sockets.

**Angles morts identifiés :**

- **Accès depuis Bun.** Bun n'a pas d'API native pour `shm_open`. Il faut passer par FFI vers une lib C/Rust qui crée le segment shared memory, puis exposer le pointeur comme un `TypedArray` côté TS via `FFIType.ptr` + `toArrayBuffer()`. C'est faisable mais ajoute une couche de glue code non triviale.

- **Synchronisation.** Le ring buffer en shared memory nécessite des primitives de synchronisation (mutex POSIX ou atomic operations). Le producteur (TS/Bun) et le consommateur (Rust) doivent s'accorder sur le protocole de lecture/écriture. Sans synchronisation, on a des races conditions qui corrompent les données. **Solution :** Utiliser un ring buffer lock-free basé sur des atomics (`std::sync::atomic` côté Rust, `Atomics` côté TS sur SharedArrayBuffer).

- **Complexité vs Gain.** Pour le volume de données que nous traitons (quelques centaines d'events/seconde, pas des millions), la différence entre shared memory (100ns) et un simple appel FFI passant un `Uint8Array` (500ns) est **négligeable**. La shared memory n'apporte un avantage réel que si le volume dépasse 100K events/sec ou si la taille des payloads dépasse 1MB.

**Verdict Shared Memory :** 🟡 Optionnel en Phase 1. Implémenter le FFI direct avec `TypedArray` d'abord. Migrer vers shared memory ring buffer uniquement si le profiling montre un bottleneck IPC mesurable.

---

#### ✅ HMM (Hidden Markov Model) — VALIDÉ

**Faisabilité :** Oui. Un HMM à 4 états avec filtrage de Hamilton est computationnellement trivial — c'est une multiplication matrice × vecteur (4×4 × 4×1) suivie d'une normalisation. En Rust, c'est < 1μs par update.

**Pas d'angle mort significatif.** Le vrai défi est l'estimation initiale des paramètres (matrice de transition, moyennes/variances par état) qui se fait offline sur les données historiques via l'algorithme de Baum-Welch. C'est du Python standard (`hmmlearn` ou implémentation custom).

**Verdict HMM :** 🟢 Go. Implémentation triviale en Rust pur (pas besoin de crate externe).

---

#### ✅ Processus de Hawkes — VALIDÉ AVEC NUANCES

**Faisabilité :** Oui. L'estimation online des paramètres d'un processus de Hawkes bivarié est plus coûteuse que le HMM mais reste faisable en temps réel.

**Angles morts identifiés :**

- **Estimation vs Évaluation.** Évaluer l'intensité λ(t) étant donné des paramètres fixes est rapide (~100μs). Mais ré-estimer les paramètres (μ, α, β) en continu via MLE est un problème d'optimisation non-linéaire qui peut prendre 1-10ms par batch. **Solution :** Séparer le hot path (évaluation λ(t) avec paramètres figés, en Rust, < 100μs) du cold path (ré-estimation des paramètres toutes les N minutes, en Python).

- **Fenêtre d'historique.** Le noyau exponentiel e^(-β(t-s)) décroît mais l'historique doit être tronqué pour éviter que la somme grandisse indéfiniment. Utiliser une fenêtre glissante de 5-10 minutes d'événements.

**Verdict Hawkes :** 🟢 Go. Hot path en Rust (évaluation), cold path en Python (calibration).

---

#### ⚠️ DoubleZero / Fiber — NON VALIDÉ POUR GUÉRILLA

**Faisabilité :** DoubleZero est un réseau de transport dédié en fibre optique pour les validateurs Solana. Il offre une latence réduite et un jitter stable.

**Réalité :** DoubleZero est réservé aux opérateurs de nœuds et aux institutions. Un bot de trading ne peut pas "se brancher" sur DoubleZero sans opérer un nœud dans le réseau. C'est incompatible avec la Guérilla HFT.

**Verdict DoubleZero :** 🔴 Rejeté pour le moment. Garder en roadmap long-terme quand le fund opère son propre nœud.

---

#### ✅ Drift Protocol v3 — VALIDÉ

**Faisabilité :** Oui. Le SDK TypeScript de Drift (`@drift-labs/sdk`) est mature et bien documenté. Le monitoring de marge en temps réel et l'envoi d'ordres de dérisquage sont des opérations standard.

**Angles morts identifiés :**

- **Latence du SDK.** Le SDK Drift fait des appels RPC pour chaque opération. Monitoring du health factor = 1 RPC call toutes les N secondes. Ce n'est pas du hot path mais ça consomme des credits RPC.

- **Drift v3 vs v2.** Vérifier que le SDK supporte bien les nouvelles features de v3 (liquidation engine amélioré, nouveaux types d'ordres).

**Verdict Drift :** 🟢 Go. Intégration standard via SDK.

---

### 1.3 — GOULOTS D'ÉTRANGLEMENT CACHÉS IDENTIFIÉS

#### 🔴 CRITIQUE #1 : Le GC JavaScriptCore sur le Hot Path

Le problème le plus dangereux de toute l'architecture. Bun utilise JavaScriptCore dont le GC n'est pas aussi prévisible que celui de V8 (qui a des options comme `--max-old-space-size` et `--expose-gc`). Une pause GC de 10ms au milieu du pipeline ingestion → inférence → exécution est catastrophique.

**Mitigation obligatoire :**
- Pré-allouer un pool de `TypedArray` au démarrage (Object Pool Pattern)
- Ne JAMAIS créer de `new Object()` ou de `new Array()` dans le hot path
- Utiliser des buffers pré-alloués pour la sérialisation FFI
- Monitorer les pauses GC via `Bun.gc(true)` en mode debug
- Le feature vector doit être un `Float64Array` pré-alloué, pas un objet JS

#### 🟡 CRITIQUE #2 : Sérialisation du Feature Vector pour FFI

Le Blueprint parle de "zero-copy" mais la réalité est plus nuancée. Le feature vector qui entre dans le moteur d'inférence Rust contient :
- OFI (float64)
- Score social NLP (float64)  
- Intensité Smart Money (float64)
- Volatilité réalisée (float64)
- Probabilité d'état HMM (4 × float64)
- Intensité Hawkes buy/sell (2 × float64)

Total : ~12 features × 8 bytes = 96 bytes. C'est minuscule. Le "zero-copy" pour 96 bytes est un over-engineering — un simple appel FFI avec 12 arguments `f64` est plus rapide que configurer un segment shared memory.

**Recommandation :** Passer les features comme arguments scalaires FFI pour les modèles simples (HMM, Hawkes). Utiliser un `Float64Array` partagé uniquement pour le TFT qui a besoin de séquences temporelles (128 timestamps × 12 features = 12KB).

#### 🟡 CRITIQUE #3 : Coordination Temporelle Multi-Source

Le système ingère des données de 5+ sources (gRPC, WebSocket, Telegram, Pyth, Wallet tracker) avec des latences très différentes (1ms → 500ms). Le DecisionCore doit prendre une décision à un instant T avec un vecteur de features potentiellement "stale" sur certaines dimensions.

**Problème :** Si le signal NLP Telegram a 50ms de latence et le gRPC a 5ms, le feature vector à T contient un signal NLP datant de T-50ms. Le modèle doit être entraîné avec cette réalité de staleness, sinon il apprend des corrélations fantômes.

**Mitigation :** Ajouter un timestamp par feature dans le feature vector. Le modèle TFT/HMM reçoit (value, age_ms) pour chaque feature. Le training utilise le même schéma.

#### 🟡 CRITIQUE #4 : Fiabilité gRPC vs Tolérance aux Fautes

Yellowstone gRPC maintient une connexion longue durée. Les déconnexions sont fréquentes (restart de nœud, rate limiting, maintenance). Le système doit :
- Détecter la déconnexion en < 100ms
- Basculer sur le fallback WebSocket instantanément
- Re-souscrire au gRPC dès qu'il revient
- Ne JAMAIS perdre un event pendant la bascule

C'est un problème d'ingénierie sérieux qui n'est pas couvert dans le Blueprint.

---

## PARTIE 2 : ROADMAP CHIRURGICALE — LE PLAN DE BATAILLE

### Convention de Nommage des Tickets

Format : `[PHASE].[SOUS-PHASE].[NUMÉRO]` — ex: `P1.1.3`  
Priorité : 🔴 Bloquant | 🟡 Important | 🟢 Nice-to-have  
Estimation : en demi-journées de dev (0.5j = 4h)

---

## PHASE 1 : INFRASTRUCTURE BAS NIVEAU & ZERO-LATENCY (Le Câblage)

**Objectif :** Poser les fondations techniques qui permettent à TS et Rust de communiquer en < 1ms, ingérer les données Solana à ultra-faible latence, et exécuter des modèles ONNX depuis Rust.

**Durée estimée :** 8-12 jours  
**Prérequis :** Codebase V2 fonctionnelle (MarketScanner, Guard, DecisionCore, Sniper — ✅ existant)

### Sous-Phase 1.1 — Le Pont Bun ↔ Rust (FFI)

**Objectif :** Créer la couche de communication entre TypeScript (Bun) et le moteur d'inférence Rust. Tout le code Rust sera compilé en `.so` et chargé par Bun FFI.

---

#### Ticket P1.1.1 — Scaffolding du workspace Rust 🔴

**Description :** Créer le projet Rust avec Cargo, configurer la compilation en `cdylib` (shared library), et établir le Makefile/script de build.

**Fichiers cibles :**
```
rust_core/
├── Cargo.toml
├── Cargo.lock
├── build.sh              # Script de build → produit libapex_core.so
├── src/
│   ├── lib.rs            # Point d'entrée, exports FFI
│   ├── ffi.rs            # Toutes les fonctions extern "C"
│   ├── types.rs          # Structures de données partagées
│   └── utils.rs          # Helpers (logging, timing)
```

**Cargo.toml critique :**
```toml
[lib]
crate-type = ["cdylib"]   # Obligatoire pour .so

[profile.release]
opt-level = 3
lto = "fat"
codegen-units = 1          # Optimisation maximale
panic = "abort"            # Pas de stack unwinding en production
```

**Dépendances :** Aucune. Ticket fondation.  
**Estimation :** 0.5 jour

---

#### Ticket P1.1.2 — Bridge FFI côté TypeScript 🔴

**Description :** Créer le module TypeScript qui charge la `.so` Rust et expose les fonctions d'inférence comme des fonctions TS typées. Inclure le mécanisme de fallback si la `.so` n'est pas disponible.

**Fichiers cibles :**
```
src/
├── bridge/
│   ├── RustBridge.ts       # Classe principale, charge libapex_core.so
│   ├── types.ts            # Types FFI (FeatureVector, InferenceResult)
│   ├── fallback.ts         # Implémentation pure-TS si Rust indisponible
│   └── buffer-pool.ts      # Pool de Float64Array pré-alloués (anti-GC)
```

**API critique de `RustBridge.ts` :**
```typescript
interface RustBridge {
  // Hot path — appels synchrones < 100μs
  inferHMM(logReturn: number, realizedVol: number, ofi: number): Float64Array; // 4 state probabilities
  evalHawkesIntensity(events: Float64Array, now: number): [number, number]; // λ_buy, λ_sell
  inferTFT(featureSequence: Float64Array, seqLen: number): Float64Array; // predictions multi-horizon
  
  // Cold path — peut être async
  updateHawkesParams(params: Float64Array): void;
  loadONNXModel(modelPath: string): boolean;
}
```

**Contrainte GC :** Le `buffer-pool.ts` doit pré-allouer N `Float64Array` au démarrage et les recycler via un index rotatif. Jamais de `new Float64Array()` dans le hot path.

**Dépendances :** P1.1.1 (la `.so` doit exister)  
**Estimation :** 1.5 jours

---

#### Ticket P1.1.3 — Fonctions FFI Rust : Ping + Benchmark 🔴

**Description :** Implémenter les premières fonctions FFI pour valider le pont : un `ping()` qui retourne un timestamp, et un `bench_inference()` qui simule une charge de calcul et mesure la latence round-trip TS→Rust→TS.

**Fichiers cibles :**
```
rust_core/src/ffi.rs        # Ajout de apex_ping(), apex_bench()
src/bridge/RustBridge.ts    # Ajout des appels correspondants
scripts/bench-ffi.ts        # Script de benchmark
```

**Critère de succès :** Le round-trip TS→Rust→TS pour `ping()` est < 10μs. Le `bench_inference()` avec 12 multiplications f64 est < 1μs.

**Dépendances :** P1.1.1, P1.1.2  
**Estimation :** 0.5 jour

---

#### Ticket P1.1.4 — Buffer Pool Anti-GC 🔴

**Description :** Implémenter le pool de buffers pré-alloués qui élimine les allocations dans le hot path. Le pool gère des `Float64Array` de tailles fixes (12 features, 128×12 séquences TFT, 4 states HMM).

**Fichiers cibles :**
```
src/bridge/buffer-pool.ts   # Implémentation du pool
src/bridge/__tests__/        
│   └── buffer-pool.test.ts  # Tests unitaires
```

**Spécification :**
```typescript
class BufferPool {
  private pools: Map<number, Float64Array[]>; // taille → pool de buffers
  private indices: Map<number, number>;        // taille → index rotatif
  
  constructor(sizes: { size: number; count: number }[]) // pré-allocation
  acquire(size: number): Float64Array           // O(1), jamais d'allocation
  release(buffer: Float64Array): void           // remet dans le pool
}
```

**Dépendances :** Aucune (module autonome)  
**Estimation :** 0.5 jour

---

### Sous-Phase 1.2 — Ingestion Ultra-Latence (Yellowstone gRPC + Fallback)

**Objectif :** Remplacer le WebSocket `onLogs` actuel par un système dual gRPC/WebSocket avec basculement automatique.

---

#### Ticket P1.2.1 — Client Yellowstone gRPC 🔴

**Description :** Créer un client gRPC qui se connecte à Yellowstone pour recevoir les account updates des pools AMM (Raydium, Meteora) et les transactions de mint en temps réel.

**Fichiers cibles :**
```
src/ingestors/
├── GeyserStream.ts          # Client Yellowstone gRPC
├── StreamRouter.ts          # Routeur gRPC ↔ WebSocket avec failover
├── proto/                   # Fichiers .proto de Yellowstone (copiés)
│   └── geyser.proto
```

**Pattern de connexion :**
```typescript
class GeyserStream extends EventEmitter {
  private client: GrpcClient;
  private fallbackWs: Connection; // WebSocket natif Solana
  private isGrpcAlive: boolean = false;
  
  // Subscribe aux comptes de pools
  async subscribeAccounts(accounts: string[]): Promise<void>
  
  // Failover automatique
  private onGrpcDisconnect(): void {
    this.isGrpcAlive = false;
    this.activateWebSocketFallback(); // < 100ms de bascule
  }
}
```

**Alternative Guérilla :** Si gRPC n'est pas accessible (free tier), `GeyserStream` se comporte comme un wrapper autour de `accountSubscribe` WebSocket avec le même EventEmitter interface. Le reste du pipeline ne voit pas la différence.

**Dépendances :** Aucune (remplace progressivement MarketScanner)  
**Estimation :** 2 jours

---

#### Ticket P1.2.2 — StreamRouter avec RPC Racing amélioré 🟡

**Description :** Orchestrateur qui reçoit les events de GeyserStream, PumpScanner et du futur TelegramPulse, les déduplique et les route vers le DecisionCore avec les timestamps `t_source` / `t_recv` corrects.

**Fichiers cibles :**
```
src/ingestors/StreamRouter.ts    # Routeur central
src/types/index.ts               # Ajout de StreamEvent (union type)
```

**Fonctionnalités :**
- Déduplication par hash (pool_id + mint + block_slot)
- Timestamp `t_recv = performance.now()` capturé immédiatement
- Priority queue : gRPC events > WebSocket events > REST events
- Métriques : events/sec, latence moyenne par source, taux de duplication

**Dépendances :** P1.2.1  
**Estimation :** 1 jour

---

### Sous-Phase 1.3 — ONNX Runtime en Rust

**Objectif :** Intégrer ONNX Runtime dans le crate Rust pour pouvoir exécuter des modèles ML exportés depuis Python.

---

#### Ticket P1.3.1 — Intégration du crate `ort` 🔴

**Description :** Ajouter le crate `ort` (bindings Rust pour ONNX Runtime) au workspace, configurer le chargement de modèles `.onnx`, et implémenter une fonction FFI générique d'inférence.

**Fichiers cibles :**
```
rust_core/
├── Cargo.toml              # Ajout de ort = "2.x"
├── src/
│   ├── inference/
│   │   ├── mod.rs          # Module d'inférence
│   │   ├── onnx_engine.rs  # Wrapper ONNX Runtime
│   │   └── model_cache.rs  # Cache de sessions ONNX (pre-loaded)
│   ├── ffi.rs              # Nouvelles fonctions : apex_load_model, apex_infer
```

**API FFI :**
```rust
#[no_mangle]
pub extern "C" fn apex_load_model(path_ptr: *const c_char, model_id: u32) -> i32;

#[no_mangle]
pub extern "C" fn apex_infer(
    model_id: u32,
    input_ptr: *const f64,
    input_len: u32,
    output_ptr: *mut f64,
    output_len: u32,
) -> i32; // retourne 0 = OK, -1 = erreur
```

**Contrainte :** Les sessions ONNX doivent être créées au démarrage et cachées en mémoire. Créer une session par inférence coûte 10-50ms — inacceptable.

**Dépendances :** P1.1.1  
**Estimation :** 1.5 jours

---

#### Ticket P1.3.2 — Modèle Dummy + Benchmark d'inférence 🟡

**Description :** Créer un modèle ONNX "dummy" (linear regression, 12 inputs → 1 output) en Python, l'exporter, et mesurer la latence d'inférence via le bridge FFI.

**Fichiers cibles :**
```
python/
├── models/
│   └── export_dummy.py     # Script d'export ONNX
│   └── dummy_model.onnx    # Modèle exporté
scripts/
├── bench-onnx.ts           # Benchmark TS → Rust → ONNX → Rust → TS
```

**Critère de succès :** Inférence du modèle dummy en < 100μs round-trip.

**Dépendances :** P1.3.1, P1.1.2  
**Estimation :** 0.5 jour

---

### Sous-Phase 1.4 — Schéma de Base de Données V3 (Feature Store)

**Objectif :** Étendre le schéma Prisma/SQLite pour stocker les feature vectors historiques nécessaires au training des modèles ML.

---

#### Ticket P1.4.1 — Migration Prisma pour Feature Store 🔴

**Description :** Ajouter les tables nécessaires pour stocker chaque feature vector calculé, les outcomes (résultat du trade à T+5min), et les paramètres de modèle.

**Fichiers cibles :**
```
prisma/
├── schema.prisma           # Ajout des modèles ci-dessous
├── migrations/
│   └── YYYYMMDD_v3_feature_store/
```

**Nouveaux modèles Prisma :**
```prisma
model FeatureSnapshot {
  id            String   @id @default(uuid())
  mint          String
  timestamp     BigInt   // Unix ms
  
  // Features numériques (le vecteur complet)
  ofi           Float    // Order Flow Imbalance
  hawkesBuy     Float    // λ_buy(t)
  hawkesSell    Float    // λ_sell(t)
  hmmState0     Float    // P(Accumulation)
  hmmState1     Float    // P(Trending)
  hmmState2     Float    // P(Mania)
  hmmState3     Float    // P(Distribution)
  nlpScore      Float    // Sentiment NLP
  smartMoney    Float    // S_SM(t)
  realizedVol   Float    // Volatilité réalisée
  liquiditySol  Float
  priceUsdc     Float
  
  // Metadata
  latencyMs     Float    // Latence totale du pipeline
  source        String   // "grpc" | "websocket" | "pump"
  
  // Relation avec l'outcome
  outcome       TokenOutcome?
}

model TokenOutcome {
  id              String   @id @default(uuid())
  featureId       String   @unique
  feature         FeatureSnapshot @relation(fields: [featureId], references: [id])
  
  // Résultat à T+5min
  priceChange5m   Float    // % de changement
  maxDrawdown5m   Float    // Max drawdown dans la fenêtre
  volumeChange5m  Float    // Changement de volume
  label           String   // "WIN" | "LOSS" | "NEUTRAL"
  
  // Résultat à T+30min (pour TFT)
  priceChange30m  Float?
  
  createdAt       DateTime @default(now())
}

model ModelParams {
  id          String   @id @default(uuid())
  modelType   String   // "hmm" | "hawkes" | "tft" | "rl"
  version     Int
  params      Bytes    // Paramètres sérialisés (JSON ou binaire)
  metrics     String   // JSON des métriques de performance
  isActive    Boolean  @default(false)
  createdAt   DateTime @default(now())
}
```

**Dépendances :** Aucune  
**Estimation :** 1 jour

---

#### Ticket P1.4.2 — Feature Logger intégré au DecisionCore 🔴

**Description :** Modifier le `DecisionCore` pour logger automatiquement chaque feature vector dans la base de données après chaque décision. Ajouter un job asynchrone qui évalue l'outcome à T+5min et T+30min.

**Fichiers cibles :**
```
src/engine/DecisionCore.ts    # Ajout du logging après scoring
src/engine/OutcomeTracker.ts  # Job de labellisation asynchrone
```

**Contrainte de latence :** Le logging doit être fire-and-forget (pas de `await` sur le hot path). Utiliser un buffer en mémoire qui flush vers SQLite toutes les 5 secondes.

**Dépendances :** P1.4.1  
**Estimation :** 1 jour

---

### Résumé Phase 1 — Ordre de dépendance

```
P1.1.1 (Rust scaffold)
  ├── P1.1.2 (TS Bridge) ──── P1.1.3 (Ping/Bench)
  ├── P1.1.4 (Buffer Pool)
  └── P1.3.1 (ONNX Rust) ──── P1.3.2 (Bench ONNX)

P1.2.1 (Geyser gRPC) ──── P1.2.2 (StreamRouter)

P1.4.1 (Schema Prisma) ──── P1.4.2 (Feature Logger)
```

Les trois branches (FFI/ONNX, Ingestion, Database) sont **parallélisables**.

---

## PHASE 2 : L'OMNISCIENCE DATA (Feature Store & Ingestion)

**Objectif :** Construire le pipeline complet d'enrichissement des données : NLP temps réel via Groq, clustering de wallets Smart Money, calcul de l'Order Flow Imbalance, et alimentation du Feature Store.

**Durée estimée :** 10-14 jours  
**Prérequis :** Phase 1 complète (FFI bridge, gRPC, schéma DB)

---

#### Ticket P2.1.1 — Pipeline NLP Groq 3-Étages 🔴

**Description :** Implémenter le pipeline de traitement NLP en 3 étages pour les flux Telegram et X.

**Fichiers cibles :**
```
src/nlp/
├── NLPPipeline.ts          # Orchestrateur 3 étages
├── Stage0_Regex.ts         # Nettoyage déterministe (regex, lexiques)
├── Stage1_Embeddings.ts    # Classification via Groq (Qwen3-Small)
├── Stage2_Reasoning.ts     # Raisonnement profond via Groq (Llama-4)
├── BotDetector.ts          # Détection de fermes de bots
├── lexicons/
│   ├── crypto_tickers.json
│   └── spam_patterns.json
```

**Latence cible :** < 50ms pour Stage 0+1, < 200ms pour Stage 2 (déclenché seulement sur cas critiques).

**API Groq — Alternative Guérilla :** Le free tier Groq offre ~30 requêtes/minute sur les modèles ouverts. Pour tenir 30 req/min, le Stage 1 doit utiliser un modèle compact (Qwen3-Small ou Llama-3.2-1B) et le Stage 2 n'est déclenché que si Stage 1 retourne une confiance < 0.7.

**Dépendances :** TelegramPulse (existant dans V2)  
**Estimation :** 3 jours

---

#### Ticket P2.1.2 — Score de Viralité et Vélocité Sociale 🟡

**Description :** Calculer en temps réel la vélocité des mentions (mentions/30s), le score de viralité (accélération de la vélocité), et détecter les patterns de manipulation (burst soudain suivi de silence).

**Fichiers cibles :**
```
src/nlp/ViralityScorer.ts    # Calcul time-decay + vélocité
src/types/index.ts           # Ajout de ViralityScore interface
```

**Formule de vélocité avec time-decay :**
```
V(t) = Σ_i w_i × exp(-(t - t_i) / τ_social)
```
Où `w_i` est le poids de la mention (trust score de l'auteur × reach), `t_i` le timestamp, et `τ_social` = 30s.

**Dépendances :** P2.1.1  
**Estimation :** 1 jour

---

#### Ticket P2.2.1 — Wallet Clustering (Louvain en Rust) 🔴

**Description :** Implémenter l'algorithme de Louvain pour clusterer les wallets Smart Money. Le graphe est construit à partir des co-occurrences de transactions et des flux de financement.

**Fichiers cibles :**
```
rust_core/src/
├── clustering/
│   ├── mod.rs
│   ├── louvain.rs          # Algorithme de Louvain
│   ├── graph.rs            # Structure de graphe sparse
│   └── smart_money.rs      # Score de confiance ρ(w) par cluster
src/bridge/RustBridge.ts    # Ajout de updateGraph(), getClusterScore()
```

**Pattern d'utilisation :** Le graphe est mis à jour incrementalement (ajout d'arêtes quand de nouvelles transactions sont observées). Le re-clustering est déclenché toutes les N minutes (cold path). Les scores ρ(w) sont cachés en mémoire côté Rust.

**Formule Smart Money :**
```
S_SM(t) = Σ_{w ∈ Clusters} ρ(w) × Σ_{k ∈ trades(w)} v_k × exp(-(t - t_k) / τ_sm)
```

**Dépendances :** P1.1.1, P1.1.2 (FFI bridge)  
**Estimation :** 3 jours

---

#### Ticket P2.2.2 — Tracker de Smart Money en Temps Réel 🟡

**Description :** Surveiller les transactions des clusters identifiés en temps réel via `accountSubscribe` sur les wallets les plus actifs de chaque cluster.

**Fichiers cibles :**
```
src/ingestors/SmartMoneyTracker.ts  # Surveillance temps réel
src/types/index.ts                   # Ajout de SmartMoneySignal
```

**Limite Guérilla :** On ne peut pas surveiller 10 000 wallets simultanément (rate limits RPC). Surveiller les top 50-100 wallets les plus fiables (ρ(w) > seuil), et enrichir le reste via des batch queries toutes les 30s.

**Dépendances :** P2.2.1, P1.2.1  
**Estimation :** 2 jours

---

#### Ticket P2.3.1 — Calcul de l'Order Flow Imbalance (OFI) 🔴

**Description :** Calculer l'OFI en temps réel à partir des changements de réserves des pools AMM. L'OFI mesure le déséquilibre entre pression d'achat et de vente.

**Fichiers cibles :**
```
src/features/OFICalculator.ts      # Calcul OFI temps réel
rust_core/src/features/
│   ├── mod.rs
│   └── ofi.rs                     # Version Rust haute performance
```

**Formule OFI :**
```
OFI(t) = Σ_{i=1}^{N} [ΔBid_i × 1(ΔBid_i > 0) - ΔAsk_i × 1(ΔAsk_i > 0)]
```

Adapté aux AMM : les "bids" et "asks" sont dérivés des changements de réserves SOL et token dans les pools.

**Dépendances :** P1.2.1 (flux de données des pools)  
**Estimation :** 1.5 jours

---

#### Ticket P2.4.1 — Assemblage du Feature Vector 🔴

**Description :** Créer le module qui assemble toutes les features en un vecteur normalisé prêt pour l'inférence. Gère le staleness (timestamp par feature) et la normalisation.

**Fichiers cibles :**
```
src/features/FeatureAssembler.ts   # Assemblage + normalisation
src/types/index.ts                  # FeatureVector interface
```

**Interface :**
```typescript
interface FeatureVector {
  values: Float64Array;      // 12 features normalisées
  timestamps: BigInt64Array; // Unix ms par feature
  maxStalenessMs: number;    // Plus vieille feature
  mint: string;
  assembledAt: number;       // Unix ms
}
```

**Dépendances :** P2.1.1, P2.2.1, P2.3.1  
**Estimation :** 1 jour

---

## PHASE 3 : LE CERVEAU MATHÉMATIQUE (Modélisation Rust/Python)

**Objectif :** Implémenter les modèles de prédiction (HMM, Hawkes, TFT) en Rust pour le hot path et en Python pour le training, puis les connecter au pipeline via ONNX et FFI.

**Durée estimée :** 12-18 jours  
**Prérequis :** Phase 1 (FFI, ONNX) + Phase 2 (Feature Store rempli avec des données historiques)

---

#### Ticket P3.1.1 — HMM 4-États en Rust (Hamilton Filter) 🔴

**Description :** Implémenter le Hidden Markov Model à 4 états (Accumulation, Trending, Mania, Distribution) avec filtrage de Hamilton en Rust pur. Pas de dépendance externe.

**Fichiers cibles :**
```
rust_core/src/models/
├── mod.rs
├── hmm.rs                 # HMM implementation
│                          # - struct HMMParams { transition, means, variances }
│                          # - fn hamilton_filter(obs, params) → [f64; 4]
│                          # - fn viterbi(observations, params) → Vec<usize>
├── hmm_ffi.rs             # Fonctions FFI pour HMM
```

**FFI exports :**
```rust
#[no_mangle]
pub extern "C" fn apex_hmm_filter(
    log_return: f64,
    realized_vol: f64,
    ofi: f64,
    state_probs_out: *mut f64,  // [f64; 4] output
) -> i32;

#[no_mangle]
pub extern "C" fn apex_hmm_load_params(params_ptr: *const f64, len: u32) -> i32;
```

**Latence cible :** < 5μs par appel.

**Dépendances :** P1.1.1  
**Estimation :** 2 jours

---

#### Ticket P3.1.2 — Training HMM en Python (Baum-Welch) 🟡

**Description :** Script Python pour estimer les paramètres du HMM sur les données historiques du Feature Store.

**Fichiers cibles :**
```
python/
├── training/
│   ├── hmm_trainer.py     # Baum-Welch sur données historiques
│   ├── hmm_export.py      # Export des paramètres → format binaire pour Rust
│   └── hmm_backtest.py    # Validation des régimes détectés
```

**Dépendances :** P1.4.1 (Feature Store rempli), P3.1.1  
**Estimation :** 1.5 jours

---

#### Ticket P3.2.1 — Processus de Hawkes bivarié en Rust 🔴

**Description :** Implémenter l'évaluation de l'intensité λ(t) du processus de Hawkes bivarié en Rust. Les paramètres (μ, α, β) sont estimés offline en Python.

**Fichiers cibles :**
```
rust_core/src/models/
├── hawkes.rs              # Hawkes process implementation
│                          # - struct HawkesParams { mu, alpha, beta }
│                          # - fn eval_intensity(events, now) → (f64, f64)
│                          # - fn update_events(new_event) → ()
├── hawkes_ffi.rs          # FFI exports
```

**Gestion de l'historique :** Ring buffer interne de taille fixe (1024 events). Les events plus vieux que 10 minutes sont éjectés. Le noyau exponentiel rend les anciens events négligeables de toute façon.

**Latence cible :** < 100μs par évaluation.

**Dépendances :** P1.1.1  
**Estimation :** 2 jours

---

#### Ticket P3.2.2 — Calibration Hawkes en Python (MLE) 🟡

**Description :** Script Python pour l'estimation des paramètres du processus de Hawkes par maximum de vraisemblance sur les données historiques.

**Fichiers cibles :**
```
python/training/
├── hawkes_trainer.py      # MLE optimization (scipy.optimize)
├── hawkes_export.py       # Export params → binaire pour Rust
```

**Dépendances :** P1.4.1, P3.2.1  
**Estimation :** 1.5 jours

---

#### Ticket P3.3.1 — Training TFT en Python (PyTorch) 🔴

**Description :** Entraîner un Temporal Fusion Transformer compact sur les données du Feature Store pour prédire le prix à T+5min et T+30min.

**Fichiers cibles :**
```
python/
├── models/
│   ├── tft_model.py       # Architecture TFT compacte
│   │                      # hidden_dim=64, num_heads=4, num_layers=2
│   ├── tft_dataset.py     # DataLoader depuis Feature Store
│   ├── tft_train.py       # Boucle de training
│   └── tft_export.py      # Export → ONNX
├── configs/
│   └── tft_config.yaml    # Hyperparamètres
```

**Contraintes de taille du modèle :**
- hidden_dim : 64 (pas 128 ou 512)
- num_attention_layers : 2 (pas 6)
- Séquence d'entrée : 128 timestamps (pas 512)
- Taille ONNX cible : < 10MB

**Dépendances :** P1.4.1 (besoin de ~10K samples minimum dans le Feature Store)  
**Estimation :** 4 jours (inclut les itérations de tuning)

---

#### Ticket P3.3.2 — Export TFT → ONNX et validation Rust 🔴

**Description :** Exporter le modèle TFT entraîné en format ONNX et valider que l'inférence Rust via le crate `ort` produit les mêmes résultats que PyTorch (à la précision float32 près).

**Fichiers cibles :**
```
python/models/tft_export.py   # torch.onnx.export avec opset 17
rust_core/src/models/
├── tft.rs                    # Wrapper ONNX pour TFT
├── tft_ffi.rs                # FFI exports
scripts/bench-tft.ts          # Benchmark TS → Rust/ONNX → TS
```

**Pièges d'export ONNX :**
- Les Variable Selection Networks (VSN) utilisent `softmax` qui doit être tracé statiquement
- Le GRN (Gated Residual Network) utilise du gating multiplicatif — vérifier que le graph ONNX est correct
- Utiliser `torch.onnx.export(model, dummy_input, dynamic_axes={"input": {0: "batch"}})`

**Critère de succès :** Inférence ONNX en < 5ms, divergence vs PyTorch < 1e-5.

**Dépendances :** P3.3.1, P1.3.1  
**Estimation :** 1.5 jours

---

#### Ticket P3.4.1 — AIBrain : Orchestrateur d'Inférence 🔴

**Description :** Le module central qui orchestre tous les modèles (HMM, Hawkes, TFT) et produit la décision finale. C'est le remplacement du scoring linéaire actuel de `DecisionCore.calculateFinalScore()`.

**Fichiers cibles :**
```
src/engine/AIBrain.ts          # Orchestrateur d'inférence
```

**Pipeline d'inférence (hot path, budget 10ms) :**
```
1. HMM filter         → régime + probas (< 10μs via FFI)
2. Hawkes intensity   → λ_buy, λ_sell    (< 100μs via FFI)
3. TFT prediction     → price forecast   (< 5ms via FFI/ONNX)
4. Kelly sizing       → f* position size  (< 1μs, calcul TS)
5. Decision           → BUY / SKIP / SELL (< 1μs)
─────────────────────────────────────────────────────
Total budget :                            < 10ms
```

**Dépendances :** P3.1.1, P3.2.1, P3.3.2, P1.1.2  
**Estimation :** 2 jours

---

## PHASE 4 : EXÉCUTION & RISK MANAGEMENT (Le Bras Armé)

**Objectif :** Upgrader le Sniper pour utiliser les Jito Bundles optimisés (et préparer BAM), implémenter le Kelly Fractionnel dynamique, et intégrer Drift Protocol pour le trading perpétuel.

**Durée estimée :** 8-12 jours  
**Prérequis :** Phase 3 (AIBrain fonctionnel)

---

#### Ticket P4.1.1 — Kelly Fractionnel Dynamique 🔴

**Description :** Implémenter le critère de Kelly fractionnel dont le coefficient η est ajusté par le régime HMM.

**Fichiers cibles :**
```
src/risk/KellyEngine.ts       # Calcul de f* avec η dynamique
src/types/index.ts            # Ajout de PositionSizing interface
```

**Formule :**
```
f* = η(regime) × (b×p - q) / b
```

**Table η par régime :**
| Régime | η | Justification |
|--------|---|---------------|
| Accumulation | 0.3 | Confiance modérée |
| Trending | 0.5 | Maximum agressivité |
| Mania | 0.1 | Retournements brutaux |
| Distribution | 0.15 | Phase de sortie |

**Dépendances :** P3.1.1 (HMM), P3.4.1 (AIBrain)  
**Estimation :** 1 jour

---

#### Ticket P4.1.2 — CVaR Risk Manager 🔴

**Description :** Implémenter le calcul de la Conditional Value-at-Risk (CVaR) pour pénaliser les queues de distribution négatives dans la décision de trading.

**Fichiers cibles :**
```
src/risk/CVaRManager.ts       # Calcul CVaR sur historique récent
```

**Calcul :** CVaR au niveau α = 5% sur les 100 derniers trades. Si CVaR dépasse un seuil (-15% par défaut), réduire η de 50%.

**Dépendances :** P1.4.1 (historique des trades)  
**Estimation :** 1 jour

---

#### Ticket P4.2.1 — Sniper V3 : Jito Bundles Optimisés 🔴

**Description :** Réécrire le Sniper pour optimiser les tips Jito dynamiquement basé sur la congestion réseau mesurée et le régime HMM.

**Fichiers cibles :**
```
src/executor/SniperV3.ts       # Sniper amélioré
src/executor/JitoTipOracle.ts  # Estimation dynamique du tip optimal
```

**Tips dynamiques :**
```typescript
function calculateOptimalTip(regime: string, congestion: number): number {
  const baseTip = congestion * 0.001; // SOL, proportionnel à la congestion
  const regimeMultiplier = {
    'Accumulation': 1.0,
    'Trending': 1.5,
    'Mania': 3.0,       // Surenchère nécessaire en mania
    'Distribution': 0.5  // Économiser en distribution
  };
  return Math.min(baseTip * regimeMultiplier[regime], 0.05); // Cap à 0.05 SOL
}
```

**Dépendances :** P3.4.1, Sniper V2 existant  
**Estimation :** 2 jours

---

#### Ticket P4.2.2 — Préparation BAM / ACE (Interface abstraite) 🟢

**Description :** Créer une interface abstraite `ExecutionStrategy` qui permet de basculer entre Jito Bundles classiques et BAM quand l'API sera stable.

**Fichiers cibles :**
```
src/executor/
├── ExecutionStrategy.ts       # Interface abstraite
├── JitoBundleStrategy.ts      # Implémentation actuelle
├── JitoBAMStrategy.ts         # Stub pour migration future
```

**Dépendances :** P4.2.1  
**Estimation :** 0.5 jour

---

#### Ticket P4.3.1 — Intégration Drift Protocol 🟡

**Description :** Intégrer le SDK Drift pour le monitoring de marge et l'envoi d'ordres perpétuels.

**Fichiers cibles :**
```
src/perps/
├── DriftConnector.ts         # SDK wrapper
├── MarginMonitor.ts          # Surveillance du health factor
├── LiquidationGuard.ts       # Dérisquage proactif
```

**Logique de dérisquage :**
```
Si healthFactor < 1.3 → fermer 25% de la position
Si healthFactor < 1.1 → fermer 75% de la position
Si healthFactor < 1.05 → fermer 100% (urgence)
```

**Dépendances :** Aucune (module autonome, connecté au pipeline en Phase 5)  
**Estimation :** 3 jours

---

#### Ticket P4.4.1 — Reward Function Logger 🔴

**Description :** Implémenter le calcul et le logging de la Reward Function qui sera utilisée pour entraîner l'agent RL en Phase 5.

**Fichiers cibles :**
```
src/engine/RewardLogger.ts    # Calcul R_i pour chaque trade
```

**Formule :**
```
R_i = [log(1 + r_i) - λ_c × C_i - λ_r × CVaR_α(D) - λ_f × 1[fail]] / Growth
```

Chaque trade exécuté génère un record avec les inputs (features au moment de la décision) et le reward R_i calculé a posteriori. Ce dataset est la base du training RL.

**Dépendances :** P4.1.2, P1.4.1  
**Estimation :** 1 jour

---

## PHASE 5 : LA BOUCLE D'APPRENTISSAGE (RL Cold Path)

**Objectif :** Mettre en place l'agent RL (PPO) qui apprend en tâche de fond à partir des trades historiques et met à jour les poids du modèle de décision en production via un mécanisme de hot-swap.

**Durée estimée :** 14-20 jours  
**Prérequis :** Phases 1-4, dataset de 5000+ trades labelisés dans le Feature Store

---

#### Ticket P5.1.1 — Environnement Gym pour Trading 🔴

**Description :** Créer un environnement OpenAI Gym custom qui simule le pipeline de trading pour l'entraînement RL.

**Fichiers cibles :**
```
python/rl/
├── trading_env.py           # Gym environment
│   # State: Feature Vector (12 dim)
│   # Actions: [BUY, SKIP, SELL] × [0.1f*, 0.25f*, 0.5f*, f*]
│   # Reward: R_i formula
├── replay_buffer.py         # Experience replay
├── data_loader.py           # Charge depuis Feature Store
```

**Dépendances :** P4.4.1 (Reward Logger), P1.4.1  
**Estimation :** 3 jours

---

#### Ticket P5.1.2 — Agent PPO (Proximal Policy Optimization) 🔴

**Description :** Implémenter l'agent PPO avec CVaR constraint dans la loss function.

**Fichiers cibles :**
```
python/rl/
├── ppo_agent.py             # Agent PPO
├── networks.py              # Policy + Value networks
├── cvar_loss.py             # CVaR-constrained objective
├── train_ppo.py             # Boucle de training
```

**Architecture du réseau :**
- Input : Feature Vector (12 dim)
- Hidden : 2 couches × 128 units, ReLU
- Policy head : 12 actions (3 directions × 4 sizing)
- Value head : 1 output (state value)

**Dépendances :** P5.1.1  
**Estimation :** 4 jours

---

#### Ticket P5.2.1 — Shadow Mode 🔴

**Description :** Mode où l'agent RL tourne en parallèle du système live, fait ses prédictions, mais n'exécute PAS de trades. Compare ses décisions vs les décisions du système V3 actif.

**Fichiers cibles :**
```
src/engine/ShadowAgent.ts     # Agent shadow (reçoit les features, prédit, log)
python/rl/shadow_eval.py      # Évaluation : agent RL vs heuristique V3
```

**Métriques de validation :**
- Sharpe Ratio simulé de l'agent RL vs système actif
- Max Drawdown simulé
- Win rate
- Si l'agent RL > système actif sur 1000+ trades → éligible pour promotion

**Dépendances :** P5.1.2, P3.4.1  
**Estimation :** 2 jours

---

#### Ticket P5.2.2 — Hot-Swap des Poids en Production 🔴

**Description :** Mécanisme pour mettre à jour les poids du modèle d'inférence Rust sans redémarrer le bot. Le nouveau modèle est chargé en mémoire pendant que l'ancien continue de servir, puis bascule atomiquement.

**Fichiers cibles :**
```
rust_core/src/inference/
├── model_cache.rs           # Double-buffer pour hot-swap
src/engine/ModelUpdater.ts   # Watcher de fichier + signal FFI
```

**Pattern Double-Buffer :**
```rust
struct ModelCache {
    active: AtomicUsize,      // 0 ou 1
    models: [Option<Session>; 2], // Deux slots
}

fn hot_swap(&mut self, new_model_path: &str) {
    let inactive = 1 - self.active.load(Ordering::Acquire);
    self.models[inactive] = Some(load_onnx(new_model_path));
    self.active.store(inactive, Ordering::Release); // Bascule atomique
}
```

**Dépendances :** P1.3.1, P5.2.1  
**Estimation :** 2 jours

---

#### Ticket P5.3.1 — Boucle de Retraining Automatique 🟡

**Description :** Cron job qui re-entraîne les modèles (HMM, Hawkes, TFT, PPO) sur les nouvelles données accumulées et déclenche le hot-swap si les performances sont supérieures.

**Fichiers cibles :**
```
python/
├── retrain_pipeline.py      # Orchestrateur de retraining
├── model_registry.py        # Versionning des modèles
scripts/
├── cron-retrain.sh          # Script cron (toutes les 6h)
```

**Logique :**
```
1. Charger les 24h de données les plus récentes du Feature Store
2. Re-entraîner HMM, Hawkes, TFT, PPO
3. Évaluer sur holdout set (20% des données)
4. Si Sharpe > Sharpe_actuel × 1.05 → promouvoir le nouveau modèle
5. Copier le .onnx dans le dossier surveillé par ModelUpdater
6. Le hot-swap s'exécute automatiquement
```

**Dépendances :** P5.2.2, P5.1.2, P3.3.1  
**Estimation :** 3 jours

---

#### Ticket P5.4.1 — Transition S&P 500 (Interface Asset-Agnostic) 🟢

**Description :** Refactorer les interfaces pour supporter des assets non-Solana (actions, ETFs) via Alpaca Markets API.

**Fichiers cibles :**
```
src/connectors/
├── AssetConnector.ts        # Interface abstraite
├── SolanaConnector.ts       # Implémentation Solana (existant, refactoré)
├── AlpacaConnector.ts       # Implémentation S&P 500
```

**Dépendances :** Phases 1-4 stabilisées  
**Estimation :** 3 jours

---

## RÉSUMÉ GLOBAL — MATRICE DE DÉPENDANCES

```
PHASE 1 (8-12j)
 ├── 1.1 FFI Bridge      ─┐
 ├── 1.2 gRPC Ingestion   │── Parallélisables
 ├── 1.3 ONNX Runtime     │
 └── 1.4 Feature Store DB ─┘

PHASE 2 (10-14j) ← dépend de Phase 1
 ├── 2.1 NLP Pipeline    ← P1.2 (flux de données)
 ├── 2.2 Smart Money     ← P1.1 (FFI pour Louvain)
 ├── 2.3 OFI Calculator  ← P1.2 (flux AMM)
 └── 2.4 Feature Vector  ← P2.1 + P2.2 + P2.3

PHASE 3 (12-18j) ← dépend de Phase 1 + Phase 2 partielle
 ├── 3.1 HMM Rust        ← P1.1 seulement
 ├── 3.2 Hawkes Rust     ← P1.1 seulement
 ├── 3.3 TFT Python→ONNX ← P1.3 + P1.4 (besoin de données)
 └── 3.4 AIBrain         ← P3.1 + P3.2 + P3.3

PHASE 4 (8-12j) ← dépend de Phase 3
 ├── 4.1 Kelly + CVaR    ← P3.1 (HMM regime)
 ├── 4.2 Sniper V3       ← P3.4 (AIBrain)
 ├── 4.3 Drift Protocol  ← Indépendant
 └── 4.4 Reward Logger   ← P4.1 + P4.2

PHASE 5 (14-20j) ← dépend de Phase 4 + dataset
 ├── 5.1 RL Agent        ← P4.4 (Reward data)
 ├── 5.2 Shadow + Swap   ← P5.1 + P1.3
 ├── 5.3 Auto-Retrain    ← P5.2
 └── 5.4 S&P 500         ← Phases 1-4 stables
```

**Durée totale estimée : 52-76 jours** (1 développeur temps plein)  
**Avec 2 développeurs parallélisant Phase 1 : 40-58 jours**

---

## ANNEXE : ARBRE DE FICHIERS CIBLE V3

```
apex-2026/
├── src/                          # TypeScript (Bun)
│   ├── app.ts                    # Point d'entrée (existant, modifié)
│   ├── types/
│   │   └── index.ts              # Types unifiés V3
│   ├── bridge/
│   │   ├── RustBridge.ts         # FFI bridge
│   │   ├── buffer-pool.ts        # Anti-GC buffer pool
│   │   ├── types.ts              # Types FFI
│   │   └── fallback.ts           # Pure-TS fallback
│   ├── ingestors/
│   │   ├── GeyserStream.ts       # Yellowstone gRPC
│   │   ├── StreamRouter.ts       # Routeur central
│   │   ├── MarketScanner.ts      # (existant, gardé comme fallback)
│   │   ├── PumpScanner.ts        # (existant)
│   │   ├── TelegramPulse.ts      # (existant)
│   │   └── SmartMoneyTracker.ts  # Nouveau
│   ├── nlp/
│   │   ├── NLPPipeline.ts        # Pipeline 3-étages
│   │   ├── Stage0_Regex.ts
│   │   ├── Stage1_Embeddings.ts
│   │   ├── Stage2_Reasoning.ts
│   │   ├── BotDetector.ts
│   │   └── ViralityScorer.ts
│   ├── features/
│   │   ├── OFICalculator.ts
│   │   └── FeatureAssembler.ts
│   ├── engine/
│   │   ├── DecisionCore.ts       # (existant, modifié)
│   │   ├── AIBrain.ts            # Nouveau — orchestrateur IA
│   │   ├── OutcomeTracker.ts     # Labellisation T+5/30min
│   │   ├── RewardLogger.ts       # R_i pour RL
│   │   ├── ShadowAgent.ts        # Agent shadow RL
│   │   └── ModelUpdater.ts       # Hot-swap watcher
│   ├── risk/
│   │   ├── KellyEngine.ts
│   │   └── CVaRManager.ts
│   ├── executor/
│   │   ├── Sniper.ts             # (existant, gardé)
│   │   ├── SniperV3.ts           # Nouveau — tips dynamiques
│   │   ├── ExecutionStrategy.ts  # Interface abstraite
│   │   ├── JitoBundleStrategy.ts
│   │   ├── JitoBAMStrategy.ts    # Stub
│   │   └── JitoTipOracle.ts
│   ├── perps/
│   │   ├── DriftConnector.ts
│   │   ├── MarginMonitor.ts
│   │   └── LiquidationGuard.ts
│   ├── connectors/
│   │   ├── AssetConnector.ts     # Interface abstraite
│   │   ├── SolanaConnector.ts
│   │   └── AlpacaConnector.ts
│   └── detectors/
│       └── Guard.ts              # (existant)
│
├── rust_core/                    # Rust (compilé → .so)
│   ├── Cargo.toml
│   ├── build.sh
│   └── src/
│       ├── lib.rs
│       ├── ffi.rs                # Exports extern "C"
│       ├── types.rs
│       ├── utils.rs
│       ├── models/
│       │   ├── mod.rs
│       │   ├── hmm.rs
│       │   ├── hmm_ffi.rs
│       │   ├── hawkes.rs
│       │   ├── hawkes_ffi.rs
│       │   ├── tft.rs
│       │   └── tft_ffi.rs
│       ├── clustering/
│       │   ├── mod.rs
│       │   ├── louvain.rs
│       │   ├── graph.rs
│       │   └── smart_money.rs
│       ├── features/
│       │   ├── mod.rs
│       │   └── ofi.rs
│       └── inference/
│           ├── mod.rs
│           ├── onnx_engine.rs
│           └── model_cache.rs
│
├── python/                       # Python (training + offline)
│   ├── requirements.txt
│   ├── models/
│   │   ├── tft_model.py
│   │   ├── tft_dataset.py
│   │   ├── tft_train.py
│   │   ├── tft_export.py
│   │   └── export_dummy.py
│   ├── training/
│   │   ├── hmm_trainer.py
│   │   ├── hmm_export.py
│   │   ├── hawkes_trainer.py
│   │   └── hawkes_export.py
│   ├── rl/
│   │   ├── trading_env.py
│   │   ├── ppo_agent.py
│   │   ├── networks.py
│   │   ├── cvar_loss.py
│   │   ├── train_ppo.py
│   │   ├── replay_buffer.py
│   │   ├── data_loader.py
│   │   └── shadow_eval.py
│   ├── retrain_pipeline.py
│   └── model_registry.py
│
├── prisma/
│   └── schema.prisma             # V3 avec Feature Store
│
├── scripts/
│   ├── bench-ffi.ts
│   ├── bench-onnx.ts
│   ├── bench-tft.ts
│   ├── cron-retrain.sh
│   └── (scripts existants)
│
├── models/                       # Fichiers ONNX produits
│   ├── tft_compact.onnx
│   ├── dummy_model.onnx
│   └── hmm_params.bin
│
└── docs/
    ├── ARCHITECTURE.md           # (existant, mis à jour)
    ├── V3_AUDIT.md               # Ce document
    └── ROADMAP.md
```

---

**FIN DU DOCUMENT — APEX-2026 V3 AUDIT & ROADMAP**

*Ce plan est conçu pour être exécuté par ticket, dans l'ordre de dépendance, avec validation après chaque sous-phase. Aucun ticket ne dépend d'un composant non spécifié. Aucune magie.*