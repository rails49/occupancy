# 🚂 Rails49

Computer vision suite for model railroaders to detect track occupancy using deep neural networks.

---

## 🌟 Overview

This project detects track occupancy from an overhead camera. An oriented-box object detector finds the cars in each frame, and the live view reports which sensors they cover.

**WARNING**: The detector sometimes misses rolling stock and sometimes reports trains where there are none. It is not a safety interlock. Responsibility for safe operation rests with the user.

The application is offered as a static webapp served at https://occupancy.rails49.org/. When run from a mobile device with an attached camera (e.g. a smartphone) it shows the locations of detected trains in the browser.

## 🛠 Development

Requires [pnpm](https://pnpm.io/) and Node at the version in `.nvmrc`. Run from the repository root unless noted.

| Task | Command |
| :--- | :--- |
| Install dependencies | `pnpm install` |
| Full check (typecheck, UI lint, TS tests, look-check, UI build) | `bin/test.sh` |
| Install the hooks: pre-commit refuses commits on `main`, pre-push runs `bin/test.sh` | `bin/install-hooks.sh` |
| Typecheck all packages | `pnpm typecheck` |
| Lint `ui/src` (`eslint.config.mjs`) | `pnpm lint` |
| All TS tests | `pnpm test` |
| Tests for one package | `pnpm --filter @occupancy/drift test` |
| A single test file | `pnpm --filter @occupancy/ui test tests/carMarker.test.ts` |
| Watch mode (ui) | `pnpm --filter @occupancy/ui test:watch` |
| The chrome check alone | `ui/node_modules/.bin/look-check ui/src ui/index.html` |
| UI dev server | `pnpm --filter @occupancy/ui dev` (`dev:http` for plain HTTP) |
| Build the UI | `pnpm build` |
| Run the gate against an unreleased detector | `bin/with-detector.sh` (needs a [rails49/detector](https://github.com/rails49/detector/blob/main/README.md) checkout at `../detector`; puts the pinned version back on exit) |
| Run the UI against an unreleased detector | `bin/with-detector.sh pnpm --filter @occupancy/ui dev` (shows detections only if `../detector/detector/models` holds an exported model) |
| Score the drift check on the fixtures | `pnpm --filter @occupancy/drift-bench bench` (needs `rails49/r49` cloned at `../r49`; about 10 minutes) |
| Deploy to Cloudflare Pages | `bin/deploy.sh` |

The dev server serves HTTPS with a self-signed certificate, because `getUserMedia` needs a secure context; a phone on the LAN needs the HTTPS URL. It also sets the COOP/COEP headers that ONNX Runtime's threaded WASM needs.

`bin/deploy.sh` reads Cloudflare credentials from the environment or from 1Password (`op://rails49/Cloudflare Pages/…`), and runs only from a clean `origin/main`.

## 🤝 Contributing

See [SPEC.md](SPEC.md) for what the system is meant to do and why — the requirements,
the `.r49` format, and the reasoning behind the design. Much of it is the target rather
than a description of what ships today.

See [docs/SYSTEM.md](docs/SYSTEM.md) for how the stages fit together, and
[lib/CLAUDE.md](lib/CLAUDE.md) for the interface convention the shared
TypeScript libraries follow. The detector, its training and the training data
are in [rails49/detector](https://github.com/rails49/detector).

Pull requests are welcome. By contributing you agree that your contributions
are licensed under the [GNU Affero General Public License v3.0](LICENSE), the
same terms that cover the rest of the project. There is no CLA.

## 📄 License

Copyright (C) 2026 Bernhard Boser

This program is free software: you can redistribute it and/or modify it under
the terms of the GNU Affero General Public License as published by the Free
Software Foundation, either version 3 of the License, or (at your option) any
later version. See [LICENSE](LICENSE) for the full text.

The project is AGPL-3.0 because it ships a detector derived from
[Ultralytics YOLO](https://github.com/ultralytics/ultralytics), which is
AGPL-3.0 licensed; trained weights inherit those terms. If you deploy a
modified version, the licence requires you to make your source available to
its users.

