"""Peak MPS memory for YOLO26{l,x}-obb, fp32, training and inference (#128).

    PYTORCH_MPS_HIGH_WATERMARK_RATIO=1.0 PYTORCH_MPS_LOW_WATERMARK_RATIO=1.0 \
        uv run python memsweep.py sweep --out runs/memsweep/results.jsonl

One subprocess per configuration. Batch sizes rise until the first failure.
"""

from __future__ import annotations

import argparse
import json
import os
import resource
import subprocess
import sys
import threading
import time
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent / "runs" / "memsweep"
MODELS = ["l", "x"]
SIZES = [1024, 1536, 2048, 2560, 3200, 4448]
BATCHES = [1, 2, 4, 8, 16, 32]
TRAIN_BATCHES = 3  # stop after this many; the epoch-end validation never runs


def make_images(size: int, n: int) -> Path:
    """n synthetic size x size JPEGs, each with three rotated boxes."""
    import cv2

    d = ROOT / "data" / str(size)
    (d / "images").mkdir(parents=True, exist_ok=True)
    (d / "labels").mkdir(parents=True, exist_ok=True)
    rng = np.random.default_rng(size)
    for i in range(n):
        img_path = d / "images" / f"{i:03d}.jpg"
        if img_path.exists():
            continue
        img = np.full((size, size, 3), 110, np.uint8)
        lines = []
        for _ in range(3):
            cx, cy = rng.uniform(0.2, 0.8, 2) * size
            w, h = size * 0.08, size * 0.02
            box = cv2.boxPoints(((cx, cy), (w, h), float(rng.uniform(0, 180))))
            cv2.fillPoly(
                img,
                [box.astype(np.int32)],
                tuple(int(c) for c in rng.integers(0, 255, 3)),
            )
            pts = np.clip(box / size, 0, 1).flatten()
            lines.append("0 " + " ".join(f"{p:.6f}" for p in pts))
        cv2.imwrite(str(img_path), img, [cv2.IMWRITE_JPEG_QUALITY, 90])
        (d / "labels" / f"{i:03d}.txt").write_text("\n".join(lines) + "\n")
    listing = d / f"list_{n}.txt"
    listing.write_text("".join(f"{d / 'images' / f'{i:03d}.jpg'}\n" for i in range(n)))
    yaml = d / f"data_{n}.yaml"
    yaml.write_text(f"train: {listing}\nval: {listing}\nnames:\n  0: stock\n")
    return yaml


class Peak:
    """Samples MPS driver and tensor memory on a timer; torch has no MPS peak counter."""

    def __init__(self) -> None:
        import torch

        self.torch = torch
        self.driver = 0
        self.tensors = 0
        self._stop = threading.Event()
        self._t = threading.Thread(target=self._run, daemon=True)
        self._t.start()

    def _run(self) -> None:
        mps = self.torch.mps
        while not self._stop.is_set():
            self.driver = max(self.driver, mps.driver_allocated_memory())
            self.tensors = max(self.tensors, mps.current_allocated_memory())
            time.sleep(0.002)

    def stop(self) -> dict:
        self._stop.set()
        self._t.join()
        return {
            "driver_gb": self.driver / 2**30,
            "tensors_gb": self.tensors / 2**30,
            # macOS reports ru_maxrss in bytes
            "rss_gb": resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 2**30,
        }


def emit(out: Path, rec: dict) -> None:
    with out.open("a") as f:
        f.write(json.dumps(rec) + "\n")
    f.close()


def one(args: argparse.Namespace) -> None:
    from ultralytics import YOLO

    out = Path(args.out)
    rec = vars(args).copy()
    del rec["cmd"], rec["out"]
    model = YOLO(f"yolo26{args.model}-obb.yaml")
    peak = Peak()
    try:
        if args.mode == "train":
            data = make_images(args.size, TRAIN_BATCHES * args.batch)
            stamps: list[float] = []

            def on_batch_end(trainer) -> None:
                # Ultralytics halves the batch on OOM in the first epoch and retries without raising.
                if trainer.batch_size != args.batch:
                    rec.update(
                        peak.stop(),
                        status="oom",
                        error=f"reduced to batch={trainer.batch_size}",
                    )
                    emit(out, rec)
                    os._exit(0)
                stamps.append(time.monotonic())
                if len(stamps) == TRAIN_BATCHES:
                    rec.update(
                        peak.stop(),
                        status="ok",
                        s_per_batch=(stamps[-1] - stamps[0]) / (len(stamps) - 1),
                    )
                    emit(out, rec)
                    os._exit(0)

            model.add_callback("on_train_batch_end", on_batch_end)
            model.train(
                data=str(data),
                epochs=1,
                imgsz=args.size,
                batch=args.batch,
                device="mps",
                workers=0,
                mosaic=float(args.mosaic),
                scale=0.0,
                rect=False,
                val=False,
                plots=False,
                cache=False,
                project=str(ROOT),
                name="sweep",
                exist_ok=True,
                verbose=False,
            )
            rec.update(peak.stop(), status="no-callback")
        else:
            make_images(args.size, args.batch)
            imgs = [
                str(ROOT / "data" / str(args.size) / "images" / f"{i:03d}.jpg")
                for i in range(args.batch)
            ]
            kw = {
                "imgsz": args.size,
                "batch": args.batch,
                "device": "mps",
                "verbose": False,
                "save": False,
            }
            model.predict(imgs, **kw)  # warm-up
            t0 = time.monotonic()
            for _ in range(2):
                model.predict(imgs, **kw)
            rec.update(
                peak.stop(), status="ok", s_per_batch=(time.monotonic() - t0) / 2
            )
    except RuntimeError as e:
        rec.update(
            peak.stop(),
            status="oom" if "out of memory" in str(e) else "error",
            error=str(e)[:300],
        )
    emit(out, rec)


def sweep(args: argparse.Namespace) -> None:
    out = Path(args.out)
    done = {}
    if out.exists():
        for line in out.read_text().splitlines():
            r = json.loads(line)
            done[(r["mode"], r["model"], r["size"], r["batch"], r["mosaic"])] = r[
                "status"
            ]
    for mode, mosaic in [("infer", 0), ("train", 0), ("train", 1)]:
        for model in MODELS:
            for size in SIZES:
                for batch in BATCHES:
                    key = (mode, model, size, batch, mosaic)
                    if key in done:
                        if done[key] != "ok":
                            break
                        continue
                    cmd = [
                        sys.executable,
                        __file__,
                        "one",
                        "--out",
                        str(out),
                        "--mode",
                        mode,
                        "--model",
                        model,
                        "--size",
                        str(size),
                        "--batch",
                        str(batch),
                        "--mosaic",
                        str(mosaic),
                    ]
                    n = sum(1 for _ in out.open()) if out.exists() else 0
                    t0 = time.monotonic()
                    proc = subprocess.run(
                        cmd, capture_output=True, text=True, timeout=3600, check=False
                    )
                    lines = out.read_text().splitlines() if out.exists() else []
                    if len(lines) == n:  # the child died without reporting
                        emit(
                            out,
                            {
                                "mode": mode,
                                "model": model,
                                "size": size,
                                "batch": batch,
                                "mosaic": mosaic,
                                "status": f"crash {proc.returncode}",
                                "error": proc.stderr[-300:],
                            },
                        )
                        lines = out.read_text().splitlines()
                    rec = json.loads(lines[-1])
                    print(
                        f"{mode} {model} {size} b{batch} m{mosaic}: {rec['status']} "
                        f"{rec.get('driver_gb', 0):.1f} GB {time.monotonic() - t0:.0f}s",
                        flush=True,
                    )
                    if rec["status"] != "ok":
                        break


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("cmd", choices=["sweep", "one"])
    p.add_argument("--out", required=True)
    p.add_argument("--mode", choices=["train", "infer"])
    p.add_argument("--model", choices=MODELS)
    p.add_argument("--size", type=int)
    p.add_argument("--batch", type=int)
    p.add_argument("--mosaic", type=int, default=0)
    args = p.parse_args()
    sweep(args) if args.cmd == "sweep" else one(args)


if __name__ == "__main__":
    main()
