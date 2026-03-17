"""
replay_buffer.py — APEX-2026 Phase 5 (P5.1.1)

Experience replay buffer for PPO training.
Stores (state, action, reward, next_state, done, log_prob, value) tuples.

Uses numpy ring buffer for memory efficiency.
Supports batch sampling and GAE (Generalized Advantage Estimation).
"""

import numpy as np
from typing import Optional


class ReplayBuffer:
    """Fixed-size ring buffer for on-policy PPO trajectories."""

    def __init__(self, capacity: int, state_dim: int, gamma: float = 0.99, gae_lambda: float = 0.95):
        self.capacity = capacity
        self.state_dim = state_dim
        self.gamma = gamma
        self.gae_lambda = gae_lambda

        self.states = np.zeros((capacity, state_dim), dtype=np.float32)
        self.actions = np.zeros(capacity, dtype=np.int32)
        self.rewards = np.zeros(capacity, dtype=np.float32)
        self.values = np.zeros(capacity, dtype=np.float32)
        self.log_probs = np.zeros(capacity, dtype=np.float32)
        self.dones = np.zeros(capacity, dtype=np.float32)
        self.advantages = np.zeros(capacity, dtype=np.float32)
        self.returns = np.zeros(capacity, dtype=np.float32)

        self.ptr = 0
        self.size = 0
        self.trajectory_start = 0

    def store(
        self,
        state: np.ndarray,
        action: int,
        reward: float,
        value: float,
        log_prob: float,
        done: bool,
    ) -> None:
        idx = self.ptr % self.capacity
        self.states[idx] = state
        self.actions[idx] = action
        self.rewards[idx] = reward
        self.values[idx] = value
        self.log_probs[idx] = log_prob
        self.dones[idx] = float(done)
        self.ptr += 1
        self.size = min(self.size + 1, self.capacity)

    def finish_trajectory(self, last_value: float = 0.0) -> None:
        """Compute GAE advantages and returns for the current trajectory."""
        path_start = self.trajectory_start
        path_end = self.ptr

        if path_end <= path_start:
            return

        indices = [i % self.capacity for i in range(path_start, path_end)]
        rewards = np.array([self.rewards[i] for i in indices])
        values = np.array([self.values[i] for i in indices])
        dones = np.array([self.dones[i] for i in indices])

        n = len(indices)
        advantages = np.zeros(n, dtype=np.float32)
        gae = 0.0

        for t in reversed(range(n)):
            next_val = last_value if t == n - 1 else values[t + 1]
            next_done = 0.0 if t == n - 1 else dones[t + 1]
            delta = rewards[t] + self.gamma * next_val * (1 - next_done) - values[t]
            gae = delta + self.gamma * self.gae_lambda * (1 - next_done) * gae
            advantages[t] = gae

        returns = advantages + values

        for k, idx in enumerate(indices):
            self.advantages[idx] = advantages[k]
            self.returns[idx] = returns[k]

        self.trajectory_start = self.ptr

    def get_batch(self) -> dict:
        """Return all stored transitions as a batch dict."""
        indices = [i % self.capacity for i in range(max(0, self.ptr - self.size), self.ptr)]

        # Normalize advantages
        advs = self.advantages[indices]
        adv_mean = advs.mean()
        adv_std = advs.std()
        if adv_std > 1e-8:
            advs = (advs - adv_mean) / adv_std

        return {
            "states": self.states[indices].copy(),
            "actions": self.actions[indices].copy(),
            "rewards": self.rewards[indices].copy(),
            "log_probs": self.log_probs[indices].copy(),
            "advantages": advs.copy(),
            "returns": self.returns[indices].copy(),
            "values": self.values[indices].copy(),
        }

    def clear(self) -> None:
        self.ptr = 0
        self.size = 0
        self.trajectory_start = 0

    def __len__(self) -> int:
        return self.size
