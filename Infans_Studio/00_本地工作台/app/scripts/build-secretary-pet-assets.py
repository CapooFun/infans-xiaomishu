#!/usr/bin/env python3
"""Build the native Secretary pet atlas and visual QA artifacts.

This script is deterministic: it combines the approved Codex identity atlas with
the separately generated speaking keyframes, normalizes every pose to the same
192x208 cell, and creates additional in-between frames for smoother playback.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


CELL_WIDTH = 192
CELL_HEIGHT = 208
COLUMNS = 16


ANIMATIONS = [
    {
        "id": "idle",
        "row": 0,
        "frameCount": 16,
        "durationsMs": [180, 90, 90, 90, 90, 90, 90, 120, 90, 90, 90, 90, 90, 90, 180, 900],
        "loop": True,
        "fallback": "idle",
        "pingPong": True,
        "source": {"kind": "codex-look-row", "row": 10, "frames": 8},
    },
    {
        "id": "hover",
        "row": 1,
        "frameCount": 12,
        "durationsMs": [85] * 11 + [260],
        "loop": True,
        "fallback": "idle",
        "source": {"kind": "codex-row", "row": 8, "frames": 6},
    },
    {
        "id": "launching",
        "row": 2,
        "frameCount": 16,
        "durationsMs": [62] * 16,
        "loop": False,
        "fallback": "idle",
        "source": {"kind": "codex-row", "row": 4, "frames": 5},
    },
    {
        "id": "talking",
        "row": 3,
        "frameCount": 16,
        "durationsMs": [77] * 16,
        "loop": True,
        "fallback": "idle",
        "source": {"kind": "generated-strip", "frames": 8},
    },
    {
        "id": "dragging-right",
        "row": 4,
        "frameCount": 12,
        "durationsMs": [67] * 11 + [120],
        "loop": True,
        "fallback": "idle",
        "source": {"kind": "codex-row", "row": 1, "frames": 8},
    },
    {
        "id": "dragging-left",
        "row": 5,
        "frameCount": 12,
        "durationsMs": [67] * 11 + [120],
        "loop": True,
        "fallback": "idle",
        "source": {"kind": "codex-row", "row": 2, "frames": 8},
    },
]


def alpha_bbox(image: Image.Image) -> tuple[int, int, int, int] | None:
    return image.getchannel("A").getbbox()


def is_clipped(image: Image.Image) -> bool:
    box = alpha_bbox(image)
    return bool(
        box
        and (box[0] == 0 or box[1] == 0 or box[2] == CELL_WIDTH or box[3] == CELL_HEIGHT)
    )


def extract_codex_row(atlas: Image.Image, row: int, count: int) -> list[Image.Image]:
    return [
        atlas.crop((column * CELL_WIDTH, row * CELL_HEIGHT, (column + 1) * CELL_WIDTH, (row + 1) * CELL_HEIGHT))
        for column in range(count)
    ]


def normalize_pose(
    pose: Image.Image,
    *,
    target_height: int,
    baseline: int,
    horizontal_center: int = CELL_WIDTH // 2,
) -> Image.Image:
    box = alpha_bbox(pose)
    if box is None:
        raise ValueError("empty pose")
    cropped = pose.crop(box)
    scale = min(target_height / cropped.height, (CELL_WIDTH - 12) / cropped.width)
    width = max(1, round(cropped.width * scale))
    height = max(1, round(cropped.height * scale))
    resized = cropped.resize((width, height), Image.Resampling.LANCZOS)
    frame = Image.new("RGBA", (CELL_WIDTH, CELL_HEIGHT), (0, 0, 0, 0))
    x = round(horizontal_center - width / 2)
    y = baseline - height
    frame.alpha_composite(resized, (x, y))
    return frame


def extract_generated_strip(strip: Image.Image, count: int, target_height: int, baseline: int) -> list[Image.Image]:
    frames: list[Image.Image] = []
    for index in range(count):
        left = round(index * strip.width / count)
        right = round((index + 1) * strip.width / count)
        slot = strip.crop((left, 0, right, strip.height))
        frames.append(normalize_pose(slot, target_height=target_height, baseline=baseline))
    return frames


def motion_variant(frame: Image.Image, phase: int, total: int, *, amplitude: float) -> Image.Image:
    """Add clean sub-pixel breathing motion without cross-fading two poses."""
    if amplitude <= 0:
        return frame.copy()
    angle = 2 * math.pi * phase / total
    scale = 1 + amplitude * math.sin(angle - math.pi / 3)
    shift_x = 0.38 * math.sin(angle * 1.7 + 0.4)
    shift_y = 0.72 * (0.5 - 0.5 * math.cos(angle))
    center_x = CELL_WIDTH / 2
    center_y = CELL_HEIGHT / 2
    inverse = 1 / scale
    coefficients = (
        inverse,
        0,
        center_x - (center_x + shift_x) * inverse,
        0,
        inverse,
        center_y - (center_y + shift_y) * inverse,
    )
    return frame.transform(
        frame.size,
        Image.Transform.AFFINE,
        coefficients,
        resample=Image.Resampling.BICUBIC,
    )


def resample_loop(
    keyframes: list[Image.Image],
    count: int,
    *,
    close_loop: bool = True,
    amplitude: float = 0.003,
) -> list[Image.Image]:
    if len(keyframes) < 2:
        raise ValueError("at least two keyframes are required")
    result: list[Image.Image] = []
    for output_index in range(count):
        denominator = count if close_loop else max(1, count - 1)
        source_position = output_index * (len(keyframes) if close_loop else len(keyframes) - 1) / denominator
        source_index = min(int(source_position), len(keyframes) - 1)
        result.append(motion_variant(keyframes[source_index], output_index, count, amplitude=amplitude))
    return result


def checkerboard(size: tuple[int, int], tile: int = 12) -> Image.Image:
    image = Image.new("RGBA", size, "white")
    draw = ImageDraw.Draw(image)
    for y in range(0, size[1], tile):
        for x in range(0, size[0], tile):
            color = (226, 230, 229, 255) if (x // tile + y // tile) % 2 else (249, 250, 250, 255)
            draw.rectangle((x, y, x + tile - 1, y + tile - 1), fill=color)
    return image


def render_contact_sheet(rows: dict[str, list[Image.Image]], output: Path) -> None:
    label_width = 150
    sheet = checkerboard((label_width + COLUMNS * CELL_WIDTH, len(ANIMATIONS) * CELL_HEIGHT), 16)
    draw = ImageDraw.Draw(sheet)
    font = ImageFont.load_default()
    for animation in ANIMATIONS:
        row_y = animation["row"] * CELL_HEIGHT
        draw.rectangle((0, row_y, label_width - 1, row_y + CELL_HEIGHT - 1), fill=(10, 25, 29, 255))
        draw.text((12, row_y + 14), animation["id"], fill=(221, 201, 164, 255), font=font)
        draw.text((12, row_y + 34), f'{animation["frameCount"]} frames', fill=(151, 170, 166, 255), font=font)
        for index, frame in enumerate(rows[animation["id"]]):
            sheet.alpha_composite(frame, (label_width + index * CELL_WIDTH, row_y))
            draw.rectangle(
                (label_width + index * CELL_WIDTH, row_y, label_width + (index + 1) * CELL_WIDTH - 1, row_y + CELL_HEIGHT - 1),
                outline=(70, 123, 111, 170),
                width=1,
            )
    output.parent.mkdir(parents=True, exist_ok=True)
    sheet.convert("RGB").save(output, quality=92)


def render_previews(rows: dict[str, list[Image.Image]], output_dir: Path) -> None:
    output_dir.mkdir(parents=True, exist_ok=True)
    for animation in ANIMATIONS:
        backgrounds: list[Image.Image] = []
        for frame in rows[animation["id"]]:
            background = checkerboard((CELL_WIDTH, CELL_HEIGHT), 12)
            background.alpha_composite(frame)
            backgrounds.append(background.convert("P", palette=Image.Palette.ADAPTIVE, colors=255))
        durations = animation["durationsMs"]
        backgrounds[0].save(
            output_dir / f'{animation["id"]}.gif',
            save_all=True,
            append_images=backgrounds[1:],
            duration=durations,
            loop=0 if animation["loop"] else 1,
            disposal=2,
        )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--identity", type=Path, required=True)
    parser.add_argument("--talking", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--qa-dir", type=Path, required=True)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    identity = Image.open(args.identity).convert("RGBA")
    if identity.size != (1536, 2288):
        raise ValueError(f"unexpected identity atlas size: {identity.size}")

    neutral = extract_codex_row(identity, 0, 1)[0]
    neutral_box = alpha_bbox(neutral)
    if neutral_box is None:
        raise ValueError("neutral identity frame is empty")
    target_height = neutral_box[3] - neutral_box[1]
    baseline = neutral_box[3]

    generated_talking = extract_generated_strip(
        Image.open(args.talking).convert("RGBA"),
        8,
        target_height=target_height,
        baseline=baseline,
    )

    rows: dict[str, list[Image.Image]] = {}
    for animation in ANIMATIONS:
        source = animation["source"]
        if source["kind"] == "generated-strip":
            keyframes = generated_talking
        else:
            keyframes = extract_codex_row(identity, source["row"], source["frames"])
        if animation.get("pingPong"):
            keyframes = keyframes + keyframes[-2:0:-1]
        rows[animation["id"]] = resample_loop(
            keyframes,
            animation["frameCount"],
            close_loop=animation["id"] != "launching",
            amplitude=0,
        )

    atlas = Image.new("RGBA", (COLUMNS * CELL_WIDTH, len(ANIMATIONS) * CELL_HEIGHT), (0, 0, 0, 0))
    for animation in ANIMATIONS:
        for column, frame in enumerate(rows[animation["id"]]):
            atlas.alpha_composite(frame, (column * CELL_WIDTH, animation["row"] * CELL_HEIGHT))

    args.output_dir.mkdir(parents=True, exist_ok=True)
    atlas_path = args.output_dir / "secretary-pet-atlas.png"
    atlas.save(atlas_path, optimize=True)

    manifest = {
        "version": 1,
        "atlas": atlas_path.name,
        "cellWidth": CELL_WIDTH,
        "cellHeight": CELL_HEIGHT,
        "columns": COLUMNS,
        "rows": len(ANIMATIONS),
        "width": atlas.width,
        "height": atlas.height,
        "animations": ANIMATIONS,
    }
    (args.output_dir / "animation-manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )

    render_contact_sheet(rows, args.qa_dir / "contact-sheet.png")
    render_previews(rows, args.qa_dir / "previews")

    summary = {
        "ok": True,
        "atlas": str(atlas_path),
        "size": [atlas.width, atlas.height],
        "frameCounts": {animation["id"]: animation["frameCount"] for animation in ANIMATIONS},
        "qa": {
            animation["id"]: {
                "uniqueFrames": len({hashlib.sha256(frame.tobytes()).hexdigest() for frame in rows[animation["id"]]}),
                "baselineRange": [
                    min(alpha_bbox(frame)[3] for frame in rows[animation["id"]]),
                    max(alpha_bbox(frame)[3] for frame in rows[animation["id"]]),
                ],
                "clippedFrames": sum(1 for frame in rows[animation["id"]] if is_clipped(frame)),
            }
            for animation in ANIMATIONS
        },
        "contactSheet": str(args.qa_dir / "contact-sheet.png"),
        "previews": str(args.qa_dir / "previews"),
    }
    (args.qa_dir / "asset-summary.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(json.dumps(summary, ensure_ascii=False))


if __name__ == "__main__":
    main()
