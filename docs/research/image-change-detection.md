# Image change detection as an occupancy classifier

Written 2026-07-29. Research note on `SPEC.md` § Classifier, option 1 ("Image change"), and its cited prior art
[EX-SensorCAM](https://dcc-ex.com/mkdocs-test/products/ex-sensorcam/ex-sensorcam/).

*Researched 2026-07-29. Sources: EX-SensorCAM source at `DCC-EX/EX-SensorCAM@b07c3f3` (v3.21,
2026-05-23), the DCC-EX official manual, and a re-implementation of SensorCAM's decision metric run
against `lighting.r49` — then at `dataset/r49/` in this repo, now at `fixtures/lighting.r49` in
[rails49/r49](https://github.com/rails49/r49) (#63). Marker counts below are the v3 ones this research
ran against; v4 dropped them.*

---

## Final determination: (c) — totally impractical as a replacement for the CNN

**Not** because the technique is hard to implement — it is about 60 lines and I implemented it during
this research — but because the outcome is already known to be inadequate, and the reason is
structural rather than a matter of tuning.

Change detection answers "does this patch differ from a stored reference?", not "is there a train
here". Converting the first question into the second requires maintaining the reference, and the
reference update policy is forced into a contradiction: it must adapt to survive illumination drift,
and it must *not* adapt while a train sits still, or the stopped train is absorbed and vanishes. The
only resolution is to gate adaptation on the occupancy decision — which is exactly what EX-SensorCAM
does (`refRefresh()`, `sensorCAM.ino:2724`) — and that turns both error directions into **absorbing
states**: a false trip freezes the reference and so persists, and a missed train is written into the
reference and so becomes permanent. DCC-EX documents this outcome in its own manual, in capitals.
Measured on this repo's `lighting.r49`, SensorCAM's metric false-trips on **100% of static, unchanged
background patches** across the one deliberate lighting change in the corpus, and on 25–64% of them
between the *mildest* pair of images. Against a >99.9% bar, on a fully client-side app that keeps no
persistent reference and cannot detect camera drift (issue #12), this is not a gap to be closed.

**Salvage value (not the same thing as viability):** the technique is worth ~a day of work for two
*different* jobs it is genuinely good at — detecting camera drift (issue #12) and gating "has
anything changed, re-run the classifier". Both are covered in [§6](#6-what-change-detection-is-good-for-here).

---

## Legend

| Tag | Meaning |
|---|---|
| **[SRC]** | Read directly from EX-SensorCAM source. File + line cited. |
| **[DOC]** | Stated in DCC-EX official documentation. |
| **[MEAS]** | Measured by me during this research, method given. |
| **[LIT]** | Published, peer-reviewed or benchmark result. |
| **[INF]** | My inference. Not sourced — argued. |

---

## 1. What EX-SensorCAM actually is, and what problem it solves

### Scope

Up to 80 point sensors at fixed pixel coordinates in a QVGA frame, each reporting a boolean
occupied/unoccupied over I²C to a DCC-EX Command Station. It is **block detection at discrete
zones** — the same problem as rails49's SPEC "Sensors" output, and *not* the same as rails49's Option
3 (locate and orient every car). It explicitly "does not include loco or rolling stock
identification" **[DOC]** ([README](https://github.com/DCC-EX/EX-SensorCAM/blob/main/README.md)).

Hardware: ESP32-CAM (ESP32-S + OV2640), 4 MB PSRAM **[DOC]**. Frame format RGB565 at QVGA 320×240
(`sensorCAM.ino:271-272`) **[SRC]**, one loop per 100 ms (`#define CYCLETIME 100000`,
`sensorCAM.ino:36`) **[SRC]**.

### The algorithm, exactly

Each sensor is a **4×4 pixel patch — 16 pixels** (`#define SEN_SIZE 0`, `configCAM.h`) **[SRC]**.
Optionally padded to 6×6 by inserting spare pixels in a cross, still sampling 16 **[SRC]** **[DOC]**.

1. **Decode.** RGB565 → "RGB666" 3 bytes/pixel, ~6 bits per channel (`decode565()`,
   `sensorCAM.ino:1796`; `f565to666()`, `:1805`).
2. **Quadrant colour sums.** Split the 4×4 into four 2×2 quadrants; sum R, G, B over the 4 pixels of
   each quadrant → 12 sums (`Compute_CRatios()`, `sensorCAM.ino:1726-1766`).
3. **Colour ratios.** Within each quadrant compute R/G, G/B, B/R as `max/min << 5` — always ≥ 32,
   exactly 32 when equal (`sensorCAM.ino:1757-1762`). **This is the illumination-compensation
   mechanism**: scaling all three channels by a common factor leaves every ratio unchanged.
4. **Cross-ratio against the reference.** `compare()` (`sensorCAM.ino:1691-1722`) applies the same
   `max/min << 5` between the live `Cratio[12]` and the stored `SensorRefRatio[12]`, then
   `maxDiff = max` over the result. Note `for (i=1;i<12;i++)` at `sensorCAM.ino:1716` — index 0
   (quadrant 0's R/G) is **excluded** from the max. Possibly deliberate, possibly an off-by-one;
   either way it discards 1 of 12 channels of sensitivity. **[SRC]**
5. **Brightness term.** `bright = 16*sum/refSum - 16` (symmetric, integer;
   `sensorCAM.ino:1893-1894`).
6. **Decision.** `bpd = brightSF*bright + maxDiff` with `BRIGHTSF = 3` (`sensorCAM.ino:37-38, 1896`),
   compared against `threshold`, default **42** (`sensorCAM.ino:288`); docs suggest 40–60, "try t45"
   **[DOC]**.

### The margin is 10 counts

**[MEAS/INF]** `bpd = 32` exactly for identical patches — confirmed both by the manual ("Minimum bpd
score is 32 (identical)" **[DOC]**) and by my re-implementation (§4). Default threshold 42. So the
entire noise + drift + illumination budget is **10 counts**. DCC-EX's own commissioning guidance says
an unoccupied sensor should score "32-37" after a reference refresh **[DOC]**, and the installation
guide asks for "under 39" **[DOC]** — i.e. the project itself expects to be operating within 3–5
counts of the trip point.

### Hysteresis and noise suppression that does exist

- `min2flip = 2` consecutive frames above/below threshold before the state flips
  (`sensorCAM.ino:243`, `processDiff()` `SensorFilter[]` logic at `:1916-1946`) **[SRC]**.
- Two-frame pixel averaging for sensors below `TWOIMAGE_MAXBS` (default octal 030 = sensor 24)
  (`av2frames()`, `sensorCAM.ino:2644-2654`) **[SRC]**.
- Optional **twin sensor**: a primary only trips if a designated neighbour also trips
  (`sensorCAM.ino:1944`) **[SRC]**.
- Mains-flicker synchronisation: the loop busy-waits to align frame release to an integral number of
  mains half-cycles (`sensorCAM.ino` main loop; `#define SUPPLY 10` in `configCAM.h`) **[SRC]**. The
  manual concedes "The mains supply synchronization is currently inadequate (ESP32-CAM limitation)"
  **[DOC]**.

---

## 2. Does it handle illumination change?

**Partially, by three mechanisms, none of which is exposure locking.**

**(a) Colour-ratio invariance.** The core metric is intensity-normalised by construction (§1 step 3).
This defeats *uniform* brightness change but **not** colour-temperature change — and colour
temperature is precisely what shifts when daylight is traded for room lights, or when the camera's
AWB re-converges.

**(b) Adaptive reference, gated on non-occupancy.** `refRefresh()` (`sensorCAM.ino:2699-2746`) walks
the enabled sensors round-robin, accumulating `NUM2AVERAGE = 32` frames (`sensorCAM.ino:141`) ≈ 3.5 s,
and installs the average as the new reference **only if the sensor did not trip during the window**
(`if(emptyStateCtr[rbsn] > NUM2AVERAGE+4)`, `sensorCAM.ino:2724`) **[SRC]**. Because it is
round-robin, any one sensor is refreshed once every N×3.5 s where N is the number of enabled
sensors — **~4.7 minutes with 80 sensors**. The manual states this cadence explicitly **[DOC]**.
A dedicated brightness reference sensor `S00` updates unconditionally every 6.4 s from a 64-frame
average (`sensorCAM.ino:661-680`) **[SRC]** **[DOC]**.

**(c) Camera auto-adjustments are left ON.** `Bri=0, Con=1, Sat=2, AWB=1, AWBg=1, AEC=1, AECd=1,
AEL=1, AGC=1, AGg=9` (`sensorCAM.ino:198`) **[SRC]**. Line 199 declares `AWB9=1, AGC9=1` with the
comment "after prefillRef delay (9sec) change AWB and AGC if desired", and line 512 does
`AWB=AWB9; AGC=AGC9;` — with the shipped defaults this is a **no-op: AWB and AGC stay enabled**. The
line that would disable them (`new_camera_settings(0,1,2,0,1,1,1,1,0,9)`) is present but commented
out at `sensorCAM.ino:513` **[SRC]**. The manual says "the sensorCAM may stabilize and then turn off
some auto adjustments in the first 15 seconds" **[DOC]** — that does not match the shipped default
config. Flag this as a **documentation/code discrepancy**, not a settled fact.

Auto-exposure being live is not incidental; the manual warns about its consequence: a hand near the
camera causes "changing whole image brightness/colour for several seconds … These types of changes
can trip the sensorCAM **even if the obstruction does not block the virtual sensor**" **[DOC]**.

**What is not done anywhere:** exposure/WB locking, per-zone gain normalisation, shadow modelling, a
multi-modal (mixture-of-Gaussians) background, or any illumination-invariant feature beyond the
colour ratio.

### The failure mode DCC-EX documents itself

Verbatim from the official manual
([ex-sensor-manual](https://dcc-ex.com/mkdocs-test/products/ex-sensorcam/ex-sensor-manual/), §9.1)
**[DOC]**:

> "It is inadvisable to leave a sensor occupied for long periods if best reliability is desired. If a
> sensor is occupied for long periods of drifting illumination, the ref can become out-of-date to an
> extent that the sensor can remain PERMANENTLY 'occupied'. Manual re-referencing (`r%%`) would
> become necessary."

And the DCC-EX sensor-comparison page: sensorCAM is **"Not currently suitable for exhibition
layouts"**, and "Suitable environment (e.g. lighting) conditions are essential"
([which-sensor-type](https://dcc-ex.com/ex-commandstation/accessories/sensors/which-sensor-type.html))
**[DOC]**.

Other failure modes the manual names **[DOC]**: vibration ("The CAM MUST be rigidly mounted as its
response to any image vibration can trip sensors"); fluorescent/LED flicker producing drifting bands
("Fluoro's are bad!"); "fluctuating daylight, fans and cloud shadows through windows"; low contrast
("grey roofs against plain grey track"); and the need to re-reference "perhaps after sunset or
turning on extra lighting".

---

## 3. What accuracy does anyone report?

**SPEC.md's claim — "The project gives little information about accuracy" — is CONFIRMED, and if
anything understated.** I found **no** measured accuracy figure of any kind: no dataset, no
confusion matrix, no false-trip rate, no detection rate, in any of:

- the [product page](https://dcc-ex.com/mkdocs-test/products/ex-sensorcam/ex-sensorcam/),
  [installation guide](https://dcc-ex.com/mkdocs-test/products/ex-sensorcam/installation-guide/),
  and [30-page manual](https://dcc-ex.com/mkdocs-test/products/ex-sensorcam/ex-sensor-manual/) —
  I grepped the full extracted text of all three for accuracy/reliability/percentage claims **[MEAS]**;
- the repo [README](https://github.com/DCC-EX/EX-SensorCAM);
- the [launch announcement](https://dcc-ex.com/news/posts/20240215.html), which instead says the
  software is "very new", will "rapidly undergo many changes and bug fixes as issues are found", is
  aimed at users "with tinkering or engineering experience", and carries "caveats on things like
  lighting requirements … given the ESP32 CAM platform is a fairly low performance, entry-level
  device" **[DOC]**.

The repo self-describes as **"Alpha release of sensorCAM"** **[DOC]**. What the project *does*
provide is per-installation diagnostics rather than published numbers — the `&` statistics command
prints a per-sensor noise histogram, `SensorHiCount[]`/`SensorHisto[]` count near-misses and trips
(`sensorCAM.ino:212, 214, 1910-1945`) **[SRC]**. That is a tuning aid; it is not a measurement anyone
has published.

The only quantitative performance claims are **latency**, not accuracy **[DOC]**: ~0.5 s worst-case
response at 10 fps, "~150 mm travel in HO at 100 kph".

### On community reports

**I could not obtain user accuracy reports.** GitHub Issues are **disabled** on the repository
**[MEAS]** (`gh issue list` returns "the repository has disabled issues"); DCC-EX directs all
discussion to the `#ex-sensorcam` Discord channel, which is not publicly archived and which I could
not reach. Web search surfaced no forum threads with usable first-hand accuracy accounts — only
restatements of the official docs. **Anything below this line about real-world accuracy is therefore
inference from the code and the docs, not from user experience.** The repo shows 10 stars / 3 forks
but is actively maintained (v3.21, 2026-05-23) **[MEAS]**.

---

## 4. Measured: SensorCAM's metric on this repo's own data

I re-implemented `Compute_CRatios()` + `compare()` + the `bpd` computation of `processDiff()` in
NumPy, box-downsampled the 1920×1080 archive images to 320 px wide (matching the CAM's QVGA pixel
pitch), quantised through RGB565→RGB666 exactly as `decode565()` does, and evaluated `bpd` over a
dense grid of 4×4 patches. **[MEAS]**

**Implementation validated:** an image compared against itself returns `bpd = 32` for every patch,
matching the documented minimum. Re-encoding the same image at JPEG q=92 puts only 0.7% of patches at
or above threshold 42, so codec noise is not driving the results below.

### 4a. Synthetic illumination controls (reference = `lighting.r49` image-1)

| Perturbation | median bpd | p90 | % of patches ≥ 42 (would trip) |
|---|---|---|---|
| identical | 32 | 32 | 0.0% |
| re-JPEG q=92 | 32 | 34 | 0.7% |
| uniform **+5%** brightness | 33 | 36 | 1.1% |
| uniform **+10%** brightness | 36 | 40 | 6.6% |
| uniform **+25%** brightness | 44 | 48 | **80.5%** |
| colour temp **R+2% / B−2%** | 34 | 36 | 2.2% |
| colour temp **R+5% / B−5%** | 36 | 40 | 5.7% |
| colour temp **R+10% / B−10%** | 40 | 44 | **22.9%** |

This matches a hand-derivation of the code exactly **[INF]**: `bright = 16k − 16` for a gain of `k`,
times `brightSF = 3`, must stay under `42 − 32 = 10`, so a **~21% uniform brightness change trips
sensors on brightness alone**, irrespective of colour. The measurement lands at the same place.

Read the two columns together: the colour-ratio trick buys roughly a 2× larger tolerance to *uniform*
brightness than to *chromatic* shift of the same magnitude. It is a real mitigation. It is not a
solution.

### 4b. `lighting.r49`, image pairs

`lighting.r49` is a bench setup beside a skylight. Image-0 has the skylight unobstructed; in
images 1–5 a large cardboard box has been placed to shade it, with the light then drifting over the
sequence. Measured global mean RGB moves from (119.4, 121.0, 122.4) in image-0 to
(134.3, 128.9, 124.6) in image-5 — mean luminance changes only **+7%**, but the **R/B ratio changes
from 0.975 to 1.078, i.e. +10.5%** — precisely the axis SensorCAM's metric is measuring, and
precisely the magnitude that trips ~23% of patches in the control above. **[MEAS]**

"Static ROI" below is a hand-picked rectangle of bare table surface (full-res y 950–1060,
x 200–1700) that is visually identical in every image — **any trip there is a false trip by
construction**.

| ref → cur | whole-image median bpd | whole-image % ≥ 42 | static-ROI median | **static-ROI % ≥ 42** |
|---|---|---|---|---|
| 0 → 1 (skylight shaded) | 74 | 87.6% | 183 | **99.8%** |
| 0 → 5 | 69 | 88.7% | 174 | **100.0%** |
| 1 → 5 (drift only) | 39 | 39.6% | 45 | **63.9%** |
| 2 → 5 | 37 | 24.9% | 41 | **49.7%** |
| 3 → 5 | 35 | 8.9% | 40 | **44.8%** |
| **4 → 5 (mildest pair)** | 33 | 4.5% | 37 | **25.5%** |

**Honest limits of this measurement.** These are stills minutes apart from a consumer camera with its
own AE/AWB re-converging between shots, not a 10 Hz feed from a fixed ESP32-CAM whose reference is
refreshed every few minutes. It therefore **overstates** the drift a real SensorCAM would see between
consecutive reference refreshes — the mild pairs (4→5) are the more representative rows. It also uses
JPEG-compressed source and a box-downsample rather than the OV2640's own ISP. What it does establish
soundly is the *scale relationship*: the metric's 10-count budget is small compared with the
between-capture colour variation actually present in this project's corpus, and a single deliberate
change of light source (0 → anything) saturates it completely. **[MEAS]**

### 4c. The thing `lighting.r49` shows that no tuning fixes

The archive's own lighting variation was produced by **putting a cardboard box into the scene**. A
change detector reports that box as occupancy over its whole footprint. It has no notion of "train".
SPEC's requirement is occupancy *by rolling stock*; a hand, a coffee cup, a re-railer, a screwdriver
left on the layout, or a person leaning over it are all indistinguishable from a train to a change
detector — and DCC-EX confirms the hand case behaviourally: "a hand in front of the CAM may trip
[sensors] depending on lighting" **[DOC]**. The shipping CNN does not have this failure. **[INF]**

---

## 5. Does the background-subtraction literature solve this?

**No — and the literature's own answer to the hard case is to add an object detector, i.e. rails49
Option 3.**

The rails49 requirement maps onto the CDnet 2014 benchmark's **Intermittent Object Motion (IOM)**
category — objects that stop and stay stopped — which is the standard formalisation of "a stopped
train must keep reading as occupied". Per-category F-Measure on CDnet 2014, from Table 1 of
[ZBS (arXiv:2303.14679)](https://arxiv.org/abs/2303.14679) **[LIT]**:

| Method (all unsupervised) | baseline | shadow | **intmot** | overall |
|---|---|---|---|---|
| SuBSENSE | 0.950 | 0.899 | **0.657** | 0.741 |
| PAWCS | 0.940 | 0.891 | **0.776** | 0.740 |
| WisenetMD | 0.949 | 0.898 | **0.726** | 0.754 |
| SWCD | 0.921 | 0.878 | **0.709** | 0.758 |
| SemanticBGS *(+ semantic segmenter)* | 0.960 | 0.948 | **0.788** | 0.789 |
| RT-SBS-v2 *(+ semantic segmenter)* | 0.954 | 0.950 | **0.895** | 0.805 |
| ZBS *(+ instance detector)* | 0.965 | 0.977 | **0.876** | 0.852 |

Two things to take from this **[INF]**:

1. Classical background subtraction loses ~0.25–0.30 F-Measure going from the easy "baseline"
   category to intermittent motion. Not 0.999 — 0.66–0.78, on a benchmark far more forgiving than a
   >99.9% per-decision occupancy bar.
2. **Every method that closes the IOM gap does so by bolting on semantics** — a segmenter (SemanticBGS,
   RT-SBS) or an instance detector (ZBS). The field's own conclusion is that change detection needs
   to be told *what* changed. That is the CNN and the YOLO detector rails49 is already building.

The dedicated abandoned-object literature reaches the same place. Park et al., *Robust Detection of
Abandoned Object for Smart Video Surveillance in Illumination Changes*, Sensors 19(23):5114
([doi:10.3390/s19235114](https://doi.org/10.3390/s19235114)) **[LIT]** states that in conventional
background subtraction "the foreground is gradually absorbed into the background over time", that the
approach "is very vulnerable to illumination changes … [which] could last for a long time …
significantly increase the false alarm rate", and that their fix requires "a dual background model
consisting of two background models with different learning rates". That is the same architecture as
SensorCAM's gated `refRefresh()`, made explicit — and it is a paper published *because* the naive
version does not work.

OpenCV's own documentation states the base assumption plainly: background subtraction is for **static
cameras** ([tutorial_background_subtraction](https://docs.opencv.org/4.x/d1/dc5/tutorial_background_subtraction.html))
**[DOC]** — an assumption `SPEC.md` § Image Alignment says rails49 currently makes without
verifying, with a **silent** failure mode (issue #12).

### The structural argument, stated precisely **[INF]**

Let `R` be the reference and `d(R, I) > τ` the occupancy decision. Illumination drift forces `R` to
track `I`. Reporting a stationary train forbids `R` from tracking `I` while occupied. The only policy
satisfying both is `R ← I` conditioned on `d(R, I) ≤ τ`. That conditioning makes the decision
self-referential and creates two absorbing states:

- **Latched false positive.** A false trip (light change, shadow, vibration, hand) blocks reference
  updates. The reference is now stale by exactly the disturbance that caused the trip, so the trip
  cannot clear. This is the manual's "PERMANENTLY occupied".
- **Latched false negative.** A train that fails to trip for one 32-frame window is averaged *into*
  the reference. It is now background, and it stays background even when it later moves — leaving a
  ghost that trips on the empty track instead.

Neither is a tuning error. Raising `τ` trades one for the other; lowering the refresh cadence trades
illumination robustness for absorption speed. Every parameter in `configCAM.h` sits on that same
one-dimensional trade-off. And a per-decision error rate of 1-in-1000 at 10 Hz is one error every 100
seconds — which for *sticky* errors means a session of any length is essentially certain to end with
a wrong, self-sustaining occupancy state somewhere on the layout.

---

## 6. Failure-mode comparison vs. the shipping CNN

### Where change detection is genuinely better

| | Change detection | CNN (ships today) |
|---|---|---|
| Training data / labels | **none** | 46 images, hand-labelled, and SPEC says they must be re-shot |
| Compute | ~10 integer ops/sensor | ResNet-18 inference, 11 MB ORT model |
| **Pixel density** | works at **DPT 3.4–7.6** — SensorCAM Table 1 gives QVGA pixel sizes 2.18–4.91 mm at 0.8–1.8 m camera height, vs HO gauge 16.5 mm **[DOC]** | needs **DPT > 20**; the whole 46-image corpus at DPT 18–19 is unusable for training (`SPEC.md` § Calibration) |
| New layout / unseen stock | works immediately | needs retraining or generalisation evidence that does not yet exist (issue #4) |
| Response latency | ~0.2–0.5 s | single forward pass |

The DPT row is the real attraction and deserves acknowledgement: change detection is the one option
that is *not* blocked on re-shooting the corpus. That is exactly why SPEC calls it "very attractive".

### Where it is strictly worse

| Failure mode | Change detection | CNN |
|---|---|---|
| Stopped train held indefinitely | **absorbed into background, or latched-on** — the crux (§5) | unaffected; each frame classified independently |
| Room lights switched / sunset / cloud | false trips until next reference refresh (up to ~4.7 min at 80 sensors) **[SRC]** | robust in principle; `lighting.r49` exists precisely to train and test this |
| Camera moves (issue #12) | every sensor false-trips, and the reference latch prevents recovery | degrades, but per-frame and non-latching |
| Hand / body / tool over the layout | **reported as occupancy** — no class notion | classified as not-a-train (imperfectly, but it is the right question) |
| Shadows | trip | learnable from data |
| Single still image (what the UI does today) | **cannot answer at all** — needs a reference and a history | answers directly |
| Diagnosis when wrong | opaque scalar vs. a threshold | high-loss sample review, per-SPEC § Testing and Demo |

The "single still image" row is not a detail. `rr-editor-view` classifies a still out of an opened
`.r49`; there is no persistent process, no stored background, no guarantee the tab survives, and no
camera-pose record to key a background to. Retrofitting change detection means introducing per-layout
persistent state that must be invalidated on camera motion the app cannot currently detect. **[INF]**

### The illumination problem is already taken seriously here

`lighting.r49` — 6 images, 78 `train` and 68 `track` markers, one deliberate light-source
change — exists for exactly this reason **[MEAS]**. The project's chosen answer is to *train through*
illumination variance rather than *normalise it away*. That is the strategy the CDnet results in §5
endorse.

---

## 7. What would change this verdict

State honestly what verdict (c) does **not** claim **[INF]**:

- It does not claim change detection is useless here. Two jobs it is well suited to:
  1. **Camera-drift detection (issue #12).** Compare structural content of the current frame against
     the frame the calibration was authored on, and *refuse to classify* on mismatch. This is
     unoccupancy-agnostic, has no latch problem, and turns a silent failure into a loud one. Cheap.
  2. **Re-classification gating.** In live view, skip inference when nothing changed. Purely a
     compute optimisation; a false negative costs a stale frame, not a wrong occupancy.
- It does not claim a *hybrid* is impossible. "Change detector proposes, CNN disposes" — run change
  detection to find candidate regions, then classify each with the CNN — is sound, and is exactly the
  SemanticBGS / ZBS architecture from §5. But that is Option 2 or 3 with a cheap front-end, **not
  Option 1**, and it needs the CNN to exist anyway. It also does not remove the DPT > 20 blocker,
  because the CNN still does the deciding.
- It would change if the requirement changed: drop "stationary rolling stock reported indefinitely"
  and the latch problem largely evaporates, and change detection becomes a reasonable *motion*
  sensor. rails49's SPEC does not permit that.

**Licensing note, if any of SensorCAM's code is ever reused:** EX-SensorCAM is **GPL-3.0**
(`LICENSE`, `configCAM.h` header) **[SRC]**, not AGPL. GPLv3 §13 explicitly permits combination with
AGPLv3 works, so incorporating it into rails49 (AGPL-3.0) is permitted — but it is a distinct licence
and should be recorded as such.

---

## What I could not determine

- **Any first-hand user accuracy report.** GitHub Issues are disabled on `DCC-EX/EX-SensorCAM`
  **[MEAS]**, and the `#ex-sensorcam` Discord channel is not publicly archived. No forum thread I
  found contained a usable measurement. §3's conclusion rests on the absence of published numbers,
  which is itself evidence, but it is not the same as evidence of poor accuracy in the field.
- **Whether AWB/AGC are actually left on in practice.** `sensorCAM.ino:198-199, 512-513` say yes with
  shipped defaults; the manual says auto adjustments are turned off after ~15 s. I did not run the
  firmware, so I cannot resolve the discrepancy. If the manual is right, §2(c) is less severe.
- **The canonical (non-`/mkdocs-test/`) docs URL.** `https://dcc-ex.com/products/ex-sensorcam/…` and
  `https://dcc-ex.com/ex-sensorcam/…` both 404 **[MEAS]**. `/mkdocs-test/` appears to be the only
  live path; SPEC.md's link is correct, though it may be a staging path that moves.
- **How SensorCAM's metric behaves on a genuine 10 Hz ESP32-CAM feed.** My §4 numbers are from stills
  taken minutes apart with a different camera. The direction is unambiguous; the exact false-trip rate
  a real installation sees is not something I measured.

---

## Reproducing §4

The re-implementation is ~60 lines and was not committed (it produced measurements, not a
deliverable). Core metric, for anyone who wants to re-derive the numbers:

```python
# Mirrors sensorCAM.ino v3.21: Compute_CRatios() :1726, compare() :1691, processDiff() :1877
BRIGHTSF, THRESHOLD = 3, 42
NEXT = np.array([1,2,0, 4,5,3, 7,8,6, 10,11,9])   # next colour within the same quadrant

def cratios(p):                       # p: (..., 4, 4, 3) RGB666 patch
    q = np.stack([p[..., 0:2, 0:2, :].sum((-3,-2)), p[..., 0:2, 2:4, :].sum((-3,-2)),
                  p[..., 2:4, 0:2, :].sum((-3,-2)), p[..., 2:4, 2:4, :].sum((-3,-2))], -2)
    s = np.maximum(q.reshape(*q.shape[:-2], 12), 4)          # if (sum[i]<4) sum[i]=4
    a, b = s, s[..., NEXT]
    return (np.maximum(a,b) << 5) // np.minimum(a,b), p.sum((-3,-2,-1))

def bpd(ref, cur):
    Cr, bR = cratios(ref); Cc, bC = cratios(cur)
    X = (np.maximum(Cc,Cr) << 5) // np.minimum(Cc,Cr)
    maxDiff = X[..., 1:].max(-1)                             # ino: for(i=1;i<12;i++)
    br = np.where(bC > bR, bC*16//bR - 16, bR*16//bC - 16)
    return BRIGHTSF*br + maxDiff
```

Input images are box-downsampled to 320 px wide and pushed through RGB888→RGB565→RGB666 as
`decode565()` (`sensorCAM.ino:1796`) does. Sanity check: identical input must give exactly 32.

---

## Sources

**Primary — source code** (`DCC-EX/EX-SensorCAM@b07c3f32cbe614be90461ef874b1d7c51f25ed80`, v3.21,
2026-05-23): `sensorCAM.ino` (2843 lines), `configCAM.h`, `README.md`, `LICENSE`.
<https://github.com/DCC-EX/EX-SensorCAM>

**Primary — official documentation:**
- Product page — <https://dcc-ex.com/mkdocs-test/products/ex-sensorcam/ex-sensorcam/>
- User manual — <https://dcc-ex.com/mkdocs-test/products/ex-sensorcam/ex-sensor-manual/>
- Installation guide — <https://dcc-ex.com/mkdocs-test/products/ex-sensorcam/installation-guide/>
- Launch announcement — <https://dcc-ex.com/news/posts/20240215.html>
- Sensor type comparison — <https://dcc-ex.com/ex-commandstation/accessories/sensors/which-sensor-type.html>

**Literature:**
- An, Kim et al., *ZBS: Zero-shot Background Subtraction…*, Table 1 (CDnet 2014 per-category
  F-Measure) — <https://arxiv.org/abs/2303.14679>
- Park, Park, Paik, *Robust Detection of Abandoned Object for Smart Video Surveillance in Illumination
  Changes*, Sensors 19(23):5114 — <https://doi.org/10.3390/s19235114>
- OpenCV, *How to Use Background Subtraction Methods* (MOG2 / KNN) —
  <https://docs.opencv.org/4.x/d1/dc5/tutorial_background_subtraction.html>
- CDnet / changedetection.net — <http://changedetection.net/>

**This repo:** `SPEC.md` (§ Classifier, § Accuracy, § Calibration, § Image Alignment),
`ui/CLAUDE.md`, `CLAUDE.md`, and the six archives (46 images, all 1920×1080, HO) — read from
`dataset/r49/` at the time, now [rails49/r49](https://github.com/rails49/r49)`/fixtures/`.
