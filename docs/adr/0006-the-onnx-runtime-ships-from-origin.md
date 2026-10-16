# The ONNX Runtime ships from origin

The ONNX Runtime WASM files are served from the app's own origin, not a CDN. `ui/public/_headers` makes the origin cross-origin isolated so ORT can use more than one WASM thread, and `require-corp` then rejects every cross-origin subresource. Anything the app fetches must come from origin; a CDN added later drops ORT to one thread with no error.

The app imports `onnxruntime-web/wasm`, not the package root, so the 25.02 MiB WebGPU binary stays out of a deploy that Cloudflare Pages limits to 25 MiB per file. Decided in [#15](https://github.com/rails49/occupancy/issues/15).
