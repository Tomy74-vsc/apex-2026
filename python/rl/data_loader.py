"""
data_loader.py — APEX-2026 Phase 5 (P5.1.1)

Loads labeled feature snapshots + outcomes from the SQLite Feature Store
and converts them into tensors for RL training.

Expected tables in data/apex.db:
  - feature_snapshots: 12-dim feature vectors per token
  - token_outcomes: T+5m, T+30m price changes + labels

Returns:
  - features: np.ndarray (N, 12) — normalized feature vectors
  - rewards: np.ndarray (N,) — computed R_i values
  - actions_taken: np.ndarray (N,) — action index (from reward_logs if available)
"""

import sqlite3
import numpy as np
from pathlib import Path
from typing import Optional

FEATURE_COLUMNS = [
    "ofi", "hawkes_buy", "hawkes_sell",
    "hmm_state0", "hmm_state1", "hmm_state2", "hmm_state3",
    "nlp_score", "smart_money", "realized_vol",
    "liquidity_sol", "price_usdc",
]

FEATURE_DIM = 12


def load_feature_store(
    db_path: Optional[str] = None,
    min_samples: int = 100,
    hours: float = 24.0,
) -> dict:
    """
    Load labeled feature snapshots with outcomes.

    Returns dict with keys:
      - features: (N, 12) float32
      - labels: (N,) int  — 0=LOSS, 1=NEUTRAL, 2=WIN
      - price_change_5m: (N,) float32
      - price_change_30m: (N,) float32
      - mints: list[str]
      - timestamps: (N,) int64
    """
    if db_path is None:
        db_path = str(Path(__file__).parent.parent.parent / "data" / "apex.db")

    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row

    cutoff_ms = int((np.datetime64("now") - np.timedelta64(int(hours * 3600), "s")).astype("int64") * 1000)

    query = """
        SELECT
            fs.mint,
            fs.timestamp_ms,
            fs.ofi, fs.hawkes_buy, fs.hawkes_sell,
            fs.hmm_state0, fs.hmm_state1, fs.hmm_state2, fs.hmm_state3,
            fs.nlp_score, fs.smart_money, fs.realized_vol,
            fs.liquidity_sol, fs.price_usdc,
            o.price_change_5m, o.price_change_30m, o.label
        FROM feature_snapshots fs
        JOIN token_outcomes o ON o.feature_id = fs.id
        WHERE fs.timestamp_ms >= ?
        ORDER BY fs.timestamp_ms ASC
    """

    rows = conn.execute(query, (cutoff_ms,)).fetchall()
    conn.close()

    if len(rows) < min_samples:
        print(f"⚠️  Only {len(rows)} samples (need {min_samples}). "
              "Returning empty dataset.")
        return {
            "features": np.zeros((0, FEATURE_DIM), dtype=np.float32),
            "labels": np.zeros(0, dtype=np.int32),
            "price_change_5m": np.zeros(0, dtype=np.float32),
            "price_change_30m": np.zeros(0, dtype=np.float32),
            "mints": [],
            "timestamps": np.zeros(0, dtype=np.int64),
        }

    features = np.zeros((len(rows), FEATURE_DIM), dtype=np.float32)
    labels = np.zeros(len(rows), dtype=np.int32)
    pc5 = np.zeros(len(rows), dtype=np.float32)
    pc30 = np.zeros(len(rows), dtype=np.float32)
    mints = []
    timestamps = np.zeros(len(rows), dtype=np.int64)

    label_map = {"LOSS": 0, "NEUTRAL": 1, "WIN": 2}

    for i, row in enumerate(rows):
        for j, col in enumerate(FEATURE_COLUMNS):
            features[i, j] = float(row[col] or 0)
        labels[i] = label_map.get(row["label"], 1)
        pc5[i] = float(row["price_change_5m"] or 0)
        pc30[i] = float(row["price_change_30m"] or 0) if row["price_change_30m"] is not None else 0
        mints.append(row["mint"])
        timestamps[i] = int(row["timestamp_ms"])

    # Normalize features (z-score per column)
    mean = features.mean(axis=0, keepdims=True)
    std = features.std(axis=0, keepdims=True)
    std[std < 1e-8] = 1.0
    features = (features - mean) / std

    print(f"✅ Loaded {len(rows)} labeled samples ({hours}h window)")
    print(f"   WIN: {(labels == 2).sum()} | NEUTRAL: {(labels == 1).sum()} | LOSS: {(labels == 0).sum()}")

    return {
        "features": features,
        "labels": labels,
        "price_change_5m": pc5,
        "price_change_30m": pc30,
        "mints": mints,
        "timestamps": timestamps,
        "feature_mean": mean.flatten(),
        "feature_std": std.flatten(),
    }


def compute_rewards(
    price_changes: np.ndarray,
    cost_per_trade: float = 0.003,
    cvar_penalty: float = 0.01,
) -> np.ndarray:
    """
    Compute R_i reward for each sample.
    Simplified: R_i = log(1 + price_change) - cost - cvar_penalty * |drawdown|
    """
    log_returns = np.log(1 + np.clip(price_changes, -0.99, 10.0))
    rewards = log_returns - cost_per_trade - cvar_penalty * np.abs(np.minimum(price_changes, 0))
    return rewards.astype(np.float32)


if __name__ == "__main__":
    data = load_feature_store(hours=168)  # 7 days
    if data["features"].shape[0] > 0:
        rewards = compute_rewards(data["price_change_5m"])
        print(f"\n📊 Reward stats:")
        print(f"   mean={rewards.mean():.4f}, std={rewards.std():.4f}")
        print(f"   min={rewards.min():.4f}, max={rewards.max():.4f}")
