#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.12"
# dependencies = ["pillow==13.0.0"]
# ///
"""Converts a ceiling capture's ProRAW DNGs to landscape JPEGs (#261).

`bin/dng-to-jpeg.py <capture>` reads `<capture>/raw/*.DNG` and writes
`<capture>/jpg/<name>.jpg` at quality 95 — the form training was tested on
(rails49/detector#25). It is step 4 of README § Capture, and runs on the Mac
rather than in the app because no browser decodes DNG.

Each JPEG comes out landscape with no orientation tag, which is the array the
editor stores and will accept: it sets the tag to 1 on import and refuses an
image whose stored array is portrait (#255).

macOS only: the decode is `sips`.
"""

import subprocess
import sys
import tempfile
from pathlib import Path

from PIL import Image, ImageOps

#: What the detector was trained and tested on (rails49/detector#25).
JPEG_QUALITY = 95


def to_landscape(image: Image.Image) -> Image.Image:
    """`image` upright and landscape, with no orientation tag left on it.

    Face down on the ceiling, iOS cannot tell which way is up, so what the
    decode hands back is not predictable: on 2026-10-28 `sips` wrote portrait
    pixels with the rotation already applied, on 2026-10-29 landscape pixels
    with orientation 6. So the tag is applied first and the result is then
    measured, rather than either being assumed.

    `ImageOps.exif_transpose` is that first half. Pillow's TIFF reader applies
    the tag itself on load, so on a `sips` TIFF the call finds nothing to do;
    it is here because the input is a decoded image of any format, not one
    container whose reader can be relied on for that.
    """
    upright = ImageOps.exif_transpose(image)
    if upright.height > upright.width:
        # `ROTATE_270` turns counter-clockwise, so it is the clockwise quarter.
        upright = upright.transpose(Image.Transpose.ROTATE_270)
    return upright


def write_landscape_jpeg(decoded: Path, dest: Path) -> None:
    """Writes the decoded image at `decoded` to `dest`, landscape.

    The ICC profile is carried over: the RAW decode is not sRGB, and dropping
    the profile would change the colours every later reader sees. The EXIF
    block is not carried over — a TIFF's IFD describes that TIFF's strips, not
    the photograph, and the one tag that matters downstream is the orientation
    this step has already spent.
    """
    with Image.open(decoded) as image:
        landscape = to_landscape(image)
        landscape.save(
            dest,
            "JPEG",
            quality=JPEG_QUALITY,
            icc_profile=landscape.info.get("icc_profile"),
        )


def decode_dng(dng: Path, into: Path) -> Path:
    """Decodes `dng` to a TIFF in `into` and returns its path.

    `sips -s format tiff` is Core Image's RAW decode at its defaults, which is
    the rendering Photos showed when the shot was picked.
    """
    tiff = into / f"{dng.stem}.tiff"
    subprocess.run(
        ["sips", "-s", "format", "tiff", str(dng), "--out", str(tiff)],
        check=True,
        capture_output=True,
        text=True,
    )
    return tiff


def main(argv: list[str]) -> int:
    """`<capture>` converted, or a one-line message and a non-zero status.

    The macOS check sits here and nowhere else, so that the conversion itself
    stays callable from whatever runs the gate.
    """
    if sys.platform != "darwin":
        print("dng-to-jpeg.py needs macOS: the DNG decode is sips.", file=sys.stderr)
        return 1
    if len(argv) != 1:
        print("usage: bin/dng-to-jpeg.py <capture>", file=sys.stderr)
        return 1

    capture = Path(argv[0])
    raw = capture / "raw"
    jpg = capture / "jpg"
    dngs = sorted(raw.glob("*.DNG"))
    if not dngs:
        print(f"no DNGs in {raw}", file=sys.stderr)
        return 1

    # Every destination is checked before any is written, so that a refusal
    # leaves the capture as it was rather than half converted.
    taken = [dng.stem for dng in dngs if (jpg / f"{dng.stem}.jpg").exists()]
    if taken:
        print(
            f"{jpg} already holds {', '.join(f'{stem}.jpg' for stem in taken)}",
            file=sys.stderr,
        )
        return 1

    jpg.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as decoded_dir:
        for dng in dngs:
            dest = jpg / f"{dng.stem}.jpg"
            try:
                tiff = decode_dng(dng, Path(decoded_dir))
            except subprocess.CalledProcessError as failure:
                # The JPEGs already written stay where they are, and the
                # refusal above names them on the next run: a capture that
                # failed part way has to be cleared rather than topped up,
                # because what `sips` wrote before it failed is not known good.
                said = " ".join(failure.stderr.split()) or f"exit {failure.returncode}"
                print(f"sips could not decode {dng}: {said}", file=sys.stderr)
                return 1
            write_landscape_jpeg(tiff, dest)
            tiff.unlink()
            print(f"{dng.name} → {dest}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
