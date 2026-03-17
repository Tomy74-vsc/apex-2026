"""
cvar_loss.py — APEX-2026 Phase 5 (P5.1.2)

CVaR-constrained PPO objective function.

Standard PPO clipped objective + CVaR penalty:
  L = L_clip - β × max(0, CVaR_α - CVaR_threshold)

This encourages the policy to avoid trades with extreme tail risk
while still maximizing expected returns.
"""

import torch
import torch.nn.functional as F


def ppo_cvar_loss(
    log_probs: torch.Tensor,
    old_log_probs: torch.Tensor,
    advantages: torch.Tensor,
    values: torch.Tensor,
    returns: torch.Tensor,
    entropy: torch.Tensor,
    rewards: torch.Tensor,
    clip_epsilon: float = 0.2,
    value_coeff: float = 0.5,
    entropy_coeff: float = 0.01,
    cvar_alpha: float = 0.05,
    cvar_threshold: float = -0.10,
    cvar_beta: float = 0.5,
) -> dict:
    """
    Compute PPO loss with CVaR constraint.

    Returns dict with:
      - total_loss: combined loss for backprop
      - policy_loss: clipped surrogate
      - value_loss: MSE on returns
      - entropy_loss: entropy bonus
      - cvar_penalty: CVaR constraint penalty
      - metrics: dict with diagnostic values
    """
    # PPO clipped surrogate
    ratio = torch.exp(log_probs - old_log_probs)
    surr1 = ratio * advantages
    surr2 = torch.clamp(ratio, 1.0 - clip_epsilon, 1.0 + clip_epsilon) * advantages
    policy_loss = -torch.min(surr1, surr2).mean()

    # Value loss (clipped)
    value_loss = F.mse_loss(values, returns)

    # Entropy bonus (encourages exploration)
    entropy_loss = -entropy.mean()

    # CVaR penalty on rewards
    cvar_penalty = torch.tensor(0.0, device=rewards.device)
    if rewards.numel() > 10:
        n_tail = max(1, int(rewards.numel() * cvar_alpha))
        sorted_rewards, _ = torch.sort(rewards)
        tail_mean = sorted_rewards[:n_tail].mean()
        cvar_penalty = cvar_beta * F.relu(cvar_threshold - tail_mean)

    total_loss = (
        policy_loss
        + value_coeff * value_loss
        + entropy_coeff * entropy_loss
        + cvar_penalty
    )

    approx_kl = (old_log_probs - log_probs).mean().item()
    clip_frac = ((ratio - 1.0).abs() > clip_epsilon).float().mean().item()

    return {
        "total_loss": total_loss,
        "policy_loss": policy_loss,
        "value_loss": value_loss,
        "entropy_loss": entropy_loss,
        "cvar_penalty": cvar_penalty,
        "metrics": {
            "approx_kl": approx_kl,
            "clip_fraction": clip_frac,
            "mean_ratio": ratio.mean().item(),
            "mean_advantage": advantages.mean().item(),
            "mean_entropy": entropy.mean().item(),
        },
    }
