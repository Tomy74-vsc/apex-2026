"""
retrain_pipeline.py — APEX-2026 Phase 5 (P5.3.1)

Automated retraining pipeline. Run as cron every 6 hours.

Flow:
  1. Load last 24h of data from Feature Store
  2. Re-train PPO agent
  3. Evaluate on holdout set (20%)
  4. If Sharpe > current_sharpe × 1.05 → promote new model
  5. Copy .onnx to models/ directory (ModelUpdater hot-swaps automatically)

Usage:
  python retrain_pipeline.py --db data/apex.db --models-dir models/
"""

import argparse
import shutil
import time
from pathlib import Path
from datetime import datetime

from rl.data_loader import load_feature_store, compute_rewards
from rl.trading_env import make_trading_env
from rl.ppo_agent import PPOAgent
from model_registry import ModelRegistry


PROMOTION_SHARPE_MARGIN = 1.05
MIN_SAMPLES = 200
TRAIN_EPISODES = 500
MAX_STEPS = 400
EVAL_EPISODES = 20


def retrain(
    db_path: str,
    models_dir: str = "models",
    hours: float = 24.0,
) -> dict:
    """Run the full retraining pipeline."""
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    print(f"\n{'='*60}")
    print(f"🔄 APEX-2026 — Retrain Pipeline ({timestamp})")
    print(f"{'='*60}\n")

    registry = ModelRegistry(models_dir)
    models_path = Path(models_dir)
    models_path.mkdir(parents=True, exist_ok=True)

    # 1. Load data
    print("📥 Loading data from Feature Store...")
    data = load_feature_store(db_path=db_path, min_samples=MIN_SAMPLES, hours=hours)

    if data["features"].shape[0] < MIN_SAMPLES:
        print(f"⚠️  Only {data['features'].shape[0]} samples — need {MIN_SAMPLES}. Skipping retrain.")
        return {"status": "skipped", "reason": "insufficient_data"}

    features = data["features"]
    price_changes = data["price_change_5m"]
    n_samples = features.shape[0]

    # 2. Train/eval split (80/20)
    split = int(n_samples * 0.8)
    train_feat, eval_feat = features[:split], features[split:]
    train_pc, eval_pc = price_changes[:split], price_changes[split:]

    print(f"   Samples: {n_samples} (train={split}, eval={n_samples - split})")

    # 3. Train new PPO agent
    print("\n🏋️ Training PPO agent...")
    t_start = time.time()

    env = make_trading_env(train_feat, train_pc, max_steps=MAX_STEPS)
    eval_env = make_trading_env(eval_feat, eval_pc, max_steps=min(MAX_STEPS, eval_feat.shape[0]))

    agent = PPOAgent(
        obs_dim=env.observation_space.shape[0],
        n_actions=env.action_space.n,
        buffer_size=MAX_STEPS * 8,
    )

    # Load previous best as starting point
    prev_model = models_path / "ppo_best.pt"
    if prev_model.exists():
        try:
            agent.load(str(prev_model))
            print("   Loaded previous best model as starting point")
        except Exception as e:
            print(f"   ⚠️  Could not load previous model: {e}")

    best_eval_sharpe = -float("inf")

    for episode in range(1, TRAIN_EPISODES + 1):
        obs, info = env.reset()
        done = False

        while not done:
            action, log_prob, value = agent.select_action(obs)
            next_obs, reward, terminated, truncated, info = env.step(action)
            done = terminated or truncated
            agent.store_transition(obs, action, reward, value, log_prob, done)
            obs = next_obs

        _, _, last_val = agent.select_action(obs, deterministic=True)
        agent.finish_episode(last_value=0.0 if done else last_val)
        agent.update()

        if episode % 100 == 0:
            eval_sharpe = evaluate_agent(agent, eval_env)
            print(f"   Episode {episode}/{TRAIN_EPISODES} — eval Sharpe: {eval_sharpe:.3f}")
            if eval_sharpe > best_eval_sharpe:
                best_eval_sharpe = eval_sharpe

    train_time = time.time() - t_start
    print(f"   Training complete in {train_time:.0f}s — best eval Sharpe: {best_eval_sharpe:.3f}")

    # 4. Final evaluation
    final_sharpe = evaluate_agent(agent, eval_env, n_eval=EVAL_EPISODES)
    print(f"\n📊 Final evaluation ({EVAL_EPISODES} episodes): Sharpe = {final_sharpe:.3f}")

    # 5. Compare with current best
    current_sharpe = registry.get_current_sharpe("ppo")
    print(f"   Current production Sharpe: {current_sharpe:.3f}")
    print(f"   Threshold for promotion: {current_sharpe * PROMOTION_SHARPE_MARGIN:.3f}")

    if final_sharpe > current_sharpe * PROMOTION_SHARPE_MARGIN:
        print("\n🏆 NEW MODEL PROMOTED!")
        model_filename = f"ppo_{timestamp}.onnx"
        candidate_path = models_path / f"ppo_candidate_{timestamp}"

        # Save checkpoint
        agent.save(str(candidate_path) + ".pt")

        # Export ONNX
        onnx_path = models_path / model_filename
        agent.export_onnx(str(onnx_path))

        # Copy as new best
        shutil.copy2(str(onnx_path), str(models_path / "ppo_best.onnx"))
        agent.save(str(models_path / "ppo_best.pt"))

        # Register in model registry
        registry.register(
            model_type="ppo",
            filename=model_filename,
            sharpe=final_sharpe,
            metadata={
                "train_samples": split,
                "eval_samples": n_samples - split,
                "train_episodes": TRAIN_EPISODES,
                "train_time_s": train_time,
                "hours_window": hours,
            },
        )

        return {
            "status": "promoted",
            "sharpe": final_sharpe,
            "previous_sharpe": current_sharpe,
            "model_file": model_filename,
            "train_time": train_time,
        }
    else:
        print("\n⏭️  Model not promoted (insufficient improvement)")
        return {
            "status": "not_promoted",
            "sharpe": final_sharpe,
            "current_sharpe": current_sharpe,
            "threshold": current_sharpe * PROMOTION_SHARPE_MARGIN,
        }


def evaluate_agent(agent: PPOAgent, env, n_eval: int = 10) -> float:
    sharpes = []
    for _ in range(n_eval):
        obs, _ = env.reset()
        done = False
        while not done:
            action, _, _ = agent.select_action(obs, deterministic=True)
            obs, _, terminated, truncated, info = env.step(action)
            done = terminated or truncated
        sharpes.append(info.get("sharpe", 0.0))

    import numpy as np
    return float(np.mean(sharpes))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="APEX-2026 Retrain Pipeline")
    parser.add_argument("--db", type=str, default="data/apex.db")
    parser.add_argument("--models-dir", type=str, default="models")
    parser.add_argument("--hours", type=float, default=24.0)
    args = parser.parse_args()

    result = retrain(
        db_path=args.db,
        models_dir=args.models_dir,
        hours=args.hours,
    )
    print(f"\n📋 Result: {result}")
