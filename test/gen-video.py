"""生成像素已知的测试视频，供「制作GIF」页的视频抽帧验证。

帧内容：左半灰阶随帧号递增（16+8i），右半固定 (200,60,60)。
这样既能验证「按时间采样对不对」（左半灰度），也能验证「区域裁剪对不对」（只取右半）。
期望值写进 vid_test.expect.json，浏览器里抓预览画布像素来比对。

用法：
  python gen-video.py                     # 64x48、16 帧 @8fps 的功能验证素材
  python gen-video.py vid_perf 1280 720 150 30   # 名字 宽 高 帧数 fps，做性能测试用
  python gen-video.py vid_ramp 1280 720 150 30 ramp   # ramp：灰度全程不重复，可直接反查帧号
"""

import json
import subprocess
import sys
from pathlib import Path

import imageio_ffmpeg
import numpy as np
from PIL import Image

HERE = Path(__file__).parent
NAME = sys.argv[1] if len(sys.argv) > 1 else "vid_test"
W = int(sys.argv[2]) if len(sys.argv) > 2 else 64
H = int(sys.argv[3]) if len(sys.argv) > 3 else 48
FRAMES = int(sys.argv[4]) if len(sys.argv) > 4 else 16
FPS = int(sys.argv[5]) if len(sys.argv) > 5 else 8
MODE = sys.argv[6] if len(sys.argv) > 6 else "cycle"
# cycle：16 帧一循环，便于核对「按时间采样对不对」
# ramp：灰度从 8 单调升到 247，每帧唯一，可由灰度直接反查帧号（量取帧误差用）
if MODE == "ramp":
    LEFT = [round(8 + i * 239 / max(1, FRAMES - 1)) for i in range(FRAMES)]
else:
    LEFT = [16 + 8 * (i % 16) for i in range(FRAMES)]
RIGHT = (200, 60, 60)
OUT = HERE / f"{NAME}.mp4"
TMP = HERE / f"{NAME}_frames"


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
    (HERE / f"{NAME}.expect.json").write_text(json.dumps(expect, indent=2), encoding="utf-8")

    probe = subprocess.run(
        [ff, "-i", str(OUT)], capture_output=True, text=True
    ).stderr
    print(OUT.name, OUT.stat().st_size, "bytes")
    print("\n".join(l.strip() for l in probe.splitlines() if "Duration" in l or "Stream" in l))
    print("left gray:", LEFT)


if __name__ == "__main__":
    main()
