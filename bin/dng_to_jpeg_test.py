"""The orientation step of `bin/dng-to-jpeg.py` (#261).

The cases are the shapes `sips` has been seen to hand back for one ceiling
capture — landscape with orientation 1, landscape with orientation 6, portrait
with no tag — and each has to come out landscape with no orientation tag. The
`sips` decode itself is not covered: it needs macOS and a real DNG.

A fixture's top-left quadrant is red and the rest black, so the step's rotation
shows up as the corner the red lands in and not only as the size: a size
assertion alone passes on a landscape decode that was never touched.
"""

import importlib.util
from collections.abc import Callable
from pathlib import Path

import pytest
from PIL import Image, ImageCms

ORIENTATION_TAG = 0x0112

#: Where to sample for a fixture's red quadrant, as a fraction of the size.
CORNERS = {
    "top-left": (0.25, 0.25),
    "top-right": (0.75, 0.25),
    "bottom-left": (0.25, 0.75),
    "bottom-right": (0.75, 0.75),
}

#: A real profile, so that "kept" means these exact bytes came back.
ICC_PROFILE = ImageCms.ImageCmsProfile(ImageCms.createProfile("sRGB")).tobytes()


def load_step() -> Callable[[Path, Path], None]:
    """The step under test, loaded by path.

    `dng-to-jpeg.py` is a script name, not an importable module name.
    """
    path = Path(__file__).with_name("dng-to-jpeg.py")
    spec = importlib.util.spec_from_file_location("dng_to_jpeg", path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.write_landscape_jpeg


write_landscape_jpeg = load_step()


def decoded(
    tmp_path: Path,
    size: tuple[int, int],
    orientation: int | None,
    suffix: str = ".tiff",
) -> Path:
    """A decoded image of `size` with `orientation`; a TIFF, as `sips` writes."""
    image = Image.new("RGB", size, "black")
    image.paste("red", (0, 0, size[0] // 2, size[1] // 2))
    exif = image.getexif()
    if orientation is not None:
        exif[ORIENTATION_TAG] = orientation
    path = (tmp_path / "decoded").with_suffix(suffix)
    image.save(path, exif=exif, icc_profile=ICC_PROFILE)
    return path


def is_red(pixel: object) -> bool:
    """Whether `pixel` is the fixture's red; quality 95 is lossy."""
    assert isinstance(pixel, tuple)
    return pixel[0] > 200 and pixel[1] < 60 and pixel[2] < 60


def red_corner(image: Image.Image) -> str:
    """The corner of `image` holding the fixture's red quadrant."""
    found = [
        name
        for name, (x, y) in CORNERS.items()
        if is_red(image.getpixel((int(image.width * x), int(image.height * y))))
    ]
    assert len(found) == 1, f"expected one red corner, found {found}"
    return found[0]


def test_a_landscape_decode_with_orientation_1_is_saved_as_it_is(
    tmp_path: Path,
) -> None:
    dest = tmp_path / "out.jpg"
    write_landscape_jpeg(decoded(tmp_path, (60, 40), 1), dest)

    with Image.open(dest) as saved:
        assert saved.size == (60, 40)
        assert red_corner(saved) == "top-left"
        assert ORIENTATION_TAG not in saved.getexif()


# Both containers: Pillow's TIFF reader applies the tag itself on load and its
# JPEG reader does not, so the TIFF is the decode `sips` really hands over and
# the JPEG is the case that reaches the step's own `exif_transpose`. Without it
# the step would depend on which reader it was handed.
@pytest.mark.parametrize("suffix", [".tiff", ".jpg"])
def test_a_landscape_decode_with_orientation_6_has_the_tag_applied(
    tmp_path: Path, suffix: str
) -> None:
    dest = tmp_path / "out.jpg"
    write_landscape_jpeg(decoded(tmp_path, (60, 40), 6, suffix), dest)

    # Orientation 6 means the upright image is the stored array turned 90°
    # clockwise, which is portrait, so the step turns it clockwise again.
    with Image.open(dest) as saved:
        assert saved.size == (60, 40)
        assert red_corner(saved) == "bottom-right"
        assert ORIENTATION_TAG not in saved.getexif()


def test_a_portrait_decode_with_no_tag_is_turned_clockwise(tmp_path: Path) -> None:
    dest = tmp_path / "out.jpg"
    write_landscape_jpeg(decoded(tmp_path, (40, 60), None), dest)

    with Image.open(dest) as saved:
        assert saved.size == (60, 40)
        assert red_corner(saved) == "top-right"
        assert ORIENTATION_TAG not in saved.getexif()


def test_the_icc_profile_is_kept(tmp_path: Path) -> None:
    dest = tmp_path / "out.jpg"
    write_landscape_jpeg(decoded(tmp_path, (40, 60), None), dest)

    with Image.open(dest) as saved:
        assert saved.info.get("icc_profile") == ICC_PROFILE
