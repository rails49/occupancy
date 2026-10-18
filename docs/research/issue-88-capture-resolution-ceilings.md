# Browser capture resolution ceilings, and the DPT they imply

Written 2026-08-04. Research for [issue #88](https://github.com/iot49/rails49/issues/88), under map
[#79](https://github.com/iot49/rails49/issues/79).

*Researched 2026-08-04. Sources: the W3C Media Capture and Streams Candidate Recommendation Draft of
2025-10-09; WebKit trunk source (`Source/WebCore/platform/mediastream/cocoa/AVVideoCaptureSource.mm`,
`Source/WebCore/platform/mediastream/RealtimeVideoCaptureSource.cpp`); Chromium trunk source
(`third_party/blink/renderer/modules/mediastream/`, mirror `chromium/chromium` at `main`, pushed
2026-08-04); MDN `browser-compat-data` at `main`; WebKit release notes for Safari 18.4 (2025-03-31)
and 26.0 (2025-09-15); WebKit Bugzilla; vendor tech specs. Project geometry read from `config.yaml`
in this repo. No project code was modified by this research.*

---

## Legend

| Tag | Meaning |
|---|---|
| **[SRC]** | Read directly from browser-engine source. File cited. |
| **[SPEC]** | Stated normatively in a W3C specification. |
| **[BCD]** | MDN `browser-compat-data`, read from the JSON at `main`. |
| **[REL]** | Vendor release notes / bug tracker. |
| **[CALC]** | Arithmetic done here, from `config.yaml` constants. Method shown. |
| **[HW]** | Vendor hardware spec. |
| **[INF]** | My inference. Argued, not sourced. |
| **[UNTESTED]** | Not verified on a device. Flagged rather than asserted. |

---

## Final determination

**No browser capture path reaches `layout.min_dpt: 20` over the full 2000 mm layout in one video
frame. But that ceiling is not the one that binds — and the one that binds is not a capture ceiling
at all.**

Three findings, in order of how much they matter:

**1. At whole-frame 960-px inference, capture resolution is irrelevant to the detector.** Model-space
DPT is fixed by geometry alone:

> model-space DPT = (model input width ÷ covered width in mm) × gauge in mm
> = (960 ÷ 2000) × 8.96875 = **4.30 DPT**, giving a **9.0 px** car width. **[CALC]**

The capture resolution cancels out of that expression entirely. A 1080p webcam and a 48 MP phone
still both deliver exactly 4.30 DPT to a 960-px-wide whole-frame model. Everything beyond the 960 px
the letterbox keeps is discarded before the model sees it — a little excess helps the downsample
anti-alias, a factor of 4.6 does not. **This makes the capture-ceiling question moot for the live
view as currently specified**, and moves the real question onto the model's pixel budget (§8.4).

**2. The proposed deployment geometry is 2.1× worse at the model input than the corpus the tracer
trained on.** The 46 fixtures are 1920 px at native DPT 17.96–19.08; letterboxed 0.5× into 960×544
they present cars **18.8–19.9 px wide**. One camera over 2000 mm presents them **9.0 px wide**
**[CALC]**. The tracer's ~0.60 recall / ~0.65 precision was measured at the wider figure. Halving the
smallest dimension of an already-marginal object is the largest single risk on this map, and it is
not a capture problem — no camera fixes it.

**3. The capture ceilings themselves, for completeness.** 20 DPT over 2000 mm needs **4460 px of
capture width** **[CALC]**. Nothing streams that. The best live video any browser can obtain is
**3840–4096 px** (4K UHD / DCI 4K, external USB webcam on desktop Chrome, or a recent iPhone/iPad
rear camera), which is **17.2–18.4 DPT** — below `min_dpt` but *inside the fixture corpus's own
range*. Full-sensor stills go higher: `ImageCapture.takePhoto()` is now cross-engine except Firefox
(Safari 18.4+, all Chromium), and on a 24 MP or 48 MP phone yields 25.6 or 36.2 DPT. Firefox has no
usable stills path at all.

### What the numbers force

| If you want | Then | Capture needed |
|---|---|---|
| ≥20 DPT natively over 2000 mm, one frame | Only a full-sensor phone still (24/48 MP) reaches it | ≥4460 px wide |
| Model-space parity with the tracer's training geometry | Spend **≈4× the inference compute** — as one 1920×1088 frame *or* as a 2×2 tiling, which are the same arithmetic (§8.4). ≈1.8 s/frame at the measured 453 ms | ≥1920×922 — **1080p suffices** |
| Whole layout, one camera, one 960-px frame | Accept 4.30 DPT / 9.0 px cars, and measure whether it survives | anything ≥ 1920 px |

**Tiling is not a cheaper alternative to a bigger input — it is the same computation, reorganised.**
2×2 tiles at 960×544 is 4 × 522 240 px; one 1920×1088 frame is 4 × 522 240 px; both land on exactly
18.0 px car width (§8.4). And **horizontal-only tiling is nearly worthless**: split the layout into
two 1000×960 mm halves and the letterbox becomes *height*-bound, buying 10.6 px cars for 2× the cost.
Whatever is decided about the no-tiling premise, it should be decided on grounds other than cost,
because there is no cost difference to exploit.

### Stream vs. stills

**Decidable now, and the answer is stream.** Because model-space DPT is capture-independent
(finding 1), a still buys the detector nothing at whole-frame 960-px inference, while costing shutter
latency, a Firefox hole (§5), and an API surface that did not exist in Safari 14 months ago. And the
usual reason to reach for stills — "we will need the extra pixels once we raise the resolution" —
does not survive the arithmetic either: **every option in §8.4 up to and including fixture parity
needs ≤1920×922 of capture, which a 1080p stream already delivers.** Stills would only earn their
cost past 3×2 tiling, i.e. past *better* than the geometry the tracer trained on.

Stills remain the right tool for a different job: `<input type="file" capture>` is the highest-
resolution path any web page has (§6), and it is how the late-August high-DPT corpus photographs
should be collected.

---

## 1. The project geometry, restated exactly

From `config.yaml`: `layout.standard_gauge: 1435.0`, `layout.scale_to_ratio.N: 160`,
`layout.standard_width: 3000.0`, `layout.min_dpt: 20`, `detector.input: [960, 544]`.

* N-scale gauge = 1435 ÷ 160 = **8.96875 mm**. (The map's 4440×2130 figure comes from the nominal
  9.0 mm N gauge; the config-derived figure is 4460×2141. The 0.35% difference changes nothing
  below, and I use the config value throughout.)
* Layout 2000 × 960 mm → aspect **2.083:1**.
* Car width is **2.0906 track-widths** (3000 ÷ 1435), scale-invariant by construction.
* DPT over the full width = capture width px × 8.96875 ÷ 2000 = capture width px ÷ 223.0.

Because the layout is 2.083:1 and every camera is 16:9 (1.778) or 4:3 (1.333), **width is always the
binding dimension**. A 16:9 sensor framed to cover 2000 mm of width also covers 1125 mm of depth, so
15% of its height is wasted; a 4:3 sensor wastes 36%. All figures below are therefore quoted per
horizontal pixel.

---

## 2. What the specification actually promises

**[SPEC]** *Media Capture and Streams*, W3C Candidate Recommendation Draft, **09 October 2025**
([w3.org/TR/mediacapture-streams](https://www.w3.org/TR/mediacapture-streams/)).

On `width`/`height` as *capabilities*:

> "As a capability, its valid range should span the video source's pre-set width values with min
> being equal to 1 and max being the largest width."

And normatively, on downscaling:

> "The [User Agent] MUST support downsampling to any value between the min [width/height] range value
> and the native resolution."

On `resizeMode`:

> `"none"` — "This resolution and frame rate is offered by the camera, its driver, or the OS."
> `"crop-and-scale"` — "This resolution is downscaled and/or cropped from a higher camera resolution
> by the [User Agent], or its frame rate is decimated by the [User Agent]."
> "The media MUST NOT be upscaled, stretched or have fake data created that did not occur in the
> input source."

So the spec's model is: **the ceiling is the device's native formats; below that the UA is required
to synthesise anything you ask for; above it, nothing.** Both engines implement exactly this (§3,
§4). The practical consequence for this project is that `getCapabilities().width.max` is an honest
probe of the ceiling and `applyConstraints` above it will fail rather than silently succeed —
*provided* you read `getSettings()` back, because a resolution you asked for below the ceiling is
delivered by scaling, not by the sensor.

**How to tell them apart in practice:** ask for `resizeMode: 'none'`. Note that `resizeMode` is
supported only in Chromium (72+) and Firefox (144+); **Safari does not implement it at all** **[BCD]**
(`MediaDevices/getSupportedConstraints/return_object_property_resizeMode`: `safari: false`;
`MediaStreamTrack/applyConstraints/resizeMode_constraint`: `safari: false`). On Safari you must infer
nativeness by comparing `getSettings()` against `getCapabilities()`.

The `crop-and-scale` behaviour is acknowledged as **underspecified** by the working group —
[w3c/mediacapture-main#584](https://github.com/w3c/mediacapture-main/issues/584) records that the
spec does not say whether an aspect-ratio mismatch is resolved by stretching, centre-cropping, or
letterboxing. For this project that ambiguity is live: the layout is 2.083:1 and no sensor is, so any
constrained request with a mismatched aspect ratio may be **centre-cropped, silently discarding the
ends of the layout**. Constrain one dimension, or none, and letterbox in application code — do not
constrain to 2.083:1 and trust the UA.

---

## 3. WebKit: the ceiling is the device's native AVFoundation formats

**[SRC]** `Source/WebCore/platform/mediastream/cocoa/AVVideoCaptureSource.mm`,
`AVVideoCaptureSource::generatePresets()` (trunk, read 2026-08-04):

```objc
void AVVideoCaptureSource::generatePresets()
{
    Vector<VideoPreset> presets;
    for (AVCaptureDeviceFormat* format in [device() formats]) {
        // ... skips only packed-Bayer ProRes RAW sensor formats
        CMVideoDimensions dimensions = PAL::CMVideoFormatDescriptionGetDimensions(format.formatDescription);
```

It enumerates **every** `AVCaptureDeviceFormat` the OS offers, deduplicated by size. There is no
hardcoded cap. `RealtimeVideoCaptureSource::updateCapabilities()` then reports
`capabilities.setWidth({ minimumWidth, maximumWidth })` where `maximumWidth` is the max over those
presets **[SRC]** (`RealtimeVideoCaptureSource.cpp`).

**This retires the widely repeated "Safari only gives you 720p" claim.** That was true before
[WebKit bug 178109, "Support arbitrary video resolution in getUserMedia API"](https://bugs.webkit.org/show_bug.cgi?id=178109),
RESOLVED FIXED **2018-09-14** (r236015), which added the pixel-buffer resizer **[REL]**. Current
WebKit exposes the full native format list and downscales on request. Any source still asserting the
720p cap is describing Safari 11/12.

Two further behaviours from the same file, both load-bearing here:

* **WebKit never upscales.** `bestSupportedSizeFrameRateAndZoom()`:
  `// Don't look at presets smaller than the requested resolution because we never want to resize larger.`
  Requesting more than the largest native format finds no preset and the constraint fails **[SRC]**.
* **The "standard sizes" fallback tops out at 4K.** `standardVideoSizes()` is a fixed list ending
  `{ 2560, 1440 }, { 2592, 1936 }, { 3264, 2448 }, { 3840, 2160 }` **[SRC]**. It is consulted only
  when you constrain *one* of width/height and let the UA pick the other. **Practical rule for this
  project: always constrain both, or you are silently restricted to that ladder** — whose largest
  16:9 entry is 3840×2160 and whose largest entry of any shape is 3264×2448.

### Safari's stills path is real, and it can exceed the video preset

**[SRC]** `AVVideoCaptureSource::maxPhotoSizeForCurrentPreset()` / `maxPhotoSizeForFormat()`:

```objc
IntSize AVVideoCaptureSource::maxPhotoSizeForCurrentPreset(IntSize requestedSize) const
{
    auto *format = [device() activeFormat];
    if ([format respondsToSelector:@selector(supportedMaxPhotoDimensions)])
        return maxPhotoSizeForFormat(format, requestedSize);
    if (m_currentPreset)
        return m_currentPreset->size();
```

`maxPhotoSizeForFormat` picks the **smallest** entry of `format.supportedMaxPhotoDimensions` that is
still ≥ the requested size, defaulting to the first entry when nothing qualifies, and
`photoConfiguration()` applies it via `setMaxPhotoDimensions:`. Photos are encoded JPEG at
`AVVideoQualityKey: 1` (maximum) **[SRC]**.

`supportedMaxPhotoDimensions` on an iPhone rear wide camera includes the full-sensor still sizes —
substantially larger than the video preset. So on Apple platforms **`takePhoto()` genuinely returns a
full-sensor still, not a video frame**, and honours `photoSettings.imageWidth`/`imageHeight` as a
floor for format selection. **[SRC]** + **[INF]** on the specific dimensions offered per device
**[UNTESTED]**.

---

## 4. Chromium: no cap in the constraint algebra; `resizeMode` is the honest lever

**[SRC]** `third_party/blink/renderer/modules/mediastream/media_stream_constraints_util_sets.h`:

```cpp
class MODULES_EXPORT ResolutionSet {
 public:
  static const int kMaxDimension = std::numeric_limits<int>::max();
```

There is **no artificial resolution ceiling** in Blink. The ceiling is the device format list plus
rescaling, exactly as specified.

**[SRC]** `media_stream_constraints_util_video_device.cc`, `TryToApplyConstraintSet()`:

```cpp
    if (!result->rescale_intersection_.Contains(true)) {
      // If rescaling is not allowed, only the native resolution is allowed.
      result->resolution_intersection_ =
          result->resolution_intersection_.Intersection(
              ResolutionSet::FromExactResolution(NativeWidth(), NativeHeight()));
    }
```

That is the whole answer to "honoured vs. silently downscaled" for Chromium, in one branch:
**`resizeMode: 'none'` pins the track to the device's native format; anything else lets Blink scale
and crop to whatever you asked for.** Chromium's default permits rescaling, so an unqualified
`width: { ideal: 3840 }` on a 1080p webcam returns a track that *reports* 3840 while carrying no more
information than 1080p. This is the single most important gotcha for anyone measuring DPT from a
browser: **`track.getSettings().width` is not evidence of sensor pixels.**

Chromium also scores candidate formats by a "native fitness" distance (`NumericRangeNativeFitness`,
`NativeWidth()`/`NativeHeight()`/`NativeAspectRatio()`), so among formats that can satisfy the
constraints it prefers the one needing least rescaling **[SRC]** — good behaviour, but it does not
change the fact that a satisfiable-by-scaling request is satisfied.

Firefox differs, and historically differed sharply: it returned the closest **native** format rather
than rescaling to arbitrary sizes — that is the whole subject of
[Mozilla bug 1286945, "Offer downscaled resolutions and decimated framerates in getUserMedia"](https://bugzilla.mozilla.org/show_bug.cgi?id=1286945)
**[REL]**. Firefox only gained `MediaStreamTrack.getCapabilities()` in **132** and `resizeMode` in
**144** **[BCD]**, so capability probing there is recent. I did not read Gecko source for the current
rescale behaviour — treat Firefox's exact present-day policy as **[UNTESTED]**; the ceiling (native
formats) is the same either way, which is what matters here.

---

## 5. `ImageCapture` support, per engine, 2026

**[BCD]**, read from `api/ImageCapture.json` at `mdn/browser-compat-data@main` on 2026-08-04:

| | Chrome / Edge / Chrome Android | Safari (macOS/iOS/iPadOS) | Firefox |
|---|---|---|---|
| `ImageCapture` constructor | 59 | **18.4** | 35 *behind `dom.imagecapture.enabled`* |
| `takePhoto()` | 60 (59 without `photoSettings`) | **18.4** | behind the pref |
| `getPhotoCapabilities()` | 59 | **18.4** | **not supported** |
| `getPhotoSettings()` | 61 | **18.4** | **not supported** |
| `grabFrame()` | 59 | **26** | behind the pref |

Corroborated in vendor release notes **[REL]**: *WebKit Features in Safari 18.4* (**2025-03-31**) —
"WebKit for Safari 18.4 adds support for Image Capture API. It provides a way to enable the capture
of images or photos from a camera or other photographic device through MediaStream Image Capture
API." *Safari 26.0* (**2025-09-15**) lists `ImageCapture.grabFrame` under WebRTC.

**So the answer to "is it usable in 2026 or still Chromium-only" is: no longer Chromium-only, and
usable — on Chromium and WebKit.** Note `safari_ios: "mirror"` in BCD, meaning iOS/iPadOS track
desktop Safari; iOS 18.4 shipped alongside Safari 18.4.

Two caveats:

* **Firefox is a hole and has been for eleven years.** `dom.imagecapture.enabled` defaults false and
  `getPhotoCapabilities`/`getPhotoSettings` are simply absent
  ([bugzilla 888177](https://bugzilla.mozilla.org/show_bug.cgi?id=888177)). Any stills-based design
  needs a `grabFrame`-or-`drawImage` fallback for Firefox, which yields **stream** resolution — i.e.
  no better than §3/§4.
* **The W3C's own `implementation-status.md` is stale** — its Chrome notes are dated *February 2023*,
  its Safari section is empty, and it lists iOS under "Unsupported platforms". Do not cite it; BCD
  and the release notes are current.

---

## 6. `<input type="file" capture>` as a fallback

**[BCD]** `html/elements/input.json`, key `capture`, read 2026-08-04:

```
chrome: false | firefox: false | safari: false
safari_ios: 10 | chrome_android: 25 | firefox_android: 79 | samsung_internet: mirror
```

**The attribute is mobile-only.** Desktop Chrome, desktop Firefox and desktop Safari do not implement
it; there the element degrades to an ordinary file picker (which is still useful — a user can select
a photo shot on any camera, including one the browser cannot see at all).

MDN and the HTML spec say **nothing about the resolution** of the resulting file: `capture` is a hint
about *which* capture device to prefer, and the OS camera UI decides everything else **[SPEC]**.

What that means in practice, and it is the fallback's one real advantage: **the file comes from the
platform camera app, so it is a full-resolution still — 12 MP / 24 MP / 48 MP on a modern phone —
bypassing every `getUserMedia` and `ImageCapture` constraint discussed above.** It is the *highest*
resolution path available to a web page on any device class. Its costs are that it is manual (a user
gesture and a camera UI per frame, so unusable for a live view), mobile-only as an attribute, and
gives no control over focus, exposure or framing. **[INF]**

For this project it is worth keeping in mind for a different job than the live view: it is a
perfectly good way to acquire **high-DPT corpus photographs** for the late-August training campaign,
with no app support beyond a file input — which the editor already has.

---

## 7. Ceilings per device class

Sensor megapixels are not what the browser gets. The MacBook Pro M4 is the cautionary example: a
**12 MP** Center Stage sensor that streams **1080p** **[HW]**, because Center Stage crops and scales
from the sensor and the UVC/AVFoundation format it publishes is 1920×1080.

| Device class | Best live stream (`getUserMedia`) | Best still | Native DPT over 2000 mm, stream / still |
|---|---|---|---|
| **Phone** (recent iPhone / flagship Android) | 3840×2160 (4K) rear | 4032×3024 (12 MP), 5712×4284 (24 MP), 8064×6048 (48 MP) | **17.2** / 18.1–36.2 |
| **Tablet** (iPad Pro/Air) | 3840×2160 rear | 4032×3024 (12 MP) | **17.2** / 18.1 |
| **Laptop built-in** (MacBook 2021+, most PCs) | 1920×1080 | 1920×1080 (no larger photo format published) | **8.6** / 8.6 |
| **External USB webcam** (Logitech Brio 4K / MX Brio) | 4096×2160 @30 fps **[HW]** | same | **18.4** / 18.4 |
| **Machine-vision camera** (USB3 Vision / GigE) | **unreachable from a browser** | — | n/a |

Notes and caveats:

* The phone/tablet stream figure is **[SRC]**-derived (WebKit enumerates all device formats, §3) plus
  **[HW]** (recent iPhones and iPads record 4K video, so a 3840×2160 `AVCaptureDeviceFormat` exists).
  I have **not** run `getCapabilities()` on a device — **[UNTESTED]**. It is a five-minute check and
  worth doing before any hardware purchase.
* Logitech Brio: "4K/30 fps at up to 4096 × 2160", 1080p/60, 720p/90, 13 MP sensor, selectable 65°,
  78° or 90° diagonal FOV **[HW]** (Logitech Brio datasheet / support specification page). It exposes
  the higher modes over UVC, so both Chromium and WebKit see them.
* **macOS Continuity Camera** (using an iPhone as a Mac webcam) publishes **1080p**, not the phone's
  4K — so it is a laptop-class, not phone-class, capture path **[INF]** **[UNTESTED]**.
* **Machine-vision cameras are the sharp edge for the "elastic hardware" plan.** USB3 Vision and GigE
  Vision cameras are *not* UVC devices; they are invisible to `enumerateDevices()` on every engine.
  Reaching a 12–20 MP industrial camera from this app would require a local process bridging it to
  the browser — which collides head-on with the no-backend principle the map already flags. The
  browser-visible alternative is a **UVC-class** industrial board camera (several 4K/8 MP UVC modules
  exist), which puts you back at 3840–4096 px, i.e. no better than a Brio. **[INF]**
* **Firefox** on any of these classes is capped by the same hardware but has no stills API (§5), and
  before FF 132 no `getCapabilities()` at all.

### Camera distance for a 2000 mm covered width

**[CALC]**, thin-lens, distance = 1000 mm ÷ tan(hFOV/2), ignoring perspective and mount offset:

| Horizontal FOV | Distance above layout |
|---|---|
| 58° (Brio "65° diagonal") | **1.79 m** |
| 70° (Brio "78° diagonal") | **1.42 m** |
| 82° (Brio "90° diagonal") | **1.15 m** |
| ~69° (phone 26 mm-equivalent main) | **1.46 m** |
| ~100° (phone 13 mm-equivalent ultra-wide) | **0.84 m** |

All are physically plausible for a ceiling or gantry mount. The ultra-wide option buys the shortest
throw at the price of significant barrel distortion — which the v4 multi-point calibration
(`getDPT`/`getDPTResidual`) partly absorbs into the fit and partly surfaces as residual, so at least
it would be **visible** rather than silent. **[INF]**

---

## 8. The DPT arithmetic, worked

### 8.1 Native DPT, per capture width

DPT = capture width px × 8.96875 mm ÷ 2000 mm = capture width ÷ 223.0. **[CALC]**

| Capture width | Native DPT over 2000 mm | Width it *could* cover at 20 DPT |
|---:|---:|---:|
| 1280 (720p) | 5.7 | 574 mm |
| 1920 (1080p) | 8.6 | 861 mm |
| 2560 (1440p) | 11.5 | 1148 mm |
| **3840 (4K UHD)** | **17.2** | 1722 mm |
| 4032 (12 MP, 4:3) | 18.1 | 1808 mm |
| **4096 (DCI 4K)** | **18.4** | 1837 mm |
| 5712 (24 MP) | 25.6 | 2561 mm |
| 7680 (8K) | 34.4 | 3444 mm |
| 8064 (48 MP) | 36.2 | 3616 mm |

**20 DPT over 2000 mm requires 4460 × 2141 px.** Nothing streams it. A 4K stream covers **1722 mm**
at 20 DPT — 86% of the layout, so *one 4K camera at 20 DPT is 14% short of the long dimension*.

That said, 17.2 DPT (single 4K camera, whole layout) is **inside the fixture corpus's own native
range of 17.96–19.08** and only 14% below `min_dpt`. `min_dpt` warns and never blocks. On the native
axis, a single 4K camera is close to acceptable; the problem is elsewhere.

### 8.2 Model-space DPT — where the resolution actually goes

Layout aspect 2.083 vs. `detector.input` aspect 1.765: the letterbox is width-bound, so the 2000 mm
of layout always lands on **exactly 960 px**, with 461 px of content height and 83 px of bars.

> model-space DPT = (960 ÷ 2000 mm) × 8.96875 mm = **4.305** **[CALC]**
> car width = 4.305 × 2.0906 = **9.0 px**

**Capture width does not appear.** This is the finding that reorganises the whole question: at
whole-frame 960-px inference, **every capture path in §7 delivers identical information to the
detector.** 720p and 48 MP are the same 4.30 DPT. The only hard capture requirement is **≥960 px of
width** — below that you supply fewer pixels than the letterbox consumes — with a modest excess (say
2×, i.e. 1080p) worth having so the downsample has something to average.

Object sizes at the model input, N scale **[CALC]**:

| Object | Prototype | N-scale mm | Model-input px |
|---|---|---|---|
| Car **width** | 3000 mm (`standard_width`) | 18.8 | **9.0** |
| 40 ft boxcar length | 12.2 m | 76 | 37 |
| 26 m passenger car length | 26 m | 162 | 78 |

A 9 px width against YOLO's stride-8 P3 head is roughly **one grid cell across**. That is the regime
where detection is known to fall apart, and it is below the COCO "small object" threshold on both
axes of the definition.

### 8.3 Against the tracer's actual training geometry

The fixtures are 1920×1080 at native DPT 17.96–19.08 (HO). Letterboxing 1920×1080 into 960×544 is an
exact 0.5× — 16:9 into 16:9.06, so effectively no bars. **[CALC]**

| | Native DPT | Letterbox scale | Model-space DPT | Car width at model |
|---|---:|---:|---:|---:|
| **Fixture corpus (what the tracer trained on)** | 17.96–19.08 | 0.500 | **8.98–9.54** | **18.8–19.9 px** |
| **One camera over 2000 mm (proposed)** | 17.2 (4K) | 0.215 | **4.30** | **9.0 px** |
| Ratio | | | | **2.1× worse** |

The tracer's reported ~0.60 recall / ~0.65 precision (map #79, #86) was obtained at 19 px cars. The
deployment geometry offers 9 px. **Nothing in the capture chain recovers that** — it is spent by the
decision to put 2000 mm of layout into 960 px.

### 8.4 The levers, priced — and why tiling is not a shortcut

Model-space DPT depends on exactly one quantity: **the linear model-pixel density across the
layout**. There are only two ways to raise it — a larger model input, or more tiles — and both cost
quadratically, because both are just "more model pixels".

Raising the whole-frame input (aspect held at 1.765), **[CALC]**:

| `detector.input` | Model-space DPT | Car width | Cost | Capture needed |
|---|---:|---:|---:|---|
| **960×544** (today) | 4.30 | **9.0 px** | 1.0× | 960×461 |
| 1280×736 | 5.74 | 12.0 px | 1.8× | 1280×614 |
| **1920×1088** | **8.61** | **18.0 px** | **4.0×** | 1920×922 |
| 2560×1440 | 11.48 | 24.0 px | 7.1× | 2560×1229 |
| 2880×1632 | 12.91 | 27.0 px | 9.0× | 2880×1382 |

Tiling, `detector.input` held at 960×544, tiles named `n_x × n_y`, **[CALC]**:

| Tiling | Tile covers (mm) | Tile aspect | Model-space DPT | Car width | Cost | Capture needed |
|---|---|---:|---:|---:|---:|---|
| 1×1 (today) | 2000 × 960 | 2.08 | 4.30 | 9.0 px | 1× | 960×461 |
| **2×1** | 1000 × 960 | 1.04 | **5.08** | **10.6 px** | **2×** | 1133×544 |
| 3×1 | 667 × 960 | 0.69 | 5.08 | 10.6 px | 3× | 1133×544 |
| 1×2 | 2000 × 480 | 4.17 | 4.30 | 9.0 px | 2× | 960×461 |
| **2×2** | 1000 × 480 | 2.08 | **8.61** | **18.0 px** | **4×** | 1920×922 |
| 3×2 | 667 × 480 | 1.39 | 10.16 | 21.2 px | 6× | 2267×1088 |
| 3×3 | 667 × 320 | 2.08 | 12.92 | 27.0 px | 9× | 2880×1382 |

Three things fall out of putting these side by side:

1. **2×2 tiling and a 1920×1088 input are the same computation.** Both are 4 × (960×544) pixels, both
   give 18.0 px cars, both need 1920×922 of capture. Tiling is not a way to buy resolution cheaply;
   it is a way to spend the same money in smaller instalments (which does help peak memory and lets
   you skip empty tiles, but that is a different argument).
2. **Horizontal-only tiling barely works.** 2×1 and 3×1 both stall at 5.08 DPT, because a
   1000×960 mm tile has aspect 1.04 against a 1.765 input — the letterbox flips from width-bound to
   *height*-bound, and the 960 mm of layout depth into 544 px becomes the cap. Any tiling that helps
   must cut the depth too, and the rows that do (2×2, 3×2, 3×3) all have tile aspect ≥ 1.39.
3. **Fixture parity costs ~4×.** Reaching the corpus's 8.98–9.54 model-space DPT needs 2003×961 to
   2127×1021 model pixels — **3.7× to 4.2×** the current budget. At the measured 453 ms that is
   ~1.7–1.9 s per frame on the i7 under WASM. On a Mac mini or with WebGPU it is unremarkable.

**And the capture requirement in every one of those rows is ≤ 2880 px, with fixture parity at
1920×922.** A plain **1080p** stream — a laptop's built-in camera — supplies fixture parity exactly.
4K only starts to matter past 3×2 tiling, i.e. past *better* than the geometry the tracer trained on.
This is the concrete form of finding 1: **capture resolution is not the binding constraint anywhere
in the plausible design space.**

### 8.5 A free 7%, in passing

`detector.input: [960, 544]` has aspect 1.765, inherited from the 16:9 fixtures. The layout is 2.083.
Whole-frame, the content occupies **960×461 of the 960×544 input — 15% of the tensor is letterbox
bar** **[CALC]**. At the same pixel budget, an input shaped nearer the layout (e.g. **1024×512**,
both /32) gives model-space DPT **4.59** and a **9.6 px** car — 7% more resolution for 0.4% more
compute. Not a fix for anything, but free, and it costs one config edit plus a re-export. It only
applies once the camera geometry is actually 2.083:1; against the 16:9 fixture corpus, 960×544 is
already correct. **[INF]**

---

## 9. Recommended probe, before any hardware is bought

Nothing above needs a purchase to verify. This runs in the existing UI's secure context and settles
every **[UNTESTED]** flag in §7:

```js
const s = await navigator.mediaDevices.getUserMedia({ video: true });
const t = s.getVideoTracks()[0];
console.log('capabilities', t.getCapabilities());   // width.max / height.max = the honest ceiling
console.log('settings', t.getSettings());           // what you actually got

// Ask for the ceiling, then read back — never trust the request.
await t.applyConstraints({ width: { exact: t.getCapabilities().width.max } });
console.log('after exact-max', t.getSettings());

// Chromium/Firefox only: prove nativeness.
if (navigator.mediaDevices.getSupportedConstraints().resizeMode)
  await t.applyConstraints({ resizeMode: 'none' });

// Stills ceiling, where supported (Chromium, Safari 18.4+).
if (window.ImageCapture) console.log(await new ImageCapture(t).getPhotoCapabilities());
```

Read `getSettings()` after every `applyConstraints()`. Per §4, a request satisfied by scaling reports
the number you asked for.

---

## 10. Open questions this research does not close

* **Does the detector survive 9.0 px cars?** Unanswerable from browser facts. It is measurable today
  without new photographs: downsample the 46 fixtures by 2.15× before export and re-run the tracer's
  validation. That is the "accuracy vs. resolution" experiment the map already lists as unspecified,
  and §8.3 gives it a target number to aim at (car width 9.0 px vs. the 18.8–19.9 px baseline).
* **Actual `getCapabilities()` values on real devices** — §7's phone/tablet rows are source-plus-spec
  inference, not measurement.
* **Whether a 2.083:1 constrained request is centre-cropped** on any given engine — the spec does not
  say ([w3c/mediacapture-main#584](https://github.com/w3c/mediacapture-main/issues/584)). Avoid the
  situation rather than testing it.
* **Lens distortion at the wide FOVs §7 requires**, and how much of it the multi-point calibration
  absorbs versus surfaces as `getDPTResidual`.

---

## Sources

**Specifications**

* [Media Capture and Streams](https://www.w3.org/TR/mediacapture-streams/), W3C Candidate
  Recommendation Draft, 2025-10-09 — `width`, `height`, `resizeMode`, the downsampling MUST.
* [MediaStream Image Capture](https://w3c.github.io/mediacapture-image/#imagecaptureapi), W3C —
  `ImageCapture`, `takePhoto`, `PhotoSettings`.
* [w3c/mediacapture-main#584](https://github.com/w3c/mediacapture-main/issues/584) — `crop-and-scale`
  is underspecified for aspect-ratio mismatches.
* [w3c/mediacapture-image `implementation-status.md`](https://github.com/w3c/mediacapture-image/blob/main/implementation-status.md)
  — cited only to note that it is **stale** (Chrome notes dated February 2023, Safari section empty,
  iOS listed unsupported).

**Engine source, read at trunk on 2026-08-04**

* WebKit `Source/WebCore/platform/mediastream/cocoa/AVVideoCaptureSource.mm` —
  `generatePresets()`, `maxPhotoSizeForCurrentPreset()`, `maxPhotoSizeForFormat()`,
  `photoConfiguration()`, `takePhotoInternal()`.
* WebKit `Source/WebCore/platform/mediastream/RealtimeVideoCaptureSource.cpp` —
  `standardVideoSizes()`, `updateCapabilities()`, `bestSupportedSizeFrameRateAndZoom()`,
  `supportsCaptureSize()`.
* Chromium `third_party/blink/renderer/modules/mediastream/media_stream_constraints_util_video_device.cc`
  — `TryToApplyConstraintSet()`, `NumericRangeNativeFitness()`, the rescale branch.
* Chromium `third_party/blink/renderer/modules/mediastream/media_stream_constraints_util_sets.h` —
  `ResolutionSet::kMaxDimension`.
  (Chromium read via the `chromium/chromium` GitHub mirror at `main`, pushed 2026-08-04.)

**Compatibility data**

* [`mdn/browser-compat-data`](https://github.com/mdn/browser-compat-data) at `main`, files
  `api/ImageCapture.json`, `api/MediaStreamTrack.json`, `api/MediaDevices.json`,
  `html/elements/input.json`.

**Release notes and bug trackers**

* [WebKit Features in Safari 18.4](https://webkit.org/blog/16574/webkit-features-in-safari-18-4/),
  2025-03-31 — Image Capture API added.
* [WebKit Features in Safari 26.0](https://webkit.org/blog/17333/webkit-features-in-safari-26-0/),
  2025-09-15 — `ImageCapture.grabFrame`.
* [WebKit bug 178109](https://bugs.webkit.org/show_bug.cgi?id=178109) — "Support arbitrary video
  resolution in getUserMedia API", RESOLVED FIXED 2018-09-14 (r236015).
* [Mozilla bug 888177](https://bugzilla.mozilla.org/show_bug.cgi?id=888177) — Firefox ImageCapture.
* [MDN: `capture` attribute](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Attributes/capture).

**Hardware**

* [Logitech Brio 4K datasheet](https://www.logitech.com/content/dam/logitech/en/video-collaboration/pdf/brio-datasheet.pdf)
  and [Brio 4K specification page](https://support.logi.com/hc/en-au/articles/4415100718359-Specification-BRIO-4K-Webcam)
  — 4096×2160 @30, 13 MP sensor, 65/78/90° diagonal FOV.
* Apple MacBook Pro (M4, 2024) tech specs — 12 MP Center Stage camera, **1080p** video.

**This repo**

`config.yaml` (`layout.standard_gauge`, `layout.scale_to_ratio`, `layout.standard_width`,
`layout.min_dpt`, `detector.input`), `SPEC.md` § Accuracy and § Location Data, `CLAUDE.md`,
`docs/research/issue-3-browser-yolo-feasibility.md` (fixture native DPT 17.96–19.08; the 453 ms and
6.9 GFLOPs baselines), issues [#79](https://github.com/iot49/rails49/issues/79) and
[#51](https://github.com/iot49/rails49/issues/51).
