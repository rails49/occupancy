# 🚂 Rails49

Computer vision suite for model railroaders to detect track occupancy using deep neural networks.

---

## 🌟 Overview

This project detects track occupancy from an overhead camera. An oriented-box object detector finds the cars in each frame, and the live view reports which sensors they cover.

**WARNING**: The detector sometimes misses rolling stock and sometimes reports trains where there are none. It is not a safety interlock. Responsibility for safe operation rests with the user.

The application is offered as a static webapp served at https://occupancy.rails49.org/. When run from a mobile device with an attached camera (e.g. a smartphone) it shows the locations of detected trains in the browser.

## 🛠 Development

Requires [pnpm](https://pnpm.io/) and Node at the version in `.nvmrc`, and [uv](https://docs.astral.sh/uv/) for the checks on the Python scripts in `bin/`. Run from the repository root unless noted.

| Task | Command |
| :--- | :--- |
| Install dependencies | `pnpm install` |
| Full check (typecheck, UI lint, TS tests, look-check, Python checks, UI build) | `bin/test.sh` |
| Install the hooks: pre-commit refuses commits on `main`, pre-push runs `bin/test.sh` | `bin/install-hooks.sh` |
| Typecheck all packages | `pnpm typecheck` |
| Lint `ui/src` (`eslint.config.mjs`) | `pnpm lint` |
| All TS tests | `pnpm test` |
| Tests for one package | `pnpm --filter @occupancy/drift test` |
| A single test file | `pnpm --filter @occupancy/ui test tests/carMarker.test.ts` |
| Watch mode (ui) | `pnpm --filter @occupancy/ui test:watch` |
| The chrome check alone | `ui/node_modules/.bin/look-check ui/src ui/index.html` |
| UI dev server | `pnpm --filter @occupancy/ui dev` (`dev:http` for plain HTTP) |
| Serve the built page with a stand-in occupancy service | `node bin/live-stub.mjs` (see below) |
| Build the UI | `pnpm build` |
| Run the gate against an unreleased detector | `bin/with-detector.sh` (needs a [rails49/detector](https://github.com/rails49/detector/blob/main/README.md) checkout at `../detector`; puts the pinned version back on exit) |
| Run the UI against an unreleased detector | `bin/with-detector.sh pnpm --filter @occupancy/ui dev` (shows detections only if `../detector/detector/models` holds an exported model) |
| Score the drift check on the fixtures | `pnpm --filter @occupancy/drift-bench bench` (needs `rails49/r49` cloned at `../r49`; about 10 minutes) |
| Deploy to Cloudflare Pages | `bin/deploy.sh` |

The dev server serves HTTPS with a self-signed certificate, because `getUserMedia` needs a secure context; a phone on the LAN needs the HTTPS URL. It also sets the COOP/COEP headers that ONNX Runtime's threaded WASM needs.

`bin/deploy.sh` reads Cloudflare credentials from the environment or from 1Password (`op://rails49/Cloudflare Pages/…`), and runs only from a clean `origin/main`.

## 🛰 Checking the live view against a service

The page looks for an [occupancy service](GLOSSARY.md#occupancy) at `/live` on its own origin when
it loads ([#331](https://github.com/rails49/occupancy/issues/331)). Where it finds one, pressing
Live shows that service's frames, its sensor states, its L0 where it sends any, and the rate the
page is getting — no camera, no model loaded here, and no drift check. The page only shows what the
service decided; the detection that runs the railroad happens in the service. The deployed site
serves no service, so it behaves as it always has.

`bin/live-stub.mjs` is a stand-in for checking that by hand. It is **not** the service — that is
[rails49/occupancy-service](https://github.com/rails49/occupancy-service), whose `LIVE.md` is the
contract — but it answers the same three paths with a real JPEG and a car moving along a length of
track, which is enough to see frames, states, boxes and a frame rate on a device. It also sends
every optional field of `LIVE.md`, with a PNG patch per sensor but one, for the Details panel
([#332](https://github.com/rails49/occupancy/issues/332)), and with `--archive <dir>` it serves and
**accepts writes into** that folder, which is what the editor opens and saves
([#333](https://github.com/rails49/occupancy/issues/333)). It serves the
built page from the same origin, because `/live` is on the page's own origin and there is no setting
for anything else.

```sh
pnpm --filter @occupancy/ui build     # the page it serves
node bin/live-stub.mjs                # port 8080, bound on every interface
```

Then open `http://<this machine's IP>:8080/` on the phone or tablet and press Live. Plain HTTP is
enough: service mode uses no camera, so it needs no secure context. Flags worth knowing:
`--port`, `--fps`, `--no-frames` (the service saying it has no frame: the last picture should stay
under "No picture from the camera", every sensor should read `unknown` with the reason, and the rate
should drop to 0, and Details should keep the camera line, read `lost`), `--churn` (drops the event-stream clients every 20 s, as the real service does
after a save, so the page re-reads the manifest) and `--archive <dir>` (below).

### Checking the archive on a service

Without `--archive` the stand-in serves its own made-up manifest and no `ETag`, which is a
**read-only** archive from the page's side: the page opens it, and Save says so and offers Save As.
With `--archive <dir>` the folder is the archive, and the stand-in follows `LIVE.md`'s saving rules
over it — `GET`, `PUT` and `DELETE` per file, the manifest's version in `ETag`, `If-Match` on every
write, 412 on a stale one, and **411 on a body with no `Content-Length`**.

```sh
mkdir -p /tmp/yard && cp <some>.r49-manifest /tmp/yard/manifest.json   # or unzip a .r49 into it
pnpm --filter @occupancy/ui build
node bin/live-stub.mjs --archive /tmp/yard
```

The page opens that archive at load. Add an image, label it, press Save, reload: the image and the
label are there, and the folder holds the file. Delete it, press Save, and the file is gone. Save As
writes a `.r49` and moves the work to that file, after which Live goes back to this device's camera.

Press Live and then **Freeze** ([#334](https://github.com/rails49/occupancy/issues/334)) and the
frame on screen is added to that archive: the picture keeps running, the editor shows the new image,
and Save writes it into the folder. With `--no-frames` the button is disabled, because the picture
still on screen is out of date.

`occupancy-service`'s conformance check passes against the stand-in, with frames on and off:

```sh
uvx --from git+https://github.com/rails49/occupancy-service live-check http://localhost:8080/live
```

## 📷 Capture

A 48 MP ceiling capture of the layout, from the iPhone into an archive with no
hand conversion. The editor's "Capture from Camera" grabs one 1920×1080 video
frame — about DPT 8 from the ceiling, far below the detector's `MIN_DPT` — and
no iPhone browser takes a 48 MP or a RAW still, so the photographs that train
the detector come from the Camera app and reach the archive as files.

1. iPhone 16 Pro Max face down on the ceiling, about 1500 mm above the layout.
   Camera app at ProRAW 48 MP, 1x lens. Shutter and preview from the Apple Watch
   Camera Remote.
2. iCloud Photos syncs the shots to the Mac. Photos set to "Download Originals
   to this Mac", or wait until the originals have downloaded.
3. In Photos, select the session's shots, File → Export → Export Unmodified
   Original, into `<capture>/raw/`.
4. `bin/dng-to-jpeg.py <capture>` writes `<capture>/jpg/`.
5. In the editor, create an archive and import all of `<capture>/jpg/` in one
   pick.

`<capture>` is a folder of your own, outside this repository. The DNGs stay
there, in `<capture>/raw/`, and only the JPEGs go into the archive, converted at
quality 95 — the format
[rails49/detector#25](https://github.com/rails49/detector/issues/25) trained on.
No browser decodes DNG, which is why step 4 runs on the Mac rather than in the
app.

The pick is one undo entry, and each image keeps the filename
`bin/dng-to-jpeg.py` gave it, which is the DNG's stem — the name the shot had on
the phone ([#262](https://github.com/rails49/occupancy/issues/262)). That is how
the corpus is indexed outside this program. A shot the pick cannot store is left
out and named, and the rest of the session still lands.

Face down, iOS cannot tell which way is up, so a shot decodes portrait or
carries an orientation tag. The editor sets the tag to 1 in the bytes it stores,
and refuses an image whose stored array is portrait
([#255](https://github.com/rails49/occupancy/issues/255)).

Stay on the 1x lens for the whole session. Every image in an archive is the size
`camera.resolution` declares — the first one sets it, and the editor refuses one
of another size, naming both
([#260](https://github.com/rails49/occupancy/issues/260)). A 0.5x shot is
another field of view at another pixel count, so a label authored on it lands in
the wrong place.

## 🤝 Contributing

See [SPEC.md](SPEC.md) for what the system is meant to do and why — the requirements,
the `.r49` format, and the reasoning behind the design. Much of it is the target rather
than a description of what ships today.

See [docs/SYSTEM.md](docs/SYSTEM.md) for how the stages fit together, and
[lib/CLAUDE.md](lib/CLAUDE.md) for the interface convention the shared
TypeScript libraries follow. The detector, its training and the training data
are in [rails49/detector](https://github.com/rails49/detector).

Pull requests are welcome. By contributing you agree that your contributions
are licensed under the [MIT License](LICENSE), the same terms that cover the
rest of the project. There is no CLA.

## 📄 License

The code in this repository is MIT. See [LICENSE](LICENSE).

The deployed site also serves `@rails49/detector`, its model weights and
browser runtime, under AGPL-3.0. Their source is
[rails49/detector](https://github.com/rails49/detector). Why only that part is
AGPL: [rails49/detector ADR 0015](https://github.com/rails49/detector/blob/main/docs/adr/0015-only-the-yolo-detector-is-agpl.md).

