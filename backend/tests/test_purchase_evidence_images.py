from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw

from app.services.purchases import _slice_image_for_pdf


def _write_test_png(path: Path, *, width: int, height: int) -> None:
    img = Image.new("RGB", (width, height), "white")
    draw = ImageDraw.Draw(img)
    # Black border -> corner color is deterministic for background sampling in slicer.
    draw.rectangle([0, 0, width - 1, height - 1], outline="black", width=2)
    # Add a few blocks so each slice contains non-background pixels.
    for y in range(80, height, 420):
        draw.rectangle([12, y, width - 12, min(height - 12, y + 28)], fill="black")
    img.save(path, format="PNG")


def test_slice_image_for_pdf_keeps_short_images(tmp_path: Path) -> None:
    src = tmp_path / "short.png"
    _write_test_png(src, width=680, height=500)
    out_dir = tmp_path / "out"

    parts = _slice_image_for_pdf(src_path=src, out_dir=out_dir, stem="short")

    assert parts == [src]
    assert not out_dir.exists()


def test_slice_image_for_pdf_splits_tall_images(tmp_path: Path) -> None:
    src = tmp_path / "tall.png"
    _write_test_png(src, width=680, height=2000)
    out_dir = tmp_path / "out"

    parts = _slice_image_for_pdf(src_path=src, out_dir=out_dir, stem="tall")

    assert len(parts) >= 2
    assert all(p.exists() for p in parts)
    assert all(p.parent == out_dir for p in parts)

    # Ensure slices are not taller than the original and keep the original width.
    for p in parts:
        with Image.open(p) as im:
            assert im.width == 680
            assert 1 <= im.height <= 2000

