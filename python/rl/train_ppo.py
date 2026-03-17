"""
train_ppo.py — APEX-2026 Phase 5 (P5.1.2)

Main training loop for PPO agent on TradingEnv.

Usage:
  python -m rl.train_ppo --db ../data/apex.db --episodes 1000

Flow:
  1. Load data from Feature Store (data_loader)
  2. Create TradingEnv
  3. Train PPO agent with CVaR constraint
  4. Export best model to ONNX
"""

import argparse
import time
import numpy as np
from pathlib import Path

from .data_loader import load_feature_store, compute_rewards
from .trading_env import make_trading_env
from .ppo_agent import PPOAgent


def train(
    db_path: str,
    n_episodes: int = 1000,
    max_steps: int = 500,
    hours: float = 168.0,
    lr: float = 3e-4,
    save_dir: str = "models",
    eval_interval: int = 50,
) -> None:
    print("╔══════════════════════════════════════════════════════════╗")
    print("║       APEX-2026 — PPO Training Pipeline                 ║")
    print("╚══════════════════════════════════════════════════════════╝\n")

    # Load data
    data = load_feature_store(db_path=db_path, min_samples=50, hours=hours)
    if data["features"].shape[0] < 50:
        print("❌ Insufficient data for training. Need at least 50 labeled samples.")
        return

    rewards = compute_rewards(data["price_change_5m"])
    features = data["features"]
    price_changes = data["price_change_5m"]

    print(f"\n📊 Dataset: {features.shape[0]} samples, {features.shape[1]} features")
    print(f"   Reward: mean={rewards.mean():.4f}, std={rewards.std():.4f}")

    # Split train/eval (80/20)
    split = int(features.shape[0] * 0.8)
    train_features, eval_features = features[:split], features[split:]
    train_pc, eval_pc = price_changes[:split], price_changes[split:]

    print(f"   Train: {train_features.shape[0]}, Eval: {eval_features.shape[0]}\n")

    # Create env
    env = make_trading_env(train_features, train_pc, max_steps=max_steps)
    eval_env = make_trading_env(eval_features, eval_pc, max_steps=min(max_steps, eval_features.shape[0]))

    # Create agent
    agent = PPOAgent(
        obs_dim=env.observation_space.shape[0],
        n_actions=env.action_space.n,
        lr=lr,
        buffer_size=max_steps * 8,
        batch_size=256,
        n_epochs=4,
    )

    save_path = Path(save_dir)
    save_path.mkdir(parents=True, exist_ok=True)

    best_sharpe = -np.inf
    episode_rewards = []

    t_start = time.time()

    for episode in range(1, n_episodes + 1):
        obs, info = env.reset()
        done = False
        ep_reward = 0.0

        while not done:
            action, log_prob, value = agent.select_action(obs)
            next_obs, reward, terminated, truncated, info = env.step(action)
            done = terminated or truncated

            agent.store_transition(obs, action, reward, value, log_prob, done)
            obs = next_obs
            ep_reward += reward

        # Get final value for GAE
        _, _, last_value = agent.select_action(obs, deterministic=True)
        agent.finish_episode(last_value=0.0 if done else last_value)
        episode_rewards.append(ep_reward)

        # Update policy when buffer has enough data
        update_info = agent.update()

        if episode % 10 == 0:
            avg_reward = np.mean(episode_rewards[-10:])
            elapsed = time.time() - t_start
            eps_per_sec = episode / elapsed
            print(
                f"  Episode {episode:4d}/{n_episodes} | "
                f"reward={avg_reward:+.3f} | "
                f"sharpe={info.get('sharpe', 0):.2f} | "
                f"buys={info.get('n_buys', 0)} | "
                f"bankroll={info.get('bankroll', 1.0):.3f} | "
                f"{eps_per_sec:.1f} ep/s"
            )

        # Evaluate
        if episode % eval_interval == 0:
            eval_sharpe = evaluate(agent, eval_env, n_eval=5)
            print(f"\n  📊 Eval Sharpe: {eval_sharpe:.3f} (best: {best_sharpe:.3f})")

            if eval_sharpe > best_sharpe:
                best_sharpe = eval_sharpe
                agent.save(str(save_path / "ppo_best.pt"))
                agent.export_onnx(str(save_path / "ppo_best.onnx"))
                print(f"  🏆 New best model saved!\n")
            else:
                print()

    # Final save
    agent.save(str(save_path / "ppo_final.pt"))
    agent.export_onnx(str(save_path / "ppo_final.onnx"))

    elapsed = time.time() - t_start
    print(f"\n✅ Training complete in {elapsed:.0f}s")
    print(f"   Best eval Sharpe: {best_sharpe:.3f}")
    print(f"   Total updates: {agent.train_stats['updates']}")


def evaluate(agent: PPOAgent, env, n_eval: int = 5) -> float:
    """Run deterministic evaluation episodes."""
    sharpes = []
    for _ in range(n_eval):
        obs, info = env.reset()
        done = False
        while not done:
            action, _, _ = agent.select_action(obs, deterministic=True)
            obs, _, terminated, truncated, info = env.step(action)
            done = terminated or truncated
        sharpes.append(info.get("sharpe", 0.0))
    return float(np.mean(sharpes))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="APEX-2026 PPO Training")
    parser.add_argument("--db", type=str, default=None, help="Path to apex.db")
    parser.add_argument("--episodes", type=int, default=1000)
    parser.add_argument("--max-steps", type=int, default=500)
    parser.add_argument("--hours", type=float, default=168.0)
    parser.add_argument("--lr", type=float, default=3e-4)
    parser.add_argument("--save-dir", type=str, default="models")
    parser.add_argument("--eval-interval", type=int, default=50)
    args = parser.parse_args()

    train(
        db_path=args.db,
        n_episodes=args.episodes,
        max_steps=args.max_steps,
        hours=args.hours,
        lr=args.lr,
        save_dir=args.save_dir,
        eval_interval=args.eval_interval,
    )
