# scripts/make-icon.py
# （可选）生成 build/icon.ico —— 一个简单的“书本”占位图标。
# 用法：python scripts/make-icon.py
# 需要 Pillow：pip install Pillow

import os
from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIR = os.path.join(ROOT, "build")
OUT = os.path.join(OUT_DIR, "icon.ico")

SIZE = 256
img = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
d = ImageDraw.Draw(img)

# 背景圆角方块（主题蓝）
bg = (79, 124, 255, 255)
r = 48
d.rounded_rectangle([0, 0, SIZE - 1, SIZE - 1], radius=r, fill=bg)

# 打开的书本（两页白色）
page = (255, 255, 255, 255)
spine_x = SIZE // 2
d.rounded_rectangle([spine_x - 52, 56, spine_x, 200], radius=10, fill=page)
d.rounded_rectangle([spine_x, 56, spine_x + 52, 200], radius=10, fill=page)

# 左侧书脊阴影线（简单装饰）
d.line([spine_x - 1, 60, spine_x - 1, 196], fill=(200, 210, 235, 255), width=3)
d.line([spine_x + 1, 60, spine_x + 1, 196], fill=(200, 210, 235, 255), width=3)

os.makedirs(OUT_DIR, exist_ok=True)
img.save(OUT, format="ICO", sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
print("已生成图标：", OUT)
