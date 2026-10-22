"""生成像素已知的测试视频，供「制作GIF」页的视频抽帧验证。

帧内容：左半灰阶随帧号递增（16+8i），右半固定 (200,60,60)。
这样既能验证「按时间采样对不对」（左半灰度），也能验证「区域裁剪对不对」（只取右半）。
期望值写进 vid_test.expect.json，浏览器里抓预览画布像素来比对。
"""

import json
import subprocess
from pathlib import Path

import imageio_ffmpeg
import numpy as np
from PIL import Image

HERE = Path(__file__).parent
FRAMES = 16
FPS = 8
W, H = 64, 48
LEFT = [16 + 8 * i for i in range(FRAMES)]
RIGHT = (200, 60, 60)
OUT = HERE / "vid_test.mp4"
TMP = HERE / "vid_frames"


def main():
    TMP.mkdir(exist_ok=True)
    for i in range(FRAMES):
        a = np.zeros((H, W, 3), np.uint8)
        a[:, : W // 2] = LEFT[i]
        a[:, W // 2 :] = RIGHT
        Image.fromarray(a).save(TMP / f"f{i:02d}.png")

    ff = imageio_ffmpeg.get_ffmpeg_exe()
    cmd = [
        ff, "-y", "-loglevel", "error",
        "-framerate", str(FPS), "-i", str(TMP / "f%02d.png"),
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "12",
        "-movflags", "+faststart", str(OUT),
    ]
    subprocess.run(cmd, check=True)

    expect = {
        "file": OUT.name,
        "frames": FRAMES,
        "fps": FPS,
        "width": W,
        "height": H,
        "duration": FRAMES / FPS,
        "leftGray": LEFT,
        "rightColor": list(RIGHT),
        # 4:2:0 色度子采样会把左右交界糊掉，只比内部
        "leftSample": [4, 4, W // 2 - 4, H - 4],
        "rightSample": [W // 2 + 4, 4, W - 4, H - 4],
    }
    (HERE / "vid_test.expect.json").write_text(json.dumps(expect, indent=2), encoding="utf-8")

    probe = subprocess.run(
        [ff, "-i", str(OUT)], capture_output=True, text=True
    ).stderr
    print(OUT.name, OUT.stat().st_size, "bytes")
    print("\n".join(l.strip() for l in probe.splitlines() if "Duration" in l or "Stream" in l))
    print("left gray:", LEFT)


if __name__ == "__main__":
    main()
