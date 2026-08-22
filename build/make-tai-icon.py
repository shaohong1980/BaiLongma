# make-tai-icon.py —— 生成「泰卦」图标源图 + 全部图标变体
# 泰卦（地天泰）：下卦乾（三阳爻 ━━━）、上卦坤（三阴爻 ━ ━），即「下面全阳、上边全阴」。
# 天地交泰 · 阴阳相济。颜色主题：上阴（深靛蓝）→ 下阳（暖金）。
from pathlib import Path
from PIL import Image, ImageDraw, ImageFilter, ImageFont

BUILD_DIR = Path(__file__).resolve().parent
S = 1024

def hex_color(h):
    h = h.lstrip('#')
    return tuple(int(h[i:i+2], 16) for i in (0, 2, 4))

def vertical_gradient(size, stops):
    """stops: list of (pos0-1, (r,g,b)) —— 线性插值渐变背景。"""
    img = Image.new('RGBA', (size, size))
    px = img.load()
    for y in range(size):
        t = y / (size - 1)
        for i in range(len(stops) - 1):
            (p0, c0), (p1, c1) = stops[i], stops[i + 1]
            if p0 <= t <= p1:
                k = (t - p0) / (p1 - p0) if p1 != p0 else 0
                c = tuple(int(c0[j] + (c1[j] - c0[j]) * k) for j in range(3))
                for x in range(size):
                    px[x, y] = (c[0], c[1], c[2], 255)
                break
    return img

def draw_hexagram(img, cx=0.5, cy=0.52, line_w=0.55, line_h=0.075, gap=0.028):
    """在画布上画泰卦六爻：下三阳（实线）上三阴（断线）。
    比例基于画布短边。返回 ImageDraw。"""
    d = ImageDraw.Draw(img)
    size = min(img.size)
    cxp = img.size[0] * cx
    line_width = size * line_w
    line_height = size * line_h
    gap_height = size * gap
    yin_gap = size * 0.075          # 阴爻中间断口
    total = 6 * line_height + 5 * gap_height
    y_top = img.size[1] * cy - total / 2

    yang_color = (255, 216, 115, 255)     # 阳爻：亮金
    yin_color = (242, 234, 216, 255)      # 阴爻：暖白
    outline = (255, 255, 255, 70)

    for i in range(6):
        y0 = int(y_top + i * (line_height + gap_height))
        y1 = int(y0 + line_height)
        # i=0,1,2 底部阳爻；i=3,4,5 顶部阴爻
        if i < 3:
            box = (cxp - line_width/2, y0, cxp + line_width/2, y1)
            d.rounded_rectangle(box, radius=int(line_height/3), fill=yang_color, outline=outline, width=2)
        else:
            seg = (line_width - yin_gap) / 2
            for off in (-seg - yin_gap/2, yin_gap/2):
                box = (cxp + off, y0, cxp + off + seg, y1)
                d.rounded_rectangle(box, radius=int(line_height/3), fill=yin_color, outline=outline, width=2)
    return d

def vignette(img, strength=0.28):
    """边缘压暗，聚焦中心。"""
    size = min(img.size)
    mask = Image.new('L', (size, size), 0)
    dm = ImageDraw.Draw(mask)
    dm.ellipse((0, 0, size, size), fill=255)
    mask = mask.filter(ImageFilter.GaussianBlur(size * 0.18))
    black = Image.new('RGBA', img.size, (0, 0, 0, 255))
    dark = Image.composite(black, Image.new('RGBA', img.size, (0,0,0,0)), mask.point(lambda v: int(v * strength)))
    return Image.alpha_composite(img, dark)

def build_source():
    img = vertical_gradient(S, [
        (0.00, hex_color('#16233f')),
        (0.42, hex_color('#2e4a7a')),
        (0.58, hex_color('#a06f2e')),
        (1.00, hex_color('#f0c96a')),
    ])
    # 先压暗背景四周，再画爻线——让六爻保持明亮不被暗角吞掉
    img = vignette(img, strength=0.16)
    draw_hexagram(img)
    return img

def rounded_icon(img, size, corner=0.22, polish=True):
    """仿 make-icon.py 的圆角 + 高光 + 内描边，用于独立 PNG 输出。"""
    SS = 4
    im = img.resize((size, size), Image.LANCZOS)
    radius = max(2, int(size * corner))
    big = Image.new('L', (size*SS, size*SS), 0)
    ImageDraw.Draw(big).rounded_rectangle((0,0,size*SS-1,size*SS-1), radius=radius*SS, fill=255)
    mask = big.resize((size, size), Image.LANCZOS)
    out = Image.new('RGBA', (size, size), (0,0,0,0))
    out.paste(im, (0,0), mask=mask)
    if polish:
        hl = Image.new('RGBA', (size, size), (0,0,0,0))
        d = ImageDraw.Draw(hl)
        half = size // 2
        for i in range(half):
            a = int(30 * (1 - i/half) ** 2)
            d.rectangle((0, i, size, i+1), fill=(255,255,255,a))
        clipped = Image.new('RGBA', (size, size), (0,0,0,0))
        clipped.paste(hl, (0,0), mask=mask)
        out = Image.alpha_composite(out, clipped)
        b = Image.new('RGBA', (size*SS, size*SS), (0,0,0,0))
        ImageDraw.Draw(b).rounded_rectangle((SS,SS,size*SS-SS-1,size*SS-SS-1), radius=(radius-1)*SS, outline=(255,255,255,55), width=SS*2)
        out = Image.alpha_composite(out, b.resize((size,size), Image.LANCZOS))
    return out

def main():
    src = build_source()
    src.save(BUILD_DIR / 'icon-source.png', 'PNG', optimize=True)
    print('wrote icon-source.png (泰卦 1024x1024)')

    # 跑原 make-icon.py 生成 icon.png / 256 / ico / icns / installerHeaderIcon.ico
    import importlib.util
    spec = importlib.util.spec_from_file_location('make_icon', str(BUILD_DIR / 'make-icon.py'))
    make_icon = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(make_icon)
    make_icon.main()
    print('make-icon.py 变体已生成')

    # mac 卡通同源图（复用同一泰卦设计）
    src.save(BUILD_DIR / 'icon-mac-cartoon-source.png', 'PNG', optimize=True)
    rounded_icon(src, 1024).save(BUILD_DIR / 'icon-mac-cartoon.png', 'PNG', optimize=True)
    rounded_icon(src, 256).save(BUILD_DIR / 'icon-mac-cartoon-256.png', 'PNG', optimize=True)
    # mac cartoon ico
    icons = [rounded_icon(src, s, polish=(s >= 48)) for s in [16,24,32,48,64,128,256]]
    ico = BUILD_DIR / 'icon-mac-cartoon.ico'
    icons[-1].save(ico, format='ICO', sizes=[(s,s) for s in [16,24,32,48,64,128,256]], append_images=icons[:-1])
    print('wrote icon-mac-cartoon.*')

    # 安装包侧栏图（NSIS 规格 164x314，32 位）：深靛蓝底 + 泰卦小标
    W, H = 164, 314
    for name in ('installerSidebar.bmp', 'uninstallerSidebar.bmp'):
        side = vertical_gradient(H, [(0, hex_color('#16233f')), (0.6, hex_color('#2e4a7a')), (1, hex_color('#a06f2e'))]).resize((W, H), Image.LANCZOS)
        mini = build_source().resize((104, 104), Image.LANCZOS)
        mask = Image.new('L', (104, 104), 0)
        ImageDraw.Draw(mask).ellipse((0, 0, 103, 103), fill=255)
        side.paste(mini, ((W - 104) // 2, 26), mask=mask)
        # 底部一行文字「天地交泰」
        d = ImageDraw.Draw(side)
        try:
            font = ImageFont.truetype('msyh.ttc', 20)
        except Exception:
            font = ImageFont.load_default()
        d.text((W // 2, H - 46), '天地交泰', font=font, fill=(255, 216, 115, 255), anchor='mm')
        side.save(BUILD_DIR / name, 'BMP')
    print('wrote installerSidebar.bmp / uninstallerSidebar.bmp (164x314)')

if __name__ == '__main__':
    main()
