"""Local model metadata without engine imports, discovery, or GPU ownership."""
import json
from pathlib import Path

DS4_MODEL_METADATA = {
    "tunnel-model": {
        "name": "DeepSeek V4 Flash",
        "context_length": 1048576,
        "max_completion_tokens": 1048576,
    },
    "deepseek-v4-pro": {
        "name": "DeepSeek V4 Pro",
        "context_length": 1048576,
        "max_completion_tokens": 1048576,
    },
    "qwen3.8-flash-next": {
        "name": "Qwen3.8 Flash Next",
        "context_length": 750000,
        "max_completion_tokens": 750000,
    },
    "glm-5.3-flash": {
        "name": "GLM 5.3 Flash",
        "context_length": 500000,
        "max_completion_tokens": 393216,
    },
    # Must match the native wrapper's --ctx; this is not measured capacity.
    "deepseek-v4.1-flash": {
        "name": "DeepSeek V4.1 Flash",
        "context_length": 1000000,
        "max_completion_tokens": 1000000,
    },
}

MLX_MODEL_METADATA = {
    "qwen3.5-4b-8bit": {"name": "Qwen3.5 4B (MLX 8-bit)", "context_length": 262144},
    "qwen3.5-4b-bf16": {"name": "Qwen3.5 4B (MLX BF16)", "context_length": 262144},
    "qwen3.8-27b-uncensored": {"name": "Qwen3.8 27B Uncensored (MLX 8-bit)", "context_length": 262144},
    "gemma-4-31b-mlx": {"name": "Gemma 4 31B IT (MLX 8-bit)", "context_length": 262144},
}


def mlx_model_metadata():
    """Merge the private registry without importing the MLX runtime."""
    models = dict(MLX_MODEL_METADATA)
    registry = Path(__file__).resolve().parent / 'local-models.json'
    if registry.exists():
        for entry in json.loads(registry.read_text()).get('models', []):
            models[entry['id']] = {
                'name': entry['display'],
                'context_length': entry.get('context_length', 262144),
            }
    return models
