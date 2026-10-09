"""Native-grid palco scenes for the home, 404 and erro screens (mirrors lib/palco.ts + scene.ts rules).

Scene art only: name tags, bubbles, "Voce" and "Previa da sala" are DOM over the PNG
(see lib/palcoScenes.generated.ts, written by this script).
"""
import json, os, random, sys
from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
WEB = os.path.normpath(os.path.join(HERE, '..', '..'))
P = sys.argv[1] if len(sys.argv) > 1 else os.path.join(WEB, 'public', 'palco')
OUT = sys.argv[2] if len(sys.argv) > 2 else os.path.join(WEB, 'public', 'palco', 'scenes')
TS = os.path.join(WEB, 'lib', 'palcoScenes.generated.ts')
INK = (13, 10, 23)

WORLDS = {
    'wide': dict(W=360, H=225, src='stage-360-v11.png', sky='sky-360-v10.png', screen=(115, 78, 131, 74), rowsFrom=200, rowsToOff=24),
    'phone': dict(W=202, H=360, src='stage-phone-202-v11.png', sky='sky-202-v10.png', screen=(41, 75, 120, 70), rowsFrom=196, rowsToOff=38),
}
SIDE = 140
EDGE = 8

FONT = {'A': ['01110', '10001', '10001', '11111', '10001', '10001', '10001'], 'B': ['11110', '10001', '10001', '11110', '10001', '10001', '11110'], 'C': ['01110', '10001', '10000', '10000', '10000', '10001', '01110'], 'D': ['11110', '10001', '10001', '10001', '10001', '10001', '11110'], 'E': ['11111', '10000', '10000', '11110', '10000', '10000', '11111'], 'F': ['11111', '10000', '10000', '11110', '10000', '10000', '10000'], 'G': ['01110', '10001', '10000', '10111', '10001', '10001', '01111'], 'H': ['10001', '10001', '10001', '11111', '10001', '10001', '10001'], 'I': ['01110', '00100', '00100', '00100', '00100', '00100', '01110'], 'J': ['00111', '00010', '00010', '00010', '00010', '10010', '01100'], 'K': ['10001', '10010', '10100', '11000', '10100', '10010', '10001'], 'L': ['10000', '10000', '10000', '10000', '10000', '10000', '11111'], 'M': ['10001', '11011', '10101', '10101', '10001', '10001', '10001'], 'N': ['10001', '11001', '10101', '10011', '10001', '10001', '10001'], 'O': ['01110', '10001', '10001', '10001', '10001', '10001', '01110'], 'P': ['11110', '10001', '10001', '11110', '10000', '10000', '10000'], 'Q': ['01110', '10001', '10001', '10001', '10101', '10010', '01101'], 'R': ['11110', '10001', '10001', '11110', '10100', '10010', '10001'], 'S': ['01111', '10000', '10000', '01110', '00001', '00001', '11110'], 'T': ['11111', '00100', '00100', '00100', '00100', '00100', '00100'], 'U': ['10001', '10001', '10001', '10001', '10001', '10001', '01110'], 'V': ['10001', '10001', '10001', '10001', '10001', '01010', '00100'], 'W': ['10001', '10001', '10001', '10101', '10101', '11011', '10001'], 'X': ['10001', '10001', '01010', '00100', '01010', '10001', '10001'], 'Y': ['10001', '10001', '01010', '00100', '00100', '00100', '00100'], 'Z': ['11111', '00001', '00010', '00100', '01000', '10000', '11111'], '0': ['01110', '10001', '10011', '10101', '11001', '10001', '01110'], '1': ['00100', '01100', '00100', '00100', '00100', '00100', '01110'], '2': ['01110', '10001', '00001', '00010', '00100', '01000', '11111'], '3': ['11110', '00001', '00001', '01110', '00001', '00001', '11110'], '4': ['00010', '00110', '01010', '10010', '11111', '00010', '00010'], '5': ['11111', '10000', '11110', '00001', '00001', '10001', '01110'], '6': ['00110', '01000', '10000', '11110', '10001', '10001', '01110'], '7': ['11111', '00001', '00010', '00100', '01000', '01000', '01000'], '8': ['01110', '10001', '10001', '01110', '10001', '10001', '01110'], '9': ['01110', '10001', '10001', '01111', '00001', '00010', '01100'], ' ': ['000', '000', '000', '000', '000', '000', '000'], '.': ['0', '0', '0', '0', '0', '0', '1']}


def text_w(s, k=1):
    return sum((len(FONT[c][0]) + 1) * k for c in s) - k


def draw_text(im, s, x, y, col, k=1):
    px = im.load()
    for c in s:
        g = FONT[c]
        for j, row in enumerate(g):
            for i, b in enumerate(row):
                if b == '1':
                    for dy in range(k):
                        for dx in range(k):
                            px[x + i * k + dx, y + j * k + dy] = col
        x += (len(g[0]) + 1) * k


def load(n):
    return Image.open(f'{P}/{n}').convert('RGBA')


def world_image(kind, dim=1.0):
    """Sky + stage + plain side extension + ground, in world coords offset by (SIDE, 540)."""
    w = WORLDS[kind]
    W, H = w['W'], w['H']
    SW = W + 2 * SIDE
    im = Image.new('RGBA', (SW, 540 + H + 300), INK + (255,))
    sky = load(w['sky'])
    if dim != 1.0:
        sky = Image.eval(sky.convert('RGB'), lambda v: int(v * dim)).convert('RGBA')
    for x0 in range(SIDE - W * 2, SW, W):  # tile sky across the extension
        im.alpha_composite(sky, (x0, 540 - sky.size[1]))
    st = load(w['src'])
    if dim != 1.0:
        st = Image.eval(st.convert('RGB'), lambda v: int(v * dim)).convert('RGBA')
    im.alpha_composite(st, (SIDE, 540))
    spx = st.load()
    ipx = im.load()
    for side, x0 in (('L', 0), ('R', W - EDGE)):
        prev = None
        for y in range(H):
            count = {}
            for x in range(x0, x0 + EDGE):
                r, g, b = spx[x, y][:3]
                if r * 0.3 + g * 0.59 + b * 0.11 >= 50:
                    continue
                count[(r, g, b)] = count.get((r, g, b), 0) + 1
            best = max(count.items(), key=lambda kv: kv[1]) if count else (None, 0)
            if best[1] * 2 > EDGE or prev is None:
                prev = best[0] or INK
            rng = range(0, SIDE) if side == 'L' else range(SIDE + W, SW)
            for x in rng:
                ipx[x, 540 + y] = prev + (255,)
    for y in range(540 + H, im.size[1]):
        c = (15, 14, 29, 255) if y < 540 + H + 20 else (11, 10, 22, 255)
        for x in range(SW):
            ipx[x, y] = c
    return im


def crowd_rows(im, kind, crowd_bottom, seed=3, density=1.0):
    w = WORLDS[kind]
    rnd = random.Random(seed)
    first, last = w['rowsFrom'], crowd_bottom - w['rowsToOff']
    feet = first
    while feet <= last:
        t = max(0, min(1, (feet - first) / max(26, last - first)))
        layer = 'far' if t < 0.34 else 'mid' if t < 0.67 else 'near'
        a = load(f'crowd-{layer}-a.png')
        off = rnd.randrange(a.size[0])
        for x0 in range(-off, im.size[0], a.size[0]):
            tile = a.transpose(Image.FLIP_LEFT_RIGHT) if (x0 // a.size[0]) % 2 else a
            if density < 1 and rnd.random() > density:
                continue
            im.alpha_composite(tile, (x0, 540 + feet + 2 - a.size[1])) if x0 >= 0 else im.alpha_composite(tile.crop((-x0, 0, a.size[0], a.size[1])), (0, 540 + feet + 2 - a.size[1]))
        feet += max(11, round((24 + 14 * t) * 0.42))


SCREENS = []
PLACED = []  # (character id, x, feet, w, h) in world coordinates


def sprite(im, n, frame, x, feet):
    s = load(f'characters/{n:02d}-{frame}.png')
    im.alpha_composite(s, (SIDE + x, 540 + feet - s.size[1]))
    PLACED.append((n, x, feet, s.size[0], s.size[1]))
    return s.size


def fill_screen(im, kind, fn):
    x, y, w, h = WORLDS[kind]['screen']
    scr = Image.new('RGBA', (w, h), (8, 6, 16, 255))
    fn(scr)
    im.alpha_composite(scr, (SIDE + x, 540 + y))
    SCREENS.append((x, y, w, h))


def cover_art(scr):
    """Abstract warm cover (example), 8 colours, no dithering."""
    w, h = scr.size
    d = ImageDraw.Draw(scr)
    d.rectangle((0, 0, w, h), fill=(58, 33, 22, 255))
    d.ellipse((w * 0.45, -h * 0.4, w * 1.25, h * 0.75), fill=(176, 84, 42, 255))
    d.ellipse((w * 0.55, -h * 0.2, w * 1.05, h * 0.5), fill=(224, 140, 66, 255))
    d.rectangle((0, h * 0.68, w, h), fill=(32, 18, 14, 255))
    d.polygon([(0, h), (w * 0.35, h * 0.45), (w * 0.62, h)], fill=(20, 12, 10, 255))
    d.ellipse((w * 0.68, h * 0.08, w * 0.86, h * 0.36), fill=(247, 206, 120, 255))


def crop(im, kind, cam_left, cam_top, cw, ch):
    x0 = SIDE + cam_left
    return im.crop((x0, 540 + cam_top, x0 + cw, 540 + cam_top + ch))


MANIFEST = {}


def emit(img, name, kind, cam_left, cam_top, cw, ch):
    """Crop the world to the native scene, save the PNG and record sprite boxes."""
    scene = crop(img, kind, cam_left, cam_top, cw, ch)
    scene.save(f'{OUT}/{name}.png')
    sx, sy, sw, sh = SCREENS[-1]
    MANIFEST[name] = dict(
        src=f'/palco/scenes/{name}.png', w=cw, h=ch,
        screen=dict(x=sx - cam_left, y=sy - cam_top, w=sw, h=sh),
        sprites=[dict(id=n, cx=x - cam_left + w // 2, top=feet - h - cam_top, feet=feet - cam_top)
                 for (n, x, feet, w, h) in PLACED],
    )
    PLACED.clear()
    print(name, scene.size)


WHITE = (240, 236, 255, 255)
VIOLET = (170, 130, 255, 255)


def screen_404(scr):
    w, h = scr.size
    tw = text_w('404', 3)
    draw_text(scr, '404', (w - tw) // 2, 14, WHITE, 3)
    tw2 = text_w('SEM SINAL', 1)
    draw_text(scr, 'SEM SINAL', (w - tw2) // 2, 46, VIOLET, 1)
    for x in range(0, w, 2):  # scanline bars at the bottom, static
        scr.putpixel((x, h - 8), (60, 44, 110, 255))


def screen_flat(scr):
    w, h = scr.size
    for x in range(10, w - 10):
        scr.putpixel((x, h // 2), WHITE)
    tw = text_w('SEM SOM', 1)
    draw_text(scr, 'SEM SOM', (w - tw) // 2, h // 2 + 10, VIOLET, 1)


# Home: a room playing (abstract example cover, no real album art). Wide 480x300 (3x at 1440).
im = world_image('wide')
crowd_rows(im, 'wide', 262)
fill_screen(im, 'wide', cover_art)
xs = [60, 96, 132, 170, 206, 244, 280]
who = [(2, 'front'), (7, 'up-front'), (4, 'front'), (1, 'up-front'), (5, 'front'), (10, 'front'), (13, 'up-front')]
for x, (n, f) in zip(xs, who):
    sprite(im, n, f, x + (0 if f == 'front' else -4), 268)
emit(im, 'home-wide', 'wide', -110, -30, 480, 300)

# Home phone 195x280 (2x at 390).
im = world_image('phone')
crowd_rows(im, 'phone', 300)
fill_screen(im, 'phone', cover_art)
for x, (n, f) in zip([14, 46, 80, 114, 148], [(2, 'front'), (7, 'up-front'), (1, 'up-front'), (5, 'front'), (13, 'front')]):
    sprite(im, n, f, x + (0 if f == 'front' else -4), 304)
emit(im, 'home-phone', 'phone', 4, 40, 195, 280)

# 404: empty floor, one person (you, character 3).
im = world_image('wide')
fill_screen(im, 'wide', screen_404)
sprite(im, 3, 'front', 170, 236)
emit(im, '404-wide', 'wide', -60, -10, 480, 250)
im = world_image('phone')
fill_screen(im, 'phone', screen_404)
sprite(im, 3, 'front', 91, 250)
emit(im, '404-phone', 'phone', 4, 40, 195, 240)

# Erro: lights down, everyone waiting with their backs to us.
im = world_image('wide', dim=0.55)
crowd_rows(im, 'wide', 236, seed=5)
fill_screen(im, 'wide', screen_flat)
for x, n in zip([96, 150, 206, 260], [4, 9, 11, 6]):
    sprite(im, n, 'back', x, 240)
emit(im, 'erro-wide', 'wide', -60, -10, 480, 250)
im = world_image('phone', dim=0.55)
crowd_rows(im, 'phone', 272, seed=5)
fill_screen(im, 'phone', screen_flat)
for x, n in zip([40, 90, 140], [4, 9, 11]):
    sprite(im, n, 'back', x, 278)
emit(im, 'erro-phone', 'phone', 4, 40, 195, 240)

with open(TS, 'w') as f:
    f.write('// Generated by scripts/palco-scenes/compose.py. Do not edit by hand.\n')
    f.write('// Native-pixel boxes of the scene art; the DOM overlays scale them by the integer k.\n')
    f.write('export type SceneName = ' + ' | '.join(f"'{k}'" for k in MANIFEST) + ';\n\n')
    f.write('export interface SceneSprite { id: number; cx: number; top: number; feet: number }\n')
    f.write('export interface SceneArt {\n  src: string;\n  w: number;\n  h: number;\n  screen: { x: number; y: number; w: number; h: number };\n  sprites: SceneSprite[];\n}\n\n')
    f.write('export const SCENES: Record<SceneName, SceneArt> = ' + json.dumps(MANIFEST, indent=2) + ';\n')
