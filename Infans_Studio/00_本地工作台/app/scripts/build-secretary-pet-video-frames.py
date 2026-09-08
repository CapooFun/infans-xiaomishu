#!/usr/bin/env python3
"""Build deterministic 30 fps RGBA frame sequences for the native Secretary pet.

The output is intentionally frame based. A separate Swift encoder turns these
premultiplied-friendly PNGs into HEVC-with-alpha movies. The generated speaking
strip is a dense identity source; the remaining legacy poses gain continuous
secondary motion without pretending that repeated pose hashes are new drawings.
"""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageFont, ImageStat


SOURCE_WIDTH = 192
SOURCE_HEIGHT = 208
VIDEO_WIDTH = 384
VIDEO_HEIGHT = 416
FPS = 30

VIDEO_SPECS = [
    {"id": "idle", "duration": 3.0, "loop": True, "sourceRow": 10, "sourceFrames": 8, "pingPong": True},
    {"id": "hover", "duration": 1.6, "loop": True, "sourceRow": 8, "sourceFrames": 6},
    {"id": "launching", "duration": 1.0, "loop": False, "sourceRow": 4, "sourceFrames": 5},
    {"id": "talking", "duration": 1.2, "loop": True, "sourceRow": None, "sourceFrames": 8},
    {"id": "dragging-right", "duration": 0.8, "loop": True, "sourceRow": 1, "sourceFrames": 8},
    {"id": "dragging-left", "duration": 0.8, "loop": True, "sourceRow": 2, "sourceFrames": 8},
]


def alpha_bbox(image: Image.Image) -> tuple[int, int, int, int] | None:
    return image.getchannel("A").getbbox()


def normalize_pose(
    pose: Image.Image,
    *,
    target_height: int,
    baseline: int,
    horizontal_center: int = SOURCE_WIDTH // 2,
) -> Image.Image:
    box = alpha_bbox(pose)
    if box is None:
        raise ValueError("empty pose")
    cropped = pose.crop(box)
    scale = min(target_height / cropped.height, (SOURCE_WIDTH - 12) / cropped.width)
    width = max(1, round(cropped.width * scale))
    height = max(1, round(cropped.height * scale))
    resized = cropped.resize((width, height), Image.Resampling.LANCZOS)
    frame = Image.new("RGBA", (SOURCE_WIDTH, SOURCE_HEIGHT), (0, 0, 0, 0))
    x = round(horizontal_center - width / 2)
    y = baseline - height
    frame.alpha_composite(resized, (x, y))
    return frame


def extract_codex_row(atlas: Image.Image, row: int, count: int) -> list[Image.Image]:
    return [
        atlas.crop(
            (
                column * SOURCE_WIDTH,
                row * SOURCE_HEIGHT,
                (column + 1) * SOURCE_WIDTH,
                (row + 1) * SOURCE_HEIGHT,
            )
        )
        for column in range(count)
    ]


def extract_strip(
    strip: Image.Image,
    count: int,
    *,
    target_height: int,
    baseline: int,
) -> list[Image.Image]:
    frames: list[Image.Image] = []
    for index in range(count):
        left = round(index * strip.width / count)
        right = round((index + 1) * strip.width / count)
        frames.append(
            normalize_pose(
                strip.crop((left, 0, right, strip.height)),
                target_height=target_height,
                baseline=baseline,
            )
        )
    return frames


def extract_subject_runs(
    strip: Image.Image,
    count: int,
    *,
    target_height: int,
    baseline: int,
) -> list[Image.Image]:
    """Split a generated strip at transparent gutters instead of equal cells."""
    alpha = strip.getchannel("A")
    active_columns = []
    for x in range(strip.width):
        column = alpha.crop((x, 0, x + 1, strip.height))
        active_columns.append(sum(value > 16 for value in column.get_flattened_data()) >= 3)
    runs: list[tuple[int, int]] = []
    start: int | None = None
    for index, active in enumerate(active_columns + [False]):
        if active and start is None:
            start = index
        elif not active and start is not None:
            if index - start >= 24:
                runs.append((start, index))
            start = None
    if len(runs) != count:
        return extract_strip(
            strip,
            count,
            target_height=target_height,
            baseline=baseline,
        )
    return [
        normalize_pose(
            strip.crop((max(0, left - 3), 0, min(strip.width, right + 3), strip.height)),
            target_height=target_height,
            baseline=baseline,
        )
        for left, right in runs
    ]


def transform_frame(
    frame: Image.Image,
    *,
    scale: float = 1.0,
    shift_x: float = 0.0,
    shift_y: float = 0.0,
    squash: float = 0.0,
) -> Image.Image:
    center_x = SOURCE_WIDTH / 2
    # Reserve a small transparent safety margin for Retina interpolation and
    # the larger secondary motions. Pillow transform coefficients use inverse
    # mapping; a negative requested y shift moves visible pixels upward.
    safe_shift_y = shift_y
    scale *= 0.95
    center_y = SOURCE_HEIGHT * 0.62
    scale_x = scale * (1.0 + squash)
    scale_y = scale * (1.0 - squash)
    coefficients = (
        1.0 / scale_x,
        0.0,
        center_x - (center_x + shift_x) / scale_x,
        0.0,
        1.0 / scale_y,
        center_y - (center_y + safe_shift_y) / scale_y,
    )
    return frame.transform(
        frame.size,
        Image.Transform.AFFINE,
        coefficients,
        resample=Image.Resampling.BICUBIC,
    )


def smoothstep(value: float) -> float:
    value = max(0.0, min(1.0, value))
    return value * value * (3.0 - 2.0 * value)


def secondary_motion(frame: Image.Image, phase: float, state: str) -> Image.Image:
    angle = 2 * math.pi * phase
    if state == "idle":
        # A short visible breathing beat followed by quiet stillness.
        action = smoothstep(min(1.0, phase / 0.46)) * (1 - smoothstep(max(0.0, (phase - 0.46) / 0.24)))
        scale = 1 + 0.010 * math.sin(angle * 2.1) * action
        shift_y = 1.4 * (0.5 - 0.5 * math.cos(angle * 2.1)) * action
        shift_x = 0.8 * math.sin(angle * 1.1) * action
        squash = 0.0025 * math.sin(angle * 2.1) * action
    elif state == "hover":
        scale = 1 + 0.014 * math.sin(angle)
        shift_y = 2.2 * (0.5 - 0.5 * math.cos(angle))
        shift_x = 1.5 * math.sin(angle)
        squash = 0.004 * math.sin(angle)
    elif state == "launching":
        hop = math.sin(math.pi * min(1.0, phase))
        scale = 1 + 0.020 * hop
        shift_y = -3.5 * hop
        shift_x = 1.2 * math.sin(2 * math.pi * phase)
        squash = 0.012 * math.sin(2 * math.pi * phase)
    elif state == "talking":
        scale = 1 + 0.016 * math.sin(angle - 0.5)
        shift_y = 2.4 * (0.5 - 0.5 * math.cos(angle * 2))
        shift_x = 2.1 * math.sin(angle)
        squash = 0.005 * math.sin(angle * 2)
    else:
        scale = 1 + 0.010 * math.sin(angle * 2)
        shift_y = 2.8 * (0.5 - 0.5 * math.cos(angle * 2))
        shift_x = 1.0 * math.sin(angle)
        squash = 0.006 * math.sin(angle * 2)
    return transform_frame(
        frame,
        scale=scale,
        shift_x=shift_x,
        shift_y=shift_y,
        squash=squash,
    )


def select_pose(keyframes: list[Image.Image], phase: float, *, loop: bool) -> Image.Image:
    if loop:
        index = int(phase * len(keyframes)) % len(keyframes)
    else:
        index = min(len(keyframes) - 1, int(phase * len(keyframes)))
    return keyframes[index]


def build_frames(keyframes: list[Image.Image], spec: dict[str, object]) -> list[Image.Image]:
    if spec.get("pingPong"):
        keyframes = keyframes + keyframes[-2:0:-1]
    count = round(float(spec["duration"]) * FPS)
    loop = bool(spec["loop"])
    result: list[Image.Image] = []
    for output_index in range(count):
        denominator = count if loop else max(1, count - 1)
        phase = output_index / denominator
        pose = select_pose(keyframes, phase, loop=loop)
        result.append(pose.resize((VIDEO_WIDTH, VIDEO_HEIGHT), Image.Resampling.LANCZOS))
    return result


def checkerboard(size: tuple[int, int], tile: int = 20) -> Image.Image:
    result = Image.new("RGBA", size, "white")
    draw = ImageDraw.Draw(result)
    for y in range(0, size[1], tile):
        for x in range(0, size[0], tile):
            color = (224, 229, 228, 255) if (x // tile + y // tile) % 2 else (249, 250, 250, 255)
            draw.rectangle((x, y, x + tile - 1, y + tile - 1), fill=color)
    return result


def render_contact_sheet(rows: dict[str, list[Image.Image]], output: Path) -> None:
    thumb_width, thumb_height = 192, 208
    columns = 8
    label_width = 150
    row_height = thumb_height
    sheet = checkerboard((label_width + columns * thumb_width, len(VIDEO_SPECS) * row_height), 16)
    draw = ImageDraw.Draw(sheet)
    font = ImageFont.load_default()
    for row, spec in enumerate(VIDEO_SPECS):
        state = str(spec["id"])
        frames = rows[state]
        row_y = row * row_height
        draw.rectangle((0, row_y, label_width - 1, row_y + row_height - 1), fill=(10, 25, 29, 255))
        draw.text((12, row_y + 14), state, fill=(221, 201, 164, 255), font=font)
        draw.text((12, row_y + 34), f"{len(frames)} @ {FPS}fps", fill=(151, 170, 166, 255), font=font)
        sample_indices = [round(i * (len(frames) - 1) / (columns - 1)) for i in range(columns)]
        for column, frame_index in enumerate(sample_indices):
            thumb = frames[frame_index].resize((thumb_width, thumb_height), Image.Resampling.LANCZOS)
            sheet.alpha_composite(thumb, (label_width + column * thumb_width, row_y))
            draw.rectangle(
                (label_width + column * thumb_width, row_y, label_width + (column + 1) * thumb_width - 1, row_y + row_height - 1),
                outline=(70, 123, 111, 170),
                width=1,
            )
    output.parent.mkdir(parents=True, exist_ok=True)
    sheet.convert("RGB").save(output, quality=94)


def frame_metrics(frames: list[Image.Image]) -> dict[str, object]:
    boxes = [alpha_bbox(frame) for frame in frames]
    if any(box is None for box in boxes):
        raise ValueError("empty video frame")
    concrete_boxes = [box for box in boxes if box is not None]
    differences: list[float] = []
    for previous, current in zip(frames, frames[1:]):
        delta = ImageChops.difference(previous, current).convert("RGB")
        differences.append(sum(ImageStat.Stat(delta).mean) / 3)
    return {
        "frameCount": len(frames),
        "alphaBounds": {
            "minX": min(box[0] for box in concrete_boxes),
            "minY": min(box[1] for box in concrete_boxes),
            "maxX": max(box[2] for box in concrete_boxes),
            "maxY": max(box[3] for box in concrete_boxes),
        },
        "baselineRange": [min(box[3] for box in concrete_boxes), max(box[3] for box in concrete_boxes)],
        "clippedFrames": sum(
            1
            for box in concrete_boxes
            if box[0] == 0 or box[1] == 0 or box[2] == VIDEO_WIDTH or box[3] == VIDEO_HEIGHT
        ),
        "adjacentDifference": {
            "min": round(min(differences), 3),
            "mean": round(sum(differences) / len(differences), 3),
            "max": round(max(differences), 3),
        },
    }


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
    talking_keyframes = extract_subject_runs(
        Image.open(args.talking).convert("RGBA"),
        int(next(spec["sourceFrames"] for spec in VIDEO_SPECS if spec["id"] == "talking")),
        target_height=target_height,
        baseline=baseline,
    )

    rows: dict[str, list[Image.Image]] = {}
    manifest_clips: list[dict[str, object]] = []
    for spec in VIDEO_SPECS:
        state = str(spec["id"])
        if state == "talking":
            keyframes = talking_keyframes
            source_kind = "authored-yinyue-look-strip"
        else:
            keyframes = extract_codex_row(identity, int(spec["sourceRow"]), int(spec["sourceFrames"]))
            source_kind = "codex-v2-authored-poses"
        frames = build_frames(keyframes, spec)
        state_dir = args.output_dir / state
        state_dir.mkdir(parents=True, exist_ok=True)
        for index, frame in enumerate(frames):
            frame.save(state_dir / f"{index:04d}.png", optimize=True)
        rows[state] = frames
        manifest_clips.append(
            {
                "id": state,
                "file": f"{state}.mov",
                "fps": FPS,
                "frameCount": len(frames),
                "loop": bool(spec["loop"]),
                "source": {"kind": source_kind, "keyframes": len(keyframes)},
            }
        )

    manifest = {
        "version": 1,
        "canvasWidth": VIDEO_WIDTH,
        "canvasHeight": VIDEO_HEIGHT,
        "fps": FPS,
        "clips": manifest_clips,
    }
    args.output_dir.mkdir(parents=True, exist_ok=True)
    (args.output_dir / "video-manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    render_contact_sheet(rows, args.qa_dir / "video-contact-sheet.png")
    summary = {
        "ok": True,
        "canvas": [VIDEO_WIDTH, VIDEO_HEIGHT],
        "fps": FPS,
        "states": {state: frame_metrics(frames) for state, frames in rows.items()},
        "contactSheet": str(args.qa_dir / "video-contact-sheet.png"),
    }
    (args.qa_dir / "video-frame-summary.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(json.dumps(summary, ensure_ascii=False))


if __name__ == "__main__":
    main()
