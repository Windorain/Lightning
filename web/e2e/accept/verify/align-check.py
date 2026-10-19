#!/usr/bin/env python3
"""机位对齐检查（精确投影版）。

对每个场景方块，按**同一个世界坐标**分别投影到游戏图与 Web 图，
采样该像素处的颜色，比较两者的色度（亮度归一化）。
若任一侧的机位/朝向/缩放有错，取样点会落到别的方块或背景上，色差必然超限——
因此这一条同时验证「机位对齐」与「布局对齐」，且无需裁剪/包围盒检测。

用法：
  python verify/align-check.py --game g.png --web w.png --shot-meta shot-meta.json \
      --plan plan.json --camera front --scene scene.json [--out report.json]
"""
import argparse, json, math, sys
from PIL import Image

def corner_bg(im, patch=6):
    w, h = im.size
    pts = []
    for (x, y) in [(0, 0), (w - patch, 0), (0, h - patch), (w - patch, h - patch)]:
        for i in range(patch):
            for j in range(patch):
                pts.append(im.getpixel((x + i, y + j)))
    pts.sort(key=lambda c: sum(c))
    return pts[len(pts) // 2]

def is_background(c, bg, tol=26):
    return max(abs(c[0] - bg[0]), abs(c[1] - bg[1]), abs(c[2] - bg[2])) <= tol

def normalize(v):
    s = sum(v) or 1.0
    return tuple(x / s for x in v)

def sample(im, x, y, r=5):
    px = im.load(); w, h = im.size
    acc = [0.0, 0.0, 0.0]; n = 0
    for yy in range(max(0, int(y) - r), min(h, int(y) + r + 1)):
        for xx in range(max(0, int(x) - r), min(w, int(x) + r + 1)):
            c = px[xx, yy]; acc[0] += c[0]; acc[1] += c[1]; acc[2] += c[2]; n += 1
    if n == 0:
        return (0.0, 0.0, 0.0)
    return tuple(v / n for v in acc)

def cross(a, b):
    return [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]]

def norm3(v):
    l = math.sqrt(sum(x*x for x in v)) or 1.0
    return [x / l for x in v]

def dot(a, b):
    return sum(x*y for x, y in zip(a, b))

def game_mapping(cam, point):
    W, H = cam['resolution']
    yaw = math.radians(cam['yaw']); pitch = math.radians(cam['pitch'])
    d = [-math.sin(yaw)*math.cos(pitch), -math.sin(pitch), math.cos(yaw)*math.cos(pitch)]
    right = norm3(cross(d, [0, 1, 0]))
    up = cross(right, d)
    rel = [point[i] - cam['pos'][i] for i in range(3)]
    ppb = H / cam['orthoHeight']
    return (W/2 + dot(rel, right)*ppb, H/2 - dot(rel, up)*ppb, ppb)

def web_mapping(shot, local_box, point):
    W, H = shot['canvas']['width'], shot['canvas']['height']
    zoom = shot['zoom']
    web = shot['web']
    lc = [(local_box['min'][i] + local_box['max'][i]) / 2 for i in range(3)]
    yaw = math.radians(web['yawDeg']); elev = math.radians(web['elevationDeg'])
    d = [math.sin(yaw)*math.cos(elev), math.sin(elev), math.cos(yaw)*math.cos(elev)]
    cam_pos = [lc[i] + d[i]*web['distance'] for i in range(3)]
    forward = norm3([lc[i] - cam_pos[i] for i in range(3)])
    right = norm3(cross(forward, [0, 1, 0]))
    up = cross(right, forward)
    off = [shot['web']['targetWorld'][i] - lc[i] for i in range(3)]
    pl = [point[i] - off[i] for i in range(3)]
    rel = [pl[i] - cam_pos[i] for i in range(3)]
    ppb = H * zoom / 10
    return (W/2 + dot(rel, right)*ppb, H/2 - dot(rel, up)*ppb, ppb)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--game', required=True); ap.add_argument('--web', required=True)
    ap.add_argument('--shot-meta', required=True); ap.add_argument('--plan', required=True)
    ap.add_argument('--camera', required=True); ap.add_argument('--scene', required=True)
    ap.add_argument('--threshold', type=float, default=0.06)
    ap.add_argument('--bg-tol', type=float, default=26)
    ap.add_argument('--out', default=None)
    a = ap.parse_args()

    plan = json.load(open(a.plan, encoding='utf-8'))
    scene = json.load(open(a.scene, encoding='utf-8'))
    meta = json.load(open(a.shot_meta, encoding='utf-8'))
    cam = next(c for c in plan['cameras'] if c['name'] == a.camera)
    shot = next(s for s in meta['shots'] if s['name'] == a.camera)
    if meta.get('localBox') is None:
        print(json.dumps({'verdict': 'blocked', 'reason': 'shot-meta 缺 localBox（无法建立世界→Web 像素映射）'}, ensure_ascii=False))
        return 2

    g = Image.open(a.game).convert('RGB'); w = Image.open(a.web).convert('RGB')
    bg_g = corner_bg(g); bg_w = corner_bg(w)
    o = scene['world']['origin']
    checks = []
    for b in scene['blocks']:
        cx = o[0] + b['at'][0] + 0.5
        cy = o[1] + b['at'][1] + 0.5
        cz = o[2] + b['at'][2] + 0.5
        gx, gy, gppb = game_mapping(cam['game'], [cx, cy, cz])
        wx, wy, wppb = web_mapping(shot, meta['localBox'], [cx, cy, cz])
        gc = sample(g, gx, gy); wc = sample(w, wx, wy)
        g_bg = is_background(gc, bg_g, tol=a.bg_tol)
        w_bg = is_background(wc, bg_w, tol=a.bg_tol)
        if g_bg != w_bg:
            verdict, d = 'fail', None
        elif g_bg and w_bg:
            d = 0.0; verdict = 'pass'  # 两侧都透出背景：一致（背景色本身不比）
        else:
            d = max(abs(normalize(gc)[i] - normalize(wc)[i]) for i in range(3))
            verdict = 'pass' if d <= a.threshold else 'fail'
        checks.append({'cell': b['at'], 'block': b['block'],
                       'game_px': [round(gx, 1), round(gy, 1)], 'web_px': [round(wx, 1), round(wy, 1)],
                       'game_rgb': [round(v) for v in gc], 'web_rgb': [round(v) for v in wc],
                       'game_background': g_bg, 'web_background': w_bg,
                       'chroma_delta': None if d is None else round(d, 4),
                       'verdict': verdict})
    ok = all(c['verdict'] == 'pass' for c in checks)
    report = {'camera': a.camera, 'px_per_block': {'game': round(gppb, 3), 'web': round(wppb, 3)},
              'threshold': a.threshold, 'checks': checks, 'verdict': 'pass' if ok else 'fail'}
    txt = json.dumps(report, ensure_ascii=False, indent=2)
    if a.out: open(a.out, 'w', encoding='utf-8').write(txt + '\n')
    print(txt)
    return 0 if ok else 1

if __name__ == '__main__':
    sys.exit(main())
