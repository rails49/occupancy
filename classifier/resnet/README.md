# 🧠 CNN Track Occupancy Classifier

This directory contains the machine learning pipeline for training, validating, and testing the track occupancy classifier.

## 🚀 Machine Learning Pipeline

The track occupancy detection workflow is modular and spans multiple directories in this repository. Follow the steps below in order:

### 1. Data Preparation — ⚠️ PARKED, this step does not run

`pnpm --filter dataset prep` is a **stub that exits non-zero**. It derived one 144×144 crop per v3 point marker, tagged by the marker's type; v4 stores no point markers. Deriving from car spans alone puts every crop centre on a car, so the vocabulary collapses to one degenerate tag with no negatives.

**There is consequently no corpus to train on today.** The route back is sampling background crops as verified negatives — an experiment, dormant while the ResNet is. See `SPEC.md` § v4 cannot produce a trainable CNN dataset (issues #8, #18) and the [Dataset Preparation Guide](../../dataset/README.md).

Steps 2–4 below describe a pipeline that remains correct in every respect except that its input no longer exists. They are kept because the ResNet stays retrainable.

### 2. Model Training & Export
Train the model and export it to cross-platform runtime formats.
* **Notebook**: [TRAIN.ipynb](TRAIN.ipynb)
* **Action**: Run all cells in `TRAIN.ipynb` to train a ResNet-18 model on the prepared dataset, evaluate its metrics, and export the trained model into optimized ONNX/ORT formats saved in the [models/](models) folder — full precision (`model.ort`, ~45 MB) and quantized (`model_int8.ort`, ~11 MB), plus `config.json`.

### 3. Model Deployment
**`model_int8.ort` is the model that ships.** Cloudflare Pages rejects files over 25 MiB, which the full-precision `model.ort` exceeds. If you change which model ships, update all three of: `ui/vite.config.ts` (the static-copy target) and the `_classifier.load()` calls in `rr-live-view.ts` and `rr-editor-view.ts`.

* **Frontend Web UI**: The build copies `model_int8.ort` and `config.json` into the web bundle for client-side ONNX runtime execution. See the [Web UI Guide](../ui/README.md) for details.
* **Action**: Run `bin/deploy.sh` from the repository root to build the UI and publish it to Cloudflare Pages. It aborts if any file would exceed the 25 MiB limit.

### 3a. Publishing Model Releases
Because model files exceed GitHub's file size limit, they are not checked into Git. Instead, they are synced from GitHub Releases:
1. When you retrain the model and export new models to [models/](models), update [models/version.txt](models/version.txt) with a new version tag (e.g., `v1.0.1`).
2. Create a GitHub Release matching that version tag (e.g., `v1.0.1`).
3. Upload `model_int8.ort` and `config.json` as assets to that GitHub Release.

Publishing is unaffected by the retirement of the accuracy gate, but **nothing downloads these assets at test time any more and no test asserts an accuracy figure** — `bin/test.sh` runs identically with no model present. See `docs/SYSTEM.md` § Model files and releases.

> **⚠️ TODO:** Automate this process using a script (e.g., using `gh` CLI) to automatically package, version, tag, and upload the models.

### 4. Diagnostic Verification — ⚠️ PARKED, this step does not run

`pnpm --filter dataset online-diagnostics` is a **stub that exits non-zero**, for the same reason as step 1: it scored each point marker's type tag against a prediction, and v4 has neither.

It also measured nothing generalizable — it scored the very archives the model trained on. A replacement belongs to the held-out protocol that does not yet exist (`SPEC.md` § Accuracy), not to a port of that script.

---

## 📂 Folder Contents

* **[models/](models)**: Output directory for PyTorch (`.pth`), ONNX (`.onnx`), and Web-Optimized (`.ort`) models, along with their label mappings (`config.json`).
* **[src/](src)**: Python source code, utility classes, and custom helper methods used within the notebooks.
* **[pyproject.toml](pyproject.toml)**: Dependency specification for `uv` (FastAI, PyTorch, ONNX runtime, etc.).

