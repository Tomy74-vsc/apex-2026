"""
networks.py — APEX-2026 Phase 5 (P5.1.2)

Policy and Value networks for PPO agent.

Architecture (from roadmap):
  - Input: 12 features + 3 augmented = 15 dim
  - Hidden: 2 × 128 units, ReLU
  - Policy head: 12 actions (3 directions × 4 sizing) — softmax
  - Value head: 1 output — scalar state value

Designed to be exported to ONNX for Rust inference.
"""

import torch
import torch.nn as nn
from torch.distributions import Categorical
from typing import Tuple


OBSERVATION_DIM = 15   # 12 features + bankroll + position + step_frac
NUM_ACTIONS = 12       # 3 directions × 4 sizing
HIDDEN_DIM = 128


class ActorCritic(nn.Module):
    """Combined Actor-Critic network for PPO."""

    def __init__(
        self,
        obs_dim: int = OBSERVATION_DIM,
        n_actions: int = NUM_ACTIONS,
        hidden_dim: int = HIDDEN_DIM,
    ):
        super().__init__()

        self.shared = nn.Sequential(
            nn.Linear(obs_dim, hidden_dim),
            nn.ReLU(),
            nn.Linear(hidden_dim, hidden_dim),
            nn.ReLU(),
        )

        self.policy_head = nn.Sequential(
            nn.Linear(hidden_dim, n_actions),
        )

        self.value_head = nn.Sequential(
            nn.Linear(hidden_dim, 1),
        )

        self._init_weights()

    def _init_weights(self) -> None:
        for m in self.modules():
            if isinstance(m, nn.Linear):
                nn.init.orthogonal_(m.weight, gain=0.01 if m == self.policy_head[-1] else 1.0)
                nn.init.zeros_(m.bias)

    def forward(self, obs: torch.Tensor) -> Tuple[torch.Tensor, torch.Tensor]:
        """Returns (action_logits, state_value)."""
        h = self.shared(obs)
        logits = self.policy_head(h)
        value = self.value_head(h).squeeze(-1)
        return logits, value

    def get_action(
        self, obs: torch.Tensor, deterministic: bool = False
    ) -> Tuple[int, float, float]:
        """
        Select action from policy.

        Returns: (action, log_prob, value)
        """
        logits, value = self.forward(obs)
        dist = Categorical(logits=logits)

        if deterministic:
            action = logits.argmax(dim=-1)
        else:
            action = dist.sample()

        log_prob = dist.log_prob(action)
        return int(action.item()), float(log_prob.item()), float(value.item())

    def evaluate_actions(
        self, obs: torch.Tensor, actions: torch.Tensor
    ) -> Tuple[torch.Tensor, torch.Tensor, torch.Tensor]:
        """
        Evaluate actions for PPO update.

        Returns: (log_probs, values, entropy)
        """
        logits, values = self.forward(obs)
        dist = Categorical(logits=logits)
        log_probs = dist.log_prob(actions)
        entropy = dist.entropy()
        return log_probs, values, entropy

    def export_onnx(self, path: str) -> None:
        """Export to ONNX for Rust inference."""
        dummy_input = torch.randn(1, OBSERVATION_DIM)
        torch.onnx.export(
            self,
            dummy_input,
            path,
            input_names=["observation"],
            output_names=["action_logits", "state_value"],
            dynamic_axes={
                "observation": {0: "batch_size"},
                "action_logits": {0: "batch_size"},
                "state_value": {0: "batch_size"},
            },
            opset_version=17,
        )
        print(f"✅ Exported ONNX model to {path}")
