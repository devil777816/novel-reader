# -*- coding: utf-8 -*-
"""生成 App 图标（主屏幕 / apple-touch-icon）。

为什么要有这个脚本：
图标原来是手绘的一张棕色图，和现在的主题色（青绿 #2f7d70）对不上。
这里用应用自身的配色程序化生成，以后改配色重新跑一次即可，不用再找图。

图形：一本摊开的书 + 一枚金色书签带，青绿渐变底。
iOS 会自己加圆角遮罩，所以这里铺满整个方形。
"""
import os
import numpy as np
from PIL import Image, ImageDraw, ImageFilter

OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'icons')

# ---- 应用配色（与 css/style.css 的 :root 保持一致）----
ACCENT = (0x2f, 0x7d, 0x70)        # --accent
ACCENT_LIGHT = (0x46, 0xa0, 0x8f)  # --accent-light
PAPER = (0xff, 0xfd, 0xfa)         # --bg-card
PAPER_SHADE = (0xe8, 0xe2, 0xd8)
GOLD = (0xd9, 0x9a, 0x2b)
GOLD_DARK = (0xc9, 0x86, 0x1a)     # --favorite

SS = 4                # 超采样倍数：先画大图再缩小，边缘才平滑
SIZE = 1024           # 逻辑尺寸
N = SIZE * SS


def gradient(size, c1, c2):
    """从左上到右下的线性渐变"""
    y, x = np.mgrid[0:size, 0:size].astype(np.float32)
    t = (x + y) / (2.0 * (size - 1))          # 0..1
    img = np.zeros((size, size, 3), dtype=np.float32)
    for i in range(3):
        img[:, :, i] = c1[i] * (1 - t) + c2[i] * t
    return Image.fromarray(img.astype(np.uint8), 'RGB')


def bezier(p0, p1, p2, p3, steps=40):
    """三次贝塞尔采样成折线点（Pillow 没有曲线，自己采样）。

    返回的是**逻辑坐标**（1024 那一套），由调用方用 P() 统一转换。
    千万不要在这里偷偷乘 SS —— 混用两套坐标系是上一版画出尖刺的原因。"""
    pts = []
    for i in range(steps + 1):
        t = i / steps
        u = 1 - t
        x = u**3 * p0[0] + 3 * u**2 * t * p1[0] + 3 * u * t**2 * p2[0] + t**3 * p3[0]
        y = u**3 * p0[1] + 3 * u**2 * t * p1[1] + 3 * u * t**2 * p2[1] + t**3 * p3[1]
        pts.append((x, y))
    return pts


def build():
    img = gradient(N, ACCENT_LIGHT, ACCENT)

    # 图形按 1024 的逻辑坐标设计，再由 P() 统一缩放居中。
    # 图标主体一般要占到 55%~65%，太小会显得空。
    K = 1.22
    C = 512

    def P(x, y):
        """逻辑坐标 → 最终像素坐标（含超采样 + 绕中心缩放）"""
        return ((C + (x - C) * K) * SS, (C + (y - C) * K) * SS)

    def S(pts):
        return [P(x, y) for (x, y) in pts]

    cx = 512
    spine_top = (cx, 392)
    spine_bottom = (cx, 762)
    outer_top_y = 306
    outer_bottom_y = 686
    left_x, right_x = 196, 828

    # ---- 摊开的书：左右两页 ----
    left = [P(*spine_top)]
    left += S(bezier(spine_top, (430, 340), (310, 300), (left_x, outer_top_y)))
    left += [P(left_x, outer_bottom_y)]
    left += S(bezier((left_x, outer_bottom_y), (310, 680), (430, 720), spine_bottom))
    right = [(2 * cx * SS - x, y) for (x, y) in left]   # 关于中线镜像

    # 投影：先画一层模糊的暗色，制造"浮起来"的层次
    shadow = Image.new('RGBA', (N, N), (0, 0, 0, 0))
    sd = ImageDraw.Draw(shadow)
    for pts in (left, right):
        sd.polygon([(x, y + 18 * SS) for (x, y) in pts], fill=(12, 40, 35, 110))
    shadow = shadow.filter(ImageFilter.GaussianBlur(14 * SS))
    img.paste(Image.alpha_composite(img.convert('RGBA'), shadow).convert('RGB'), (0, 0))

    d = ImageDraw.Draw(img, 'RGBA')
    for pts in (left, right):
        d.polygon(pts, fill=PAPER)

    # 书页内侧的阴影，让两页分得开
    fold = [P(*spine_top)]
    fold += S(bezier(spine_top, (500, 500), (500, 660), spine_bottom))
    fold += S(bezier(spine_bottom, (524, 660), (524, 500), spine_top))
    d.polygon(fold, fill=PAPER_SHADE)

    # ---- 金色书签带：从书缝里垂下来 ----
    rib_l, rib_r = 470, 554
    rib_top, rib_bottom = 336, 648
    notch = (rib_l + rib_r) // 2
    ribbon = [
        P(rib_l, rib_top), P(rib_r, rib_top),
        P(rib_r, rib_bottom), P(notch, rib_bottom - 46),
        P(rib_l, rib_bottom),
    ]
    # 书签带自己的投影
    rs = Image.new('RGBA', (N, N), (0, 0, 0, 0))
    ImageDraw.Draw(rs).polygon([(x, y + 6 * SS) for (x, y) in ribbon], fill=(12, 40, 35, 90))
    rs = rs.filter(ImageFilter.GaussianBlur(5 * SS))
    img.paste(Image.alpha_composite(img.convert('RGBA'), rs).convert('RGB'), (0, 0))

    d = ImageDraw.Draw(img, 'RGBA')
    d.polygon(ribbon, fill=GOLD)
    # 书签带右侧压暗一点，做出立体感
    d.polygon([P(rib_r - 16, rib_top), P(rib_r, rib_top),
               P(rib_r, rib_bottom), P(notch, rib_bottom - 46),
               P(notch, rib_bottom - 40)], fill=GOLD_DARK)

    return img


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    big = build()
    for size in (512, 192, 180, 152, 120):
        out = os.path.join(OUT_DIR, 'icon-%d.png' % size)
        big.resize((size, size), Image.LANCZOS).save(out, 'PNG', optimize=True)
        print('  %-16s %d×%d  %.1f KB' % (os.path.basename(out), size, size,
                                          os.path.getsize(out) / 1024.0))
    # 顺手生成一张预览大图，方便肉眼检查。
    # 注意放在 tools/ 而不是 icons/ —— icons/ 里的文件会随应用一起发布。
    big.resize((512, 512), Image.LANCZOS).save(
        os.path.join(os.path.dirname(os.path.abspath(__file__)), 'icon-preview.png'))
    print('已生成到 %s' % os.path.normpath(OUT_DIR))


if __name__ == '__main__':
    main()