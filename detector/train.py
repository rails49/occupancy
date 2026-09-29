"""Fine-tune YOLO26n-OBB on the exported rolling-stock dataset.

This is the tracer's training stage: plumbing, not accuracy. The corpus is 46
fixture images below `layout.min_dpt` with a six-image validation split, so no
number this prints predicts how a real model would behave. What it does prove is
that the export in `dataset/src/yolo_export.ts` produces something Ultralytics
reads, that the OBB head trains on it, and that the result survives the ONNX and
`.ort` conversions in `export_onnx.py`.

Usage:
    uv run python train.py [--epochs 20] [--data ../dataset/yolo/data.yaml]
    uv run python train.py --hours 10 --patience 30 --name tracer-long

The 20-epoch default is the plumbing run and stays the default. `--hours` is for
a real training session: the first run stopped at 20 epochs with **validation
loss still falling** (box 1.575 → 0.861, cls 4.971 → 2.701, no divergence from
the training curve), which is a model stopped early rather than converged. It
also missed 23 of 92 cars on images it had *trained on* — a model that has fit
its data does not do that.

**Pass `--name` for a long run.** `exist_ok=True` means a repeat of the default
name overwrites `runs/tracer/weights/`, and the currently shipped `.ort` was
exported from those weights.

Weights land in `runs/`, which is gitignored. Nothing here is published: see
`SPEC.md` § Accuracy for why a tracer model must never become a release — a
longer run improves the numbers without changing that, since the six-image
validation split is drawn from the same six archives as the training images.
"""

from __future__ import annotations

import argparse
import time
from pathlib import Path

import yaml
from ultralytics import YOLO

HERE = Path(__file__).parent
REPO = HERE.parent

# The DOTA-pretrained oriented-box checkpoint. Ultralytics fetches it on first
# use. Fine-tuning from it rather than from scratch is what makes 46 images a
# sane amount of data to show plumbing with — DOTA is aerial imagery of vehicles
# and buildings, which is a closer starting point for top-down rolling stock
# than random initialization by a wide margin.
PRETRAINED = "yolo26n-obb.pt"


def detector_input() -> tuple[int, int]:
    """`detector.input` from config.yaml, as `(width, height)`.

    Read from the authored YAML rather than from `lib/config`: Python does not
    consume the generated TypeScript binding, by the rule in `lib/CLAUDE.md`.
    """
    config = yaml.safe_load((REPO / "config.yaml").read_text())
    width, height = config["detector"]["input"]
    return int(width), int(height)


def main() -> None:
    width, height = detector_input()

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--data",
        type=Path,
        default=REPO / "dataset" / "yolo" / "data.yaml",
        help="Ultralytics data.yaml, as written by `pnpm --filter dataset run export:yolo`",
    )
    parser.add_argument(
        "--epochs",
        type=int,
        default=20,
        help="Few by design. This is a plumbing run, not a training run. "
        "Ignored when --hours is given.",
    )
    parser.add_argument(
        "--hours",
        type=float,
        default=None,
        help="Wall-clock budget. Overrides --epochs and, importantly, rescales the "
        "learning-rate schedule to fit the time available — appending epochs to a "
        "schedule that has already decayed to lrf buys very little.",
    )
    parser.add_argument(
        "--patience",
        type=int,
        default=100,
        help="Epochs without validation improvement before stopping. The default is "
        "Ultralytics' and never fires on a 20-epoch run; lower it on a long one so "
        "the run ends when the model stops learning rather than when the clock does.",
    )
    parser.add_argument(
        "--batch", type=int, default=4, help="Not yet sized for the M2; see #128."
    )
    parser.add_argument(
        "--device",
        default="mps",
        help="cpu, mps, or a CUDA index.",
    )
    parser.add_argument("--name", default="tracer", help="Run directory under runs/.")
    args = parser.parse_args()

    if not args.data.exists():
        raise SystemExit(
            f"{args.data} does not exist. Export the dataset first:\n"
            f"    pnpm --filter dataset run export:yolo -- --in <corpus>\n"
        )

    model = YOLO(PRETRAINED)

    started = time.monotonic()
    model.train(
        data=str(args.data.resolve()),
        epochs=args.epochs,
        # When `time` is set, Ultralytics times the first epoch, recomputes the
        # total from the budget, and **rebuilds the LR scheduler** against it —
        # so `epochs` above is discarded after epoch one and the decay to `lrf`
        # spans the hours actually available. That rebuild is the reason to use
        # a time budget rather than a guessed epoch count: a schedule sized for
        # 20 epochs and then run for 300 spends 280 of them at a learning rate
        # that has already bottomed out.
        time=args.hours,
        patience=args.patience,
        # Ultralytics takes a single `imgsz` for training and letterboxes to it.
        # The rectangular 960x544 shape is applied at *export* instead, which is
        # where it decides the deployed graph — see export_onnx.py.
        imgsz=max(width, height),
        batch=args.batch,
        device=args.device,
        project=str(HERE / "runs"),
        name=args.name,
        exist_ok=True,
        # The corpus is 46 fixed frames from a handful of fixed camera
        # positions, so the usual augmentations are doing more work than usual.
        # Left at Ultralytics' defaults deliberately: tuning them against a
        # six-image validation split would be fitting noise.
        seed=0,
        plots=True,
    )
    elapsed = time.monotonic() - started

    weights = HERE / "runs" / args.name / "weights" / "best.pt"
    print(f"\n⏱  {elapsed / 60:.1f} min wall clock on {args.device}")
    print(f"📦 {weights}" if weights.exists() else f"⚠️  expected weights at {weights}")
    print("\nNext: uv run python export_onnx.py")


if __name__ == "__main__":
    main()
