"""
trading_env.py — APEX-2026 Phase 5 (P5.1.1)

Custom Gymnasium environment for RL-based trading.

State:  12-dim feature vector (from Feature Store)
Actions: 12 discrete = 3 directions × 4 sizing
  - Directions: BUY(0), SKIP(1), SELL(2)
  - Sizing: 0.1f*(0), 0.25f*(1), 0.5f*(2), 1.0f*(3)
  - Action index = direction * 4 + sizing

Reward: R_i = log(1 + r_i) - λ_c × C_i - λ_r × |CVaR| - λ_f × 1[fail]

Episode = sequence of N trading decisions on historical data.
"""

import gymnasium as gym
from gymnasium import spaces
import numpy as np
from typing import Optional, Any

FEATURE_DIM = 12
NUM_DIRECTIONS = 3   # BUY, SKIP, SELL
NUM_SIZING = 4        # 0.1f*, 0.25f*, 0.5f*, 1.0f*
NUM_ACTIONS = NUM_DIRECTIONS * NUM_SIZING  # 12

SIZING_FRACTIONS = [0.10, 0.25, 0.50, 1.00]
DIRECTIONS = ["BUY", "SKIP", "SELL"]

# Cost parameters
LAMBDA_COST = 2.0
LAMBDA_RISK = 1.0
LAMBDA_FAIL = 5.0
BASE_COST = 0.003  # 30bps slippage + fees


class TradingEnv(gym.Env):
    """
    Simulated trading environment using historical feature snapshots.
    Each step the agent observes a feature vector and chooses an action.
    """

    metadata = {"render_modes": ["human"]}

    def __init__(
        self,
        features: np.ndarray,
        price_changes: np.ndarray,
        initial_bankroll: float = 1.0,
        max_steps: Optional[int] = None,
        cvar_window: int = 50,
    ):
        super().__init__()

        assert features.shape[0] == price_changes.shape[0], "features and price_changes must match"
        assert features.shape[1] == FEATURE_DIM, f"Expected {FEATURE_DIM} features, got {features.shape[1]}"

        self.features = features.astype(np.float32)
        self.price_changes = price_changes.astype(np.float32)
        self.n_samples = features.shape[0]
        self.initial_bankroll = initial_bankroll
        self.max_steps = max_steps or self.n_samples
        self.cvar_window = cvar_window

        self.observation_space = spaces.Box(
            low=-np.inf, high=np.inf,
            shape=(FEATURE_DIM + 3,),  # 12 features + bankroll + position + step_frac
            dtype=np.float32,
        )
        self.action_space = spaces.Discrete(NUM_ACTIONS)

        self._reset_state()

    def _reset_state(self) -> None:
        self.step_idx = 0
        self.bankroll = self.initial_bankroll
        self.position = 0.0  # current position in SOL
        self.trade_returns: list[float] = []
        self.total_reward = 0.0
        self.n_buys = 0
        self.n_sells = 0
        self.n_skips = 0

    def reset(
        self,
        seed: Optional[int] = None,
        options: Optional[dict] = None,
    ) -> tuple[np.ndarray, dict]:
        super().reset(seed=seed)
        self._reset_state()

        # Random start point (leave room for episode)
        max_start = max(0, self.n_samples - self.max_steps)
        if max_start > 0:
            self.step_idx = self.np_random.integers(0, max_start)

        obs = self._get_obs()
        info = self._get_info()
        return obs, info

    def step(self, action: int) -> tuple[np.ndarray, float, bool, bool, dict]:
        direction_idx = action // NUM_SIZING
        sizing_idx = action % NUM_SIZING
        sizing = SIZING_FRACTIONS[sizing_idx]
        direction = DIRECTIONS[direction_idx]

        price_change = self.price_changes[self.step_idx]
        reward = 0.0

        if direction == "BUY":
            position_frac = sizing
            trade_return = price_change * position_frac
            cost = BASE_COST * position_frac
            reward = self._compute_reward(trade_return, cost, failed=False)
            self.bankroll *= (1 + trade_return - cost)
            self.trade_returns.append(trade_return)
            self.n_buys += 1

        elif direction == "SELL":
            position_frac = sizing
            trade_return = -price_change * position_frac
            cost = BASE_COST * position_frac
            reward = self._compute_reward(trade_return, cost, failed=False)
            self.bankroll *= (1 + trade_return - cost)
            self.trade_returns.append(trade_return)
            self.n_sells += 1

        else:  # SKIP
            reward = 0.0
            self.n_skips += 1

        self.total_reward += reward
        self.step_idx += 1

        terminated = self.bankroll <= 0.01  # bankrupt
        truncated = self.step_idx >= min(self.n_samples, self.max_steps + (self.step_idx - len(self.trade_returns)))

        obs = self._get_obs()
        info = self._get_info()

        return obs, float(reward), terminated, truncated, info

    def _compute_reward(self, trade_return: float, cost: float, failed: bool) -> float:
        log_ret = np.log(1 + np.clip(trade_return, -0.99, 10.0))
        cost_penalty = LAMBDA_COST * cost
        cvar_penalty = LAMBDA_RISK * self._compute_cvar()
        fail_penalty = LAMBDA_FAIL if failed else 0.0
        growth = max(0.01, self.bankroll / self.initial_bankroll)
        return float((log_ret - cost_penalty - cvar_penalty - fail_penalty) / growth)

    def _compute_cvar(self, alpha: float = 0.05) -> float:
        if len(self.trade_returns) < 5:
            return 0.0
        recent = self.trade_returns[-self.cvar_window:]
        sorted_rets = sorted(recent)
        tail_count = max(1, int(len(sorted_rets) * alpha))
        tail = sorted_rets[:tail_count]
        return abs(np.mean(tail))

    def _get_obs(self) -> np.ndarray:
        idx = min(self.step_idx, self.n_samples - 1)
        feat = self.features[idx]
        extra = np.array([
            self.bankroll / self.initial_bankroll,
            self.position,
            self.step_idx / max(1, self.max_steps),
        ], dtype=np.float32)
        return np.concatenate([feat, extra])

    def _get_info(self) -> dict:
        return {
            "bankroll": self.bankroll,
            "total_reward": self.total_reward,
            "n_buys": self.n_buys,
            "n_sells": self.n_sells,
            "n_skips": self.n_skips,
            "sharpe": self._compute_sharpe(),
        }

    def _compute_sharpe(self) -> float:
        if len(self.trade_returns) < 5:
            return 0.0
        rets = np.array(self.trade_returns)
        mean = rets.mean()
        std = rets.std()
        if std < 1e-8:
            return 0.0
        return float(mean / std * np.sqrt(252 * 24 * 12))  # annualized (5min bars)


# Factory for creating env from Feature Store data
def make_trading_env(
    features: np.ndarray,
    price_changes: np.ndarray,
    initial_bankroll: float = 1.0,
    max_steps: int = 1000,
) -> TradingEnv:
    return TradingEnv(
        features=features,
        price_changes=price_changes,
        initial_bankroll=initial_bankroll,
        max_steps=max_steps,
    )
