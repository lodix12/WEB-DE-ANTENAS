#!/usr/bin/env python3
"""Deterministic high-resolution PWA icon generator for Redes Moviles España.

Matches the visual identity of `public/favicon.svg` using 4x+ supersampling
(2048x2048 master canvas downsampled with Lanczos resampling) to produce
ultra-crisp circular arcs, round stroke caps, and anti-aliased edges:
  - public/icons/pwa-192x192.png          (192x192 RGBA, "purpose": "any")
  - public/icons/pwa-512x512.png          (512x512 RGBA, "purpose": "any")
  - public/icons/pwa-maskable-192x192.png (192x192 RGB opaque, "purpose": "maskable")
  - public/icons/pwa-maskable-512x512.png (512x512 RGB opaque, "purpose": "maskable")
  - public/icons/apple-touch-icon.png     (180x180 RGB opaque, iOS/iPadOS home screen)
"""

from __future__ import annotations

import math
from pathlib import Path
from PIL import Image, ImageDraw

# Exact color palette from public/favicon.svg
BG_DARK_SLATE = (15, 23, 42, 255)      # #0F172A
BORDER_SLATE = (30, 41, 59, 255)       # #1E293B
OUTER_ARC_SKY = (56, 189, 248, 255)    # #38BDF8
INNER_ARC_BLUE = (14, 165, 233, 255)   # #0EA5E9
NODE_WHITE = (248, 250, 252, 255)      # #F8FAFC
TRANSPARENT = (0, 0, 0, 0)

# 2048x2048 gives 4x supersampling for 512x512 and >10x for 192x192 / 180x180
MASTER_SIZE = 2048
ARC_STEPS = 320


def draw_round_cap_circle(
    draw: ImageDraw.ImageDraw, cx: float, cy: float, radius: float, fill: tuple[int, int, int, int]
) -> None:
    draw.ellipse((cx - radius, cy - radius, cx + radius, cy + radius), fill=fill)


def draw_round_line(
    draw: ImageDraw.ImageDraw,
    x1: float,
    y1: float,
    x2: float,
    y2: float,
    width: float,
    fill: tuple[int, int, int, int],
) -> None:
    """Draws an exact thick line segment with round stroke caps."""
    dx = x2 - x1
    dy = y2 - y1
    length = math.hypot(dx, dy)
    half_w = width / 2.0

    if length > 1e-6:
        nx = -dy / length * half_w
        ny = dx / length * half_w
        poly = [
            (x1 + nx, y1 + ny),
            (x2 + nx, y2 + ny),
            (x2 - nx, y2 - ny),
            (x1 - nx, y1 - ny),
        ]
        draw.polygon(poly, fill=fill)

    draw_round_cap_circle(draw, x1, y1, half_w, fill)
    draw_round_cap_circle(draw, x2, y2, half_w, fill)


def draw_svg_vertical_chord_arc(
    draw: ImageDraw.ImageDraw,
    x_end: float,
    y_start: float,
    y_end: float,
    radius: float,
    stroke_width: float,
    side: str,
    fill: tuple[int, int, int, int],
) -> None:
    """Draws an exact circular arc with round stroke caps matching favicon.svg paths."""
    cy = 0.5 * (y_start + y_end)
    half_chord = 0.5 * abs(y_end - y_start)
    dx_center = math.sqrt(max(0.0, radius * radius - half_chord * half_chord))

    if side == "left":
        # Sweeps clockwise from bottom-left (y_start > y_end) through 180 deg to top-left
        cx = x_end + dx_center
        theta_start = math.atan2(y_start - cy, x_end - cx)
        theta_end = math.atan2(y_end - cy, x_end - cx)
        if theta_end < theta_start:
            theta_end += 2.0 * math.pi
    elif side == "right":
        # Sweeps clockwise from top-right (y_start < y_end) through 0 deg to bottom-right
        cx = x_end - dx_center
        theta_start = math.atan2(y_start - cy, x_end - cx)
        theta_end = math.atan2(y_end - cy, x_end - cx)
        if theta_end < theta_start:
            theta_end += 2.0 * math.pi
    else:
        raise ValueError(f"Unsupported side: {side}")

    half_w = stroke_width / 2.0
    r_outer = radius + half_w
    r_inner = max(0.0, radius - half_w)

    outer_pts: list[tuple[float, float]] = []
    inner_pts: list[tuple[float, float]] = []
    for i in range(ARC_STEPS + 1):
        t = theta_start + (theta_end - theta_start) * (i / ARC_STEPS)
        cos_t = math.cos(t)
        sin_t = math.sin(t)
        outer_pts.append((cx + r_outer * cos_t, cy + r_outer * sin_t))
        inner_pts.append((cx + r_inner * cos_t, cy + r_inner * sin_t))

    inner_pts.reverse()
    draw.polygon(outer_pts + inner_pts, fill=fill)

    # Round stroke caps at exact arc endpoints
    draw_round_cap_circle(draw, x_end, y_start, half_w, fill)
    draw_round_cap_circle(draw, x_end, y_end, half_w, fill)


def draw_antenna_artwork(
    draw: ImageDraw.ImageDraw, canvas_size: int, artwork_scale: float
) -> None:
    """Renders the favicon.svg radio-tower artwork scaled around the canvas center."""

    def tx(svg_x: float) -> float:
        return (((svg_x - 16.0) * artwork_scale) + 16.0) / 32.0 * canvas_size

    def ty(svg_y: float) -> float:
        return (((svg_y - 16.0) * artwork_scale) + 16.0) / 32.0 * canvas_size

    def ts(svg_len: float) -> float:
        return (svg_len * artwork_scale) / 32.0 * canvas_size

    stroke_w = ts(2.0)

    # Outer radio arcs (#38BDF8): M9.2 21.6a9.6 9.6 0 0 1 0-13.6 and M22.8 8a9.6 9.6 0 0 1 0 13.6
    draw_svg_vertical_chord_arc(
        draw,
        x_end=tx(9.2),
        y_start=ty(21.6),
        y_end=ty(8.0),
        radius=ts(9.6),
        stroke_width=stroke_w,
        side="left",
        fill=OUTER_ARC_SKY,
    )
    draw_svg_vertical_chord_arc(
        draw,
        x_end=tx(22.8),
        y_start=ty(8.0),
        y_end=ty(21.6),
        radius=ts(9.6),
        stroke_width=stroke_w,
        side="right",
        fill=OUTER_ARC_SKY,
    )

    # Inner radio arcs (#0EA5E9): M12.2 18.6a5.4 5.4 0 0 1 0-7.6 and M19.8 11a5.4 5.4 0 0 1 0 7.6
    draw_svg_vertical_chord_arc(
        draw,
        x_end=tx(12.2),
        y_start=ty(18.6),
        y_end=ty(11.0),
        radius=ts(5.4),
        stroke_width=stroke_w,
        side="left",
        fill=INNER_ARC_BLUE,
    )
    draw_svg_vertical_chord_arc(
        draw,
        x_end=tx(19.8),
        y_start=ty(11.0),
        y_end=ty(18.6),
        radius=ts(5.4),
        stroke_width=stroke_w,
        side="right",
        fill=INNER_ARC_BLUE,
    )

    # Central transmitter node (#F8FAFC): cx="16" cy="14.8" r="2.2"
    draw_round_cap_circle(draw, tx(16.0), ty(14.8), ts(2.2), NODE_WHITE)

    # Vertical mast & base (#F8FAFC): M16 17v8.5 and M12.5 25.5h7
    draw_round_line(draw, tx(16.0), ty(17.0), tx(16.0), ty(25.5), stroke_w, NODE_WHITE)
    draw_round_line(draw, tx(12.5), ty(25.5), tx(19.5), ty(25.5), stroke_w, NODE_WHITE)


def render_any_master() -> Image.Image:
    """Renders 2048x2048 RGBA rounded-squircle master icon with subtle #1E293B inner border."""
    canvas = Image.new("RGBA", (MASTER_SIZE, MASTER_SIZE), TRANSPARENT)
    draw = ImageDraw.Draw(canvas)

    outer_radius = int(round(MASTER_SIZE * (8.0 / 32.0)))
    draw.rounded_rectangle(
        (0, 0, MASTER_SIZE - 1, MASTER_SIZE - 1),
        radius=outer_radius,
        fill=BG_DARK_SLATE,
    )

    # Subtle #1E293B inner border/depth strictly inside the rounded background
    border_inset = int(round(MASTER_SIZE * (0.65 / 32.0)))
    border_width = max(2, int(round(MASTER_SIZE * (0.65 / 32.0))))
    inner_radius = max(1, outer_radius - border_inset)
    draw.rounded_rectangle(
        (
            border_inset,
            border_inset,
            MASTER_SIZE - 1 - border_inset,
            MASTER_SIZE - 1 - border_inset,
        ),
        radius=inner_radius,
        outline=BORDER_SLATE,
        width=border_width,
    )

    draw_antenna_artwork(draw, MASTER_SIZE, artwork_scale=1.0)
    return canvas


def render_opaque_master(artwork_scale: float) -> Image.Image:
    """Renders 2048x2048 full-bleed opaque #0F172A master icon with custom safe-zone scale."""
    canvas = Image.new("RGBA", (MASTER_SIZE, MASTER_SIZE), BG_DARK_SLATE)
    draw = ImageDraw.Draw(canvas)
    draw_antenna_artwork(draw, MASTER_SIZE, artwork_scale=artwork_scale)
    return canvas.convert("RGB")


def verify_maskable_safe_zone(img: Image.Image, max_diameter_ratio: float = 0.70) -> None:
    """Verifies all non-background pixels stay strictly inside the central 70% diameter circle."""
    width, height = img.size
    cx = (width - 1) / 2.0
    cy = (height - 1) / 2.0
    max_allowed_r = (max_diameter_ratio / 2.0) * width
    bg_rgb = BG_DARK_SLATE[:3]
    px = img.load()

    max_observed_r = 0.0
    for y in range(height):
        for x in range(width):
            if px[x, y][:3] != bg_rgb:
                r = math.hypot(x - cx, y - cy)
                if r > max_observed_r:
                    max_observed_r = r

    if max_observed_r > max_allowed_r:
        raise AssertionError(
            f"Maskable icon artwork exceeds {max_diameter_ratio * 100:.0f}% safe zone: "
            f"observed diameter {(2.0 * max_observed_r / width) * 100:.1f}%"
        )


def save_downsampled(master: Image.Image, target_size: int, output_path: Path) -> None:
    resized = master.resize((target_size, target_size), resample=Image.Resampling.LANCZOS)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    resized.save(output_path, format="PNG", optimize=True)


def main() -> None:
    repo_root = Path(__file__).resolve().parent.parent
    icons_dir = repo_root / "public" / "icons"
    icons_dir.mkdir(parents=True, exist_ok=True)

    # 1. "purpose": "any" icons (transparent corners + rounded squircle + #1E293B inner depth)
    any_master = render_any_master()
    for size in (192, 512):
        out_path = icons_dir / f"pwa-{size}x{size}.png"
        save_downsampled(any_master, size, out_path)

    # 2. "purpose": "maskable" icons (opaque full-bleed #0F172A, artwork inside <=70% safe zone)
    # Scale 0.80 yields ~57.5% max artwork diameter, comfortably inside the 70% safe zone.
    maskable_master = render_opaque_master(artwork_scale=0.80)
    for size in (192, 512):
        out_path = icons_dir / f"pwa-maskable-{size}x{size}.png"
        save_downsampled(maskable_master, size, out_path)
        with Image.open(out_path) as check_img:
            verify_maskable_safe_zone(check_img, max_diameter_ratio=0.70)

    # 3. iOS / iPadOS home-screen icon (180x180 opaque full-bleed #0F172A with comfortable padding)
    apple_master = render_opaque_master(artwork_scale=0.88)
    save_downsampled(apple_master, 180, icons_dir / "apple-touch-icon.png")

    expected = [
        ("pwa-192x192.png", (192, 192), "RGBA"),
        ("pwa-512x512.png", (512, 512), "RGBA"),
        ("pwa-maskable-192x192.png", (192, 192), "RGB"),
        ("pwa-maskable-512x512.png", (512, 512), "RGB"),
        ("apple-touch-icon.png", (180, 180), "RGB"),
    ]
    for filename, expected_size, expected_mode in expected:
        file_path = icons_dir / filename
        assert file_path.is_file() and file_path.stat().st_size > 0, f"Missing/empty {file_path}"
        with Image.open(file_path) as img:
            assert img.size == expected_size, f"{filename}: expected {expected_size}, got {img.size}"
            assert img.mode == expected_mode, f"{filename}: expected {expected_mode}, got {img.mode}"
        print(
            f"Generated {file_path.relative_to(repo_root)} "
            f"({expected_size[0]}x{expected_size[1]} {expected_mode}, {file_path.stat().st_size} bytes)"
        )


if __name__ == "__main__":
    main()
