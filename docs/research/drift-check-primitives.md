# Research: browser-runnable drift-check primitives

Written 2026-08-03. Resolves [#90](https://github.com/iot49/rails49/issues/90) (child of wayfinder map
[#89](https://github.com/iot49/rails49/issues/89), camera-drift detection). Facts only —
this document does not choose a primitive.

**Task**: given a live video frame and reference photographs of the same scene from a
supposedly identical camera pose, score how much the frame's *structure* disagrees with
the references. Constraints that shape every option below:

* The app is fully client-side and cross-origin-isolated (COEP `require-corp`), so
  **every asset must ship from rails49.org** — no CDN. Any candidate's bytes land in the
  deploy.
* Cloudflare Pages enforces a **25 MiB per-file limit**
  ([Cloudflare Pages limits](https://developers.cloudflare.com/pages/platform/limits/)).
* onnxruntime-web already ships in this app (`ui/package.json` pins
  `onnxruntime-web ^1.25.1`; the installed 1.26.0 `ort-wasm-simd-threaded.wasm` is
  13,022,405 B ≈ 12.4 MiB, verified locally). ONNX-model candidates therefore add only
  model bytes, not a runtime.

All sizes were read from release assets, registry metadata, or Git LFS pointers on
2026-08-03; each is cited. Runtime numbers are marked **sourced** or **estimate**.
Nothing below was benchmarked in this repo.

---

## (a) Sparse keypoint matching + RANSAC homography inlier test

Principle: detect keypoints in reference and frame, match descriptors, fit a
homography with RANSAC ([Fischler & Bolles 1981](https://dl.acm.org/doi/10.1145/358669.358692)).
Keypoints on legitimately-changed content (a moved locomotive, a hand) fail the
consensus test as outliers, while keypoints on static structure (track, buildings,
benchwork) vote for the true camera motion. Outputs are naturally continuous: inlier
count, inlier ratio, and the fitted homography's deviation from identity are all
thresholdable numbers, and reprojection residuals localize which regions disagreed.

### opencv.js (official build)

* **Asset size (sourced)**: the official hosted build at
  [`docs.opencv.org/4.x/opencv.js`](https://docs.opencv.org/4.x/opencv.js) (redirects to
  4.13.0) is **10,964,323 B ≈ 10.5 MiB**, served as `text/javascript` — a single-file
  build with the WASM base64-embedded in the JS (HTTP `content-length` checked
  2026-08-03). OpenCV's GitHub releases (4.9.0 through 5.0.0 checked via the
  [releases API](https://api.github.com/repos/opencv/opencv/releases)) carry **no
  opencv.js asset**; the docs site is the only official binary distribution.
  [`build_js.py`](https://github.com/opencv/opencv/blob/4.x/platforms/js/build_js.py)
  passes `-s SINGLE_FILE=1` unless `--disable_single_file` is given, so a self-built
  split `.js` + `.wasm` avoids the ~⅓ base64 inflation (**estimate**: ~8 MiB on the
  wire before compression; not verified by building).
* **Custom subset build (mechanism sourced, savings unverified)**: `build_js.py`
  exposes `--config <file>` which sets `OPENCV_JS_WHITELIST`
  ([build_js.py lines 265, 275–276](https://github.com/opencv/opencv/blob/4.x/platforms/js/build_js.py)),
  and `--cmake_option` can pass `-DBUILD_opencv_<module>=OFF`. The default CMake list
  in `build_js.py` builds **core, imgproc, calib3d, dnn, features2d, flann, photo,
  video, objdetect** — `dnn` and `photo` are on by default and are dead weight for
  this use, so a features2d+calib3d-only build must be substantially smaller, but
  **no official size figure for a subset build is published anywhere I could find**;
  the saving cannot be quoted without actually building.
* **Detectors in the default JS whitelist (sourced)** — from
  [`platforms/js/opencv_js.config.py`](https://github.com/opencv/opencv/blob/4.x/platforms/js/opencv_js.config.py):
  **ORB, AKAZE, BRISK, KAZE, FAST, AGAST, GFTT, MSER, SimpleBlobDetector**, plus
  `BFMatcher`/`DescriptorMatcher` and `drawMatches`. `calib3d` whitelists
  **`findHomography`** (with `UsacParams`) and `estimateAffine2D`. **SIFT is *not* in
  the default whitelist.** SIFT itself has been in the main `features2d` module since
  OpenCV 4.4.0 (moved by [opencv/opencv#17119](https://github.com/opencv/opencv/pull/17119),
  merged 2020-04-24, after the SIFT patent expired in March 2020;
  `class CV_EXPORTS_W SIFT : public Feature2D` at
  [`features2d.hpp` line 266](https://github.com/opencv/opencv/blob/4.x/modules/features2d/include/opencv2/features2d.hpp)),
  so a custom `--config` could export it — patent status is no longer an obstacle.
* **COOP/COEP / threading (sourced)**: threading is **off by default**; `--threads`
  adds `-s USE_PTHREADS=1 -s PTHREAD_POOL_SIZE=4` and `-DWITH_PTHREADS_PF=ON`
  ([build_js.py](https://github.com/opencv/opencv/blob/4.x/platforms/js/build_js.py)).
  A threaded build needs `SharedArrayBuffer`, which requires exactly the COOP/COEP
  cross-origin isolation this app already deploys
  ([MDN: SharedArrayBuffer security requirements](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/SharedArrayBuffer#security_requirements)).
  The non-threaded default build has no isolation requirement at all. Whether the
  hosted docs.opencv.org binary was built with `--threads`/`--simd` is not documented;
  unverified.
* **Runtime cost (estimate)**: no official opencv.js benchmark exists for
  ORB→match→findHomography. ORB was designed as the fast alternative to SIFT/SURF
  ([Rublee et al. 2011](https://ieeexplore.ieee.org/document/6126544), "an order of
  magnitude faster than SURF"); native ORB on VGA runs in single-digit ms, and WASM
  is typically within a small factor of native. Expect **tens of ms per 480p frame**
  single-threaded WASM for detect+describe+match+RANSAC. Estimate, not measured.
* **Robustness**: sees structure. Moved rolling stock ejects as outliers as long as
  static background still supplies enough inliers; a hand over part of the layout
  removes matches locally but leaves the consensus intact. Strong lighting change
  degrades detector repeatability (ORB's oFAST/rBRIEF are intensity-comparison based,
  which gives moderate — not total — illumination tolerance).
* **Score**: continuous (inlier count/ratio, homography-vs-identity, residuals).
* **License**: OpenCV ≥ 4.5.0 is **Apache-2.0**
  ([OpenCV Change Logs](https://github.com/opencv/opencv/wiki/OpenCV-Change-Logs):
  "since OpenCV 4.5.0 … distributed under Apache 2 license") — one-way compatible
  into AGPL-3.0.
* Aside: the unofficial prebuilt npm wrapper
  [`@techstark/opencv-js`](https://registry.npmjs.org/@techstark/opencv-js) (5.0.0-release.1,
  2026-06) reports 14,731,296 B unpacked — it is a third-party repack, noted only for
  size context.

### jsfeat (pure JS)

* **Size (sourced)**: `build/jsfeat-min.js` in the npm 0.0.8 tarball is
  **66,093 B ≈ 65 KiB** minified (build dated 2015-10-31 inside the tarball;
  [registry](https://registry.npmjs.org/jsfeat)).
* **Capabilities (sourced from [README](https://github.com/inspirit/jsfeat))**: FAST,
  YAPE, YAPE06 detectors; **ORB descriptors**; a multiview module with
  **Homography2D kernel + RANSAC and LMEDS estimators**; Sobel/Scharr/Canny;
  Lucas-Kanade optical flow. I.e. the entire pipeline of this section exists in 65 KiB.
* **Maintenance (sourced)**: last substantive commit **2018-03-03**
  ([commits](https://github.com/inspirit/jsfeat/commits/master)); effectively
  unmaintained for eight years. License **MIT** (GitHub API).
* **Runtime cost**: no published benchmarks; plain-JS typed-array code. Estimate:
  same order as WASM for this workload class at 480p (tens of ms), unmeasured.
* **Robustness / score**: identical story to opencv.js above — same algorithm family.

### tracking.js

* **Scope (sourced)**: "real-time color tracking, face detection … lightweight core
  (~7 KB)" ([README](https://github.com/eduardolundgren/tracking.js)); its features
  directory contains only
  [`Fast.js` and `Brief.js`](https://github.com/eduardolundgren/tracking.js/tree/master/src/features)
  — **no RANSAC, no homography, no matcher beyond BRIEF**. The geometric-consistency
  half of the primitive would have to be written by hand.
* **Maintenance (sourced)**: last commit **2021-01-20**, and that commit adds a
  "maintainers wanted" banner ([commits](https://github.com/eduardolundgren/tracking.js/commits/master)).
  License **BSD-3-Clause** (LICENSE.md).

### image-js

* **Maintenance (sourced)**: actively maintained — repo pushed 2026-08-02, npm
  `image-js` 1.7.0 published 2026-07 (unpacked 12,530,673 B; tree-shaken app-bundle
  cost not verified). License **MIT**.
* **Capabilities (sourced from
  [`src/featureMatching/index.ts`](https://github.com/image-js/image-js/blob/main/src/featureMatching/index.ts)
  and [`src/index.ts`](https://github.com/image-js/image-js/blob/main/src/index.ts))**:
  FAST and oriented-FAST keypoints, Harris/Shi-Tomasi scoring, **BRIEF descriptors,
  brute-force matching with cross-check**, and an exported `align` module containing a
  **RANSAC affine** estimator. This is the only *maintained* pure-JS keypoint pipeline
  found. Caveat: the model is **affine, not homography** — no homography estimator was
  found in the tree.
* **Runtime cost**: no published numbers; unmeasured.

### Other WASM ports of ORB/AKAZE

No maintained standalone WASM port of ORB or AKAZE (outside opencv.js) was found in
this survey. Claims of absence are hard to prove; treat as "none surfaced", not "none
exists".

---

## (b) Dense / global methods

### Phase correlation (FFT)

* **Principle (sourced)**: translation between two images appears as a delta-function
  peak in the inverse FFT of the normalized cross-power spectrum
  ([Kuglin & Hines 1975](https://scholar.google.com/scholar?q=Kuglin+Hines+phase+correlation+1975));
  the log-polar extension recovers rotation and scale as translations in log-polar
  coordinates ([Reddy & Chatterji, IEEE TIP 5(8), 1996](https://ieeexplore.ieee.org/document/506761)).
* **Bundle cost (sourced)**: [fft.js](https://github.com/indutny/fft.js) is
  **22,390 B unpacked** on npm (v4.0.4, MIT per `package.json`; last commit
  2023-03-05). Hand-rolling the rest (Hanning window, cross-power spectrum, peak
  scan) is a few hundred lines on `ImageData`. Effectively **~0 MiB**.
* **Runtime cost (derived estimate)**: fft.js's own benchmark
  ([README](https://github.com/indutny/fft.js#benchmarks), Node, maintainer's
  machine) does a size-2048 complex transform at 35,153 ops/s (≈ 28.5 µs) and
  size-4096 at 15,676 ops/s. Scaling by n·log n, a size-512 transform is ≈ 6 µs; a
  512×512 2-D FFT (1,024 row/col transforms) ≈ **6 ms**, and a full phase
  correlation (two forward + one inverse + spectrum math) ≈ **~20–30 ms** at 512²,
  single-threaded JS. Estimate derived from their published 1-D numbers, not
  measured at 2-D.
* **In opencv.js (sourced)**: `phaseCorrelate` is **not** in the default whitelist,
  but `dft`, `getOptimalDFTSize` (core), `divSpectrums`, `createHanningWindow`, and
  `warpPolar` (imgproc) **are**
  ([opencv_js.config.py](https://github.com/opencv/opencv/blob/4.x/platforms/js/opencv_js.config.py)) —
  phase correlation *and* the Reddy–Chatterji log-polar variant assemble from
  already-whitelisted ops.
* **Robustness**: global, majority-vote-like — the correlation peak reflects the
  displacement of the dominant static content; a moved train perturbs but does not
  relocate the peak while background dominates; a hand covering much of the frame
  degrades it. Phase normalization discards the magnitude spectrum, giving strong
  tolerance to global illumination/contrast change (that is the point of using phase
  only — Kuglin & Hines). Models **translation only** (plus rotation/scale via
  log-polar); it cannot represent the perspective change of a tilted camera, only
  detect it as a broadened/weakened peak.
* **Score**: continuous — peak displacement in pixels plus peak response (sharpness).

### ECC — `findTransformECC`

* **Availability (sourced)**: **in the default opencv.js build** — `findTransformECC`
  is whitelisted in the `video` module
  ([opencv_js.config.py line 163](https://github.com/opencv/opencv/blob/4.x/platforms/js/opencv_js.config.py)).
  So its bundle cost is the opencv.js cost from section (a); it adds nothing.
* **Contract (sourced)**: defaults `MOTION_AFFINE`, 50 iterations, eps 0.001, and an
  optional `inputMask` to exclude regions; returns the final enhanced correlation
  coefficient as a `double`
  ([OpenCV docs, `findTransformECC`](https://docs.opencv.org/4.x/dc/d6b/group__video__track.html)).
  The algorithm is Evangelidis & Psarakis, *Parametric Image Alignment Using Enhanced
  Correlation Coefficient Maximization*, IEEE TPAMI 30(10), 2008
  ([DOI 10.1109/TPAMI.2008.113](https://doi.org/10.1109/TPAMI.2008.113)), whose
  criterion is by construction **invariant to linear (gain/bias) photometric
  distortion** — that invariance is the paper's stated contribution.
* **Runtime cost (estimate)**: iterative and dense — each of up to 50 iterations
  computes gradients and a Jacobian over every pixel. No official browser benchmark
  exists. Order-of-magnitude expectation at 480p single-threaded WASM: **hundreds of
  ms to seconds** per invocation; standard practice is to run it on downscaled
  images. Estimate, not measured.
* **Robustness**: dense global model — every pixel votes, so moved rolling stock and
  hands *violate* the model rather than being ejected (unlike RANSAC); the `inputMask`
  parameter exists precisely to mask such regions, but the mask must come from
  somewhere. Lighting is handled by the ECC criterion itself (gain/bias invariance).
* **Score**: continuous twice over — the returned correlation coefficient, and the
  fitted warp's deviation from identity.

### Edge-map comparison (Sobel/Canny + IoU or chamfer)

* **Bundle cost**: **zero** — a 3×3 Sobel over `ImageData` is a page of JS; `Sobel`,
  `Scharr`, `Canny`, and `distanceTransform` (for chamfer) are also all in the
  default opencv.js whitelist
  ([opencv_js.config.py](https://github.com/opencv/opencv/blob/4.x/platforms/js/opencv_js.config.py)),
  and jsfeat has Sobel/Scharr/Canny ([README](https://github.com/inspirit/jsfeat)).
* **Runtime cost (estimate)**: O(N) — one pass over ~300 k pixels at 480p; a few ms
  in plain JS, less in WASM. Comparison against a precomputed reference
  distance-transform (chamfer,
  [Barrow et al. 1977](https://dl.acm.org/doi/10.5555/1622943.1622971)) is another
  O(N) pass. Comfortably interactive at 1080p. Estimate.
* **Lighting robustness (the standard justification, sourced)**: image gradients are
  far less sensitive to illumination than raw intensities — smooth lighting changes
  live in the low frequencies that differentiation removes. This is the textbook
  motivation for the **gradient constancy assumption**: grey-value constancy "is
  quite susceptible to slight changes in brightness … [the gradient criterion]
  allows small variations in the grey value"
  ([Brox et al., ECCV 2004, §2.1](https://link.springer.com/chapter/10.1007/978-3-540-24673-2_3)),
  and it is why Canny edges localize structural discontinuities rather than
  brightness levels ([Canny, IEEE TPAMI 1986](https://ieeexplore.ieee.org/document/4767851)).
  Raw-pixel differencing has neither property.
* **Robustness**: sees structure and — uniquely among these candidates —
  **localizes** it: scoring IoU/chamfer per tile distinguishes "one region changed"
  (train moved, hand) from "everything shifted coherently" (camera drift). Caveats:
  rolling-stock edges count exactly as much as track edges, and cast shadows create
  real edges, so the raw global score confounds scene change with drift unless the
  spatial pattern is used.
* **Score**: continuous (IoU, mean chamfer distance), globally and per-region.
* **License**: n/a (hand-rolled) or the host library's.

---

## (c) Learned features via onnxruntime-web

The runtime is already on board (see header); a WASM-EP session is exactly what
`@occupancy/classifier` runs today. A primary-source existence proof of this model
family under onnxruntime-web:
[microsoft/onnxruntime#25227](https://github.com/microsoft/onnxruntime/issues/25227)
(filed 2025-06-30, ORT-web 1.22.0) runs a **SuperPoint+LightGlue ONNX pipeline in the
browser**: the **WASM EP "produced expected results (keypoints, matches, and
scores)"**; the WebGPU EP produced keypoints but no matches (the bug being reported);
WebNN matched WASM. No performance figures are given in the issue.

Model facts (sizes are the released files, read from release/repo metadata):

| Model | Released weights | ONNX | License | AGPL-3.0 shippable? |
| :--- | :--- | :--- | :--- | :--- |
| SuperPoint | `superpoint_v1.pth` 5,206,086 B ([repo](https://github.com/magicleap/SuperPointPretrainedNetwork)) | `superpoint.onnx` 5,272,808 B ([LightGlue-ONNX v1.0.0](https://github.com/fabio-sim/LightGlue-ONNX/releases/tag/v1.0.0)) | Magic Leap: "ACADEMIC OR NON-PROFIT ORGANIZATION NONCOMMERCIAL RESEARCH USE ONLY"; derivatives owned by licensor ([LICENSE](https://github.com/magicleap/SuperPointPretrainedNetwork/blob/master/LICENSE)) | **No** — non-commercial, no redistribution rights; incompatible with serving weights to every visitor of an AGPL app |
| DISK | — | `disk.onnx` 4,418,235 B ([LightGlue-ONNX v1.0.0](https://github.com/fabio-sim/LightGlue-ONNX/releases/tag/v1.0.0)) | **Apache-2.0** ([repo](https://github.com/cvlab-epfl/disk)) | Yes (one-way into AGPL) |
| ALIKED | `aliked-t16.pth` 794,859 B → `aliked-n32.pth` 3,946,667 B ([models/](https://github.com/Shiaoming/ALIKED/tree/main/models)) | standalone ONNX size **unverified** (fabio-sim v3.0 ships only fused ALIKED+LightGlue pipelines, 64.1–65.8 MB) | **BSD-3-Clause** ([repo](https://github.com/Shiaoming/ALIKED)) | Yes |
| XFeat | `xfeat.pt` 6,247,949 B; `xfeat-lighterglue.pt` 10,820,795 B ([weights/](https://github.com/verlab/accelerated_features/tree/main/weights)) | **no ONNX in the official repo** (tree searched); third-party [noahzhy/xfeat_lightglue_onnx](https://github.com/noahzhy/xfeat_lightglue_onnx) (Apache-2.0) ships a 2,349,183 B LighterGlue matcher ONNX | **Apache-2.0** ([repo](https://github.com/verlab/accelerated_features)) | Yes |
| LightGlue (matcher) | `*_lightglue.pth` 47.5–47.6 MB fp32 per extractor pairing ([cvg/LightGlue v0.1_arxiv assets](https://github.com/cvg/LightGlue/releases)) | fused end-to-end pipelines: fp32 45.6–51.2 MB — **over the 25 MiB Pages limit**; fp16 fused 22,991,518 B (SuperPoint) / 23,058,331 B (DISK) — under it ([LightGlue-ONNX releases](https://github.com/fabio-sim/LightGlue-ONNX/releases)) | **Apache-2.0** ([cvg/LightGlue](https://github.com/cvg/LightGlue), [fabio-sim/LightGlue-ONNX](https://github.com/fabio-sim/LightGlue-ONNX)) | Yes, but fp32 pipelines don't deploy; fp16 barely does, and the SuperPoint-paired one inherits SuperPoint's license problem |

Additional facts:

* **XFeat CPU claim (sourced)**: the README states "Real-time sparse inference on CPU
  for VGA images (tested on laptop with an i5 CPU and vanilla pytorch)"
  ([verlab/accelerated_features](https://github.com/verlab/accelerated_features#xfeat-accelerated-features-for-lightweight-image-matching)).
  That is PyTorch on native CPU, **not** a browser measurement; no
  onnxruntime-web demonstration of XFeat was found.
* **LightGlue is optional.** Descriptor sets from any of these extractors can be
  matched by hand-rolled mutual-nearest-neighbor + RANSAC (XFeat's own demo does
  MNN matching), keeping the download at just the extractor (4–6 MiB class) at some
  accuracy cost versus the learned matcher.
* **Robustness**: these models were trained for wide-baseline matching and are the
  current-generation answer to *illumination and viewpoint* variation (that is their
  benchmark task — e.g. the LightGlue paper targets day/night pairs). Downstream
  scoring is the same RANSAC-inlier arithmetic as section (a): structure, not pixels;
  moved stock ejects as outliers. Score: continuous.

### Whole-frame embeddings (MobileNet-class)

* **Size (sourced, LFS pointers in [onnx/models](https://github.com/onnx/models/tree/main/validated/vision/classification/mobilenet/model))**:
  `mobilenetv2-12.onnx` **13,964,571 B** fp32; `mobilenetv2-12-int8.onnx`
  **3,655,033 B**. onnx/models is Apache-2.0 (GitHub API).
* **Runtime (estimate)**: one MobileNetV2 224×224 forward pass under ORT WASM —
  tens of ms per frame on laptop-class CPUs; unmeasured here.
* **What cosine distance would and wouldn't detect (analysis, not sourced)**: the
  embedding is a global-average-pooled classification feature. Pooling makes it
  deliberately **insensitive to small translations — i.e. least sensitive to exactly
  the small pose drift being looked for** — while any content change (a train
  arriving, lighting shift, a hand) moves the embedding as much as or more than a
  pose change does. It yields a continuous score but conflates "scene changed" with
  "camera moved" by construction, and cannot localize the disagreement.
* **Score**: continuous (cosine distance). **License**: Apache-2.0 (repo); per-model
  provenance in onnx/models should be checked before shipping any specific file.

---

## Cross-cutting summary

| Candidate | Added deploy cost | 480p cost (order) | Sees structure? | Continuous score | License |
| :--- | :--- | :--- | :--- | :--- | :--- |
| opencv.js ORB/AKAZE + findHomography | ~10.5 MiB official build (subset smaller, unquantified) | tens of ms (est.) | yes, outlier-tolerant | yes | Apache-2.0 |
| jsfeat (FAST/ORB + RANSAC homography) | 65 KiB | tens of ms (est.) | yes, outlier-tolerant | yes | MIT (unmaintained since 2018) |
| image-js (FAST/BRIEF + RANSAC affine) | part of 12.5 MB unpacked pkg (bundle cost unverified) | unmeasured | yes; affine only | yes | MIT (active) |
| tracking.js | ~7 KB core | — | lacks geometric-consistency stage | — | BSD-3 (unmaintained) |
| Phase correlation (fft.js, hand-rolled) | ~22 KiB | ~20–30 ms at 512² (derived est.) | global; translation(+log-polar rot/scale) only | yes (peak + response) | MIT |
| ECC `findTransformECC` | free with opencv.js | 100s of ms–s (est.) | dense; moving objects violate model (maskable) | yes (ρ + warp) | Apache-2.0 |
| Edge map + IoU/chamfer | ~0 | few ms (est.) | structural, localizes per-region | yes | n/a |
| DISK / ALIKED / XFeat (+ MNN-RANSAC) | 2.3–6.3 MiB model, runtime already ships | unmeasured under ORT-web | yes, outlier-tolerant | yes | Apache-2.0 / BSD-3 |
| SuperPoint (+ anything) | 5.3 MiB | ORT-web WASM shown working (#25227) | yes | yes | **non-commercial — not shippable** |
| SuperPoint/DISK + LightGlue fused | fp32 45–51 MB **exceeds 25 MiB/file**; fp16 ~23 MB fits | unmeasured | yes | yes | Apache-2.0 (DISK path) |
| MobileNetV2 embedding + cosine | 3.7 MiB (int8) | tens of ms (est.) | no — global semantic pixels | yes | Apache-2.0 |

Open verification gaps, stated rather than guessed: subset-opencv.js size, ALIKED
standalone ONNX size, every "(est.)" runtime above, tree-shaken image-js bundle cost,
and thread/SIMD flags of the hosted opencv.js binary.
