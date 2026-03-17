"""
model_registry.py — APEX-2026 Phase 5 (P5.3.1)

Versioned model registry. Tracks which models are active,
their Sharpe ratios, and training metadata.

Persists to a JSON file in the models directory.
"""

import json
from pathlib import Path
from datetime import datetime
from typing import Optional


class ModelRegistry:
    """Track and version ML models."""

    def __init__(self, models_dir: str = "models"):
        self.models_dir = Path(models_dir)
        self.registry_path = self.models_dir / "registry.json"
        self.models_dir.mkdir(parents=True, exist_ok=True)
        self.data = self._load()

    def _load(self) -> dict:
        if self.registry_path.exists():
            with open(self.registry_path) as f:
                return json.load(f)
        return {"models": [], "active": {}}

    def _save(self) -> None:
        with open(self.registry_path, "w") as f:
            json.dump(self.data, f, indent=2)

    def register(
        self,
        model_type: str,
        filename: str,
        sharpe: float,
        metadata: Optional[dict] = None,
    ) -> dict:
        """Register a new model version."""
        version = len([m for m in self.data["models"] if m["type"] == model_type]) + 1

        entry = {
            "type": model_type,
            "version": version,
            "filename": filename,
            "sharpe": sharpe,
            "metadata": metadata or {},
            "registered_at": datetime.now().isoformat(),
            "is_active": True,
        }

        # Deactivate previous active model of same type
        for m in self.data["models"]:
            if m["type"] == model_type and m.get("is_active"):
                m["is_active"] = False

        self.data["models"].append(entry)
        self.data["active"][model_type] = {
            "version": version,
            "filename": filename,
            "sharpe": sharpe,
        }

        self._save()
        print(f"✅ Registered {model_type} v{version}: {filename} (Sharpe={sharpe:.3f})")
        return entry

    def get_current_sharpe(self, model_type: str) -> float:
        """Get the Sharpe ratio of the currently active model."""
        active = self.data.get("active", {}).get(model_type)
        if active:
            return active.get("sharpe", 0.0)
        return 0.0

    def get_active_model(self, model_type: str) -> Optional[dict]:
        """Get info about the currently active model."""
        return self.data.get("active", {}).get(model_type)

    def get_history(self, model_type: str, limit: int = 10) -> list:
        """Get version history for a model type."""
        entries = [m for m in self.data["models"] if m["type"] == model_type]
        return entries[-limit:]

    def summary(self) -> str:
        """Human-readable summary."""
        lines = ["📋 Model Registry:"]
        for model_type, info in self.data.get("active", {}).items():
            lines.append(
                f"  {model_type}: v{info['version']} — "
                f"{info['filename']} (Sharpe={info['sharpe']:.3f})"
            )
        total = len(self.data["models"])
        lines.append(f"  Total models tracked: {total}")
        return "\n".join(lines)


if __name__ == "__main__":
    registry = ModelRegistry("models")
    print(registry.summary())
