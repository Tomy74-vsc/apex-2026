"""
ppo_agent.py — APEX-2026 Phase 5 (P5.1.2)

Proximal Policy Optimization agent with CVaR constraint.

Collects trajectories from TradingEnv, computes GAE advantages,
then updates the ActorCritic network using the clipped objective.
"""

import torch
import numpy as np
from pathlib import Path
from typing import Optional

from .networks import ActorCritic, OBSERVATION_DIM, NUM_ACTIONS
from .replay_buffer import ReplayBuffer
from .cvar_loss import ppo_cvar_loss


class PPOAgent:
    """PPO agent for trading with CVaR risk constraint."""

    def __init__(
        self,
        obs_dim: int = OBSERVATION_DIM,
        n_actions: int = NUM_ACTIONS,
        lr: float = 3e-4,
        gamma: float = 0.99,
        gae_lambda: float = 0.95,
        clip_epsilon: float = 0.2,
        value_coeff: float = 0.5,
        entropy_coeff: float = 0.01,
        cvar_beta: float = 0.5,
        max_grad_norm: float = 0.5,
        buffer_size: int = 4096,
        batch_size: int = 256,
        n_epochs: int = 4,
        device: str = "cpu",
    ):
        self.device = torch.device(device)
        self.gamma = gamma
        self.gae_lambda = gae_lambda
        self.clip_epsilon = clip_epsilon
        self.value_coeff = value_coeff
        self.entropy_coeff = entropy_coeff
        self.cvar_beta = cvar_beta
        self.max_grad_norm = max_grad_norm
        self.batch_size = batch_size
        self.n_epochs = n_epochs

        self.network = ActorCritic(obs_dim, n_actions).to(self.device)
        self.optimizer = torch.optim.Adam(self.network.parameters(), lr=lr, eps=1e-5)

        self.buffer = ReplayBuffer(buffer_size, obs_dim, gamma, gae_lambda)

        self.train_stats = {
            "updates": 0,
            "total_episodes": 0,
            "avg_reward": 0.0,
            "avg_sharpe": 0.0,
        }

    def select_action(self, obs: np.ndarray, deterministic: bool = False) -> tuple:
        """Select action given observation. Returns (action, log_prob, value)."""
        obs_tensor = torch.FloatTensor(obs).unsqueeze(0).to(self.device)
        with torch.no_grad():
            action, log_prob, value = self.network.get_action(obs_tensor, deterministic)
        return action, log_prob, value

    def store_transition(
        self, state: np.ndarray, action: int, reward: float, value: float, log_prob: float, done: bool
    ) -> None:
        self.buffer.store(state, action, reward, value, log_prob, done)

    def finish_episode(self, last_value: float = 0.0) -> None:
        self.buffer.finish_trajectory(last_value)
        self.train_stats["total_episodes"] += 1

    def update(self) -> dict:
        """Run PPO update on collected experience."""
        if len(self.buffer) < self.batch_size:
            return {"skipped": True}

        batch = self.buffer.get_batch()
        states = torch.FloatTensor(batch["states"]).to(self.device)
        actions = torch.LongTensor(batch["actions"]).to(self.device)
        old_log_probs = torch.FloatTensor(batch["log_probs"]).to(self.device)
        advantages = torch.FloatTensor(batch["advantages"]).to(self.device)
        returns = torch.FloatTensor(batch["returns"]).to(self.device)
        rewards = torch.FloatTensor(batch["rewards"]).to(self.device)

        n = states.shape[0]
        all_metrics = []

        for epoch in range(self.n_epochs):
            indices = np.random.permutation(n)

            for start in range(0, n, self.batch_size):
                end = min(start + self.batch_size, n)
                mb_idx = indices[start:end]

                mb_states = states[mb_idx]
                mb_actions = actions[mb_idx]
                mb_old_log_probs = old_log_probs[mb_idx]
                mb_advantages = advantages[mb_idx]
                mb_returns = returns[mb_idx]
                mb_rewards = rewards[mb_idx]

                log_probs, values, entropy = self.network.evaluate_actions(mb_states, mb_actions)

                loss_dict = ppo_cvar_loss(
                    log_probs=log_probs,
                    old_log_probs=mb_old_log_probs,
                    advantages=mb_advantages,
                    values=values,
                    returns=mb_returns,
                    entropy=entropy,
                    rewards=mb_rewards,
                    clip_epsilon=self.clip_epsilon,
                    value_coeff=self.value_coeff,
                    entropy_coeff=self.entropy_coeff,
                    cvar_beta=self.cvar_beta,
                )

                self.optimizer.zero_grad()
                loss_dict["total_loss"].backward()
                torch.nn.utils.clip_grad_norm_(self.network.parameters(), self.max_grad_norm)
                self.optimizer.step()

                all_metrics.append(loss_dict["metrics"])

        self.buffer.clear()
        self.train_stats["updates"] += 1

        avg_metrics = {}
        if all_metrics:
            for key in all_metrics[0]:
                avg_metrics[key] = np.mean([m[key] for m in all_metrics])

        return {"skipped": False, **avg_metrics}

    def save(self, path: str) -> None:
        torch.save({
            "network": self.network.state_dict(),
            "optimizer": self.optimizer.state_dict(),
            "stats": self.train_stats,
        }, path)
        print(f"✅ Agent saved to {path}")

    def load(self, path: str) -> None:
        checkpoint = torch.load(path, map_location=self.device, weights_only=True)
        self.network.load_state_dict(checkpoint["network"])
        self.optimizer.load_state_dict(checkpoint["optimizer"])
        self.train_stats = checkpoint.get("stats", self.train_stats)
        print(f"✅ Agent loaded from {path}")

    def export_onnx(self, path: str) -> None:
        self.network.export_onnx(path)
