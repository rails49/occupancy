import json
import os
import yaml
import torch


def load_config():
    """Loads the shared config.yaml file."""
    config_path = os.path.abspath(
        os.path.join(os.path.dirname(__file__), "../../../config.yaml")
    )
    with open(config_path, "r") as f:
        return yaml.safe_load(f)


def get_device():
    """Returns the best available torch device (MPS, CUDA, or CPU)."""
    if torch.backends.mps.is_available():
        return torch.device("mps")
    if torch.cuda.is_available():
        return torch.device("cuda")
    return torch.device("cpu")


def load_r49_data():
    """Loads the .r49 format's data file: gauge, scales and vocabulary.

    They are the format's, not this project's, so they are authored in
    lib/r49/r49.json rather than config.yaml (ADR 0018).
    """
    data_path = os.path.abspath(
        os.path.join(os.path.dirname(__file__), "../../../../lib/r49/r49.json")
    )
    with open(data_path, "r") as f:
        return json.load(f)


def get_gauge(scale_name: str) -> float:
    """Calculates the rail gauge for a given scale name."""
    data = load_r49_data()

    standard_gauge = data.get("standard_gauge")
    if standard_gauge is None:
        raise ValueError(
            "Fatal Error: 'standard_gauge' is missing in lib/r49/r49.json."
        )

    scale_to_ratio = data.get("scale_to_ratio")
    if not scale_to_ratio:
        raise ValueError(
            "Fatal Error: 'scale_to_ratio' is missing in lib/r49/r49.json."
        )

    ratio = scale_to_ratio.get(scale_name)
    if ratio is None:
        raise ValueError(
            f"Fatal Error: Scale '{scale_name}' is missing in scale_to_ratio in lib/r49/r49.json."
        )

    return standard_gauge / ratio
