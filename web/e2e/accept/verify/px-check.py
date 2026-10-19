#!/usr/bin/env python3
"""机位像素对齐判据（标定场景专用，机械可判）。

做法：对每个标定方块，用**声明世界的投影**算出它的预测矩形；在预测矩形附近
（默认 ±8 px 搜索窗）按颜色聚类找出真实占位，比较真实矩形中心与预测中心的像素差。
两侧（game / web）各自出数；任一侧 > --tol 即 fail，并逐格给数。

为什么这样判：只看"图里像不像"会把相机偏移吃进内容差异里；先证明每格落点误差 ≤1 px，
后面所有内容判据才有意义。映射实现来自 pairmap（唯一实现）。

用法：
  python verify/px-check.py --scene scenes/calibration.json --plan plan.json \
      --shot-meta shot-meta.json --camera front --game g.png --web w.png [--tol 1] [--out r.json]
"""
import argparse, json, sys
from PIL import Image
from pairmap import corner_bg, is_background, game_mapping, web_mapping

def cell_rect(conv, center):
    """世界方块中心 → 预测矩形（正交下即方块投影的外接方框，边长 = 1 格像素）。"""
    cx, cy, cz = center
    pts = []
    for dx in (-0.5, 0.5):
        for dy in (-0.5, 0.5):
            for dz in (-0.5, 0.5):
                x, y, _ = conv((cx + dx, cy + dy, cz + dz))
                pts.append((x, y))
    xs = [p[0] for p in pts]; ys = [p[1] for p in pts]
    return (min(xs), min(ys), max(xs), max(ys))

def find_color_box(img, rect, bg, window=8, tol=26):
    """在预测矩形附近找出与"预测矩形内主色"一致的真实占位，返回其外接框。"""
    px = img.load(); W, H = img.size
    x0, y0, x1, y1 = [int(round(v)) for v in rect]
    # 预测矩形内主色：排除背景后的中位色
    samples = []
    for y in range(max(0, y0), min(H, y1)):
        for x in range(max(0, x0), min(W, x1)):
            c = px[x, y]
            if not is_background(c, bg, tol):
                samples.append(c)
    if not samples:
        return None, None
    samples.sort(key=lambda c: sum(c))
    ref = samples[len(samples) // 2]
    # 搜索窗内同色像素的外接框
    sx0, sy0 = max(0, x0 - window), max(0, y0 - window)
    sx1, sy1 = min(W, x1 + window), min(H, y1 + window)
    bx0, by0, bx1, by1, n = None, None, None, None, 0
    for y in range(sy0, sy1):
        for x in range(sx0, sx1):
            c = px[x, y]
            if max(abs(c[i] - ref[i]) for i in range(3)) > tol:
                continue
            n += 1
            bx0 = x if bx0 is None else min(bx0, x)
            by0 = y if by0 is None else min(by0, y)
            bx1 = x if bx1 is None else max(bx1, x)
            by1 = y if by1 is None else max(by1, y)
    if n < 8:
        return None, ref
    return (bx0, by0, bx1, by1), ref

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--scene', required=True); ap.add_argument('--plan', required=True)
    ap.add_argument('--shot-meta', required=True); ap.add_argument('--camera', required=True)
    ap.add_argument('--game', required=True); ap.add_argument('--web', required=True)
    ap.add_argument('--tol', type=float, default=1.0)
    ap.add_argument('--bg-tol', type=float, default=26)
    ap.add_argument('--cells', default='', help='只检查这些格（"x,y,z;x,y,z"）；缺省检查全部')
    ap.add_argument('--out', default=None)
    a = ap.parse_args()

    scene = json.load(open(a.scene, encoding='utf-8'))
    plan = json.load(open(a.plan, encoding='utf-8'))
    meta = json.load(open(a.shot_meta, encoding='utf-8'))
    cam = next(c for c in plan['cameras'] if c['name'] == a.camera)
    shot = next(s for s in meta['shots'] if s['name'] == a.camera)
    sf = meta.get('sceneFrame')
    if sf is None:
        print(json.dumps({'verdict': 'blocked', 'reason': '缺 sceneFrame：无法建立世界→Web 映射'}, ensure_ascii=False)); return 2

    g = Image.open(a.game).convert('RGB'); w = Image.open(a.web).convert('RGB')
    bg_g, bg_w = corner_bg(g), corner_bg(w)
    o = scene['world']['origin']
    only = [tuple(int(v) for v in c.split(',')) for c in a.cells.split(';') if c.strip()]
    rows = []
    for b in scene['blocks']:
        if only and tuple(b['at']) not in only:
            continue
        c = (o[0] + b['at'][0] + 0.5, o[1] + b['at'][1] + 0.5, o[2] + b['at'][2] + 0.5)
        rg = cell_rect(lambda q: game_mapping(cam['game'], q), c)
        rw = cell_rect(lambda q: web_mapping(shot, sf, q), c)
        bg_box, _ = find_color_box(g, rg, bg_g, tol=a.bg_tol)
        bw_box, _ = find_color_box(w, rw, bg_w, tol=a.bg_tol)
        row = {'cell': b['at'], 'block': b['block'], 'predicted': {'game': [round(v, 2) for v in rg], 'web': [round(v, 2) for v in rw]}}
        for side, box, rect in (('game', bg_box, rg), ('web', bw_box, rw)):
            if box is None:
                row[side] = {'found': False, 'dx': None, 'dy': None}
                continue
            centre = ((box[0] + box[2]) / 2, (box[1] + box[3]) / 2)
            pred = ((rect[0] + rect[2]) / 2, (rect[1] + rect[3]) / 2)
            row[side] = {'found': True, 'box': list(box),
                         'dx': round(centre[0] - pred[0], 2), 'dy': round(centre[1] - pred[1], 2),
                         'err': round(max(abs(centre[0] - pred[0]), abs(centre[1] - pred[1])), 2)}
        row['verdict'] = 'pass' if all(row[s]['found'] and row[s]['err'] <= a.tol for s in ('game', 'web')) else 'fail'
        rows.append(row)

    worst = max([r[s]['err'] for r in rows for s in ('game', 'web') if r[s]['err'] is not None] or [999])
    verdict = 'pass' if all(r['verdict'] == 'pass' for r in rows) else 'fail'
    report = {'scene': scene['id'], 'camera': a.camera, 'tolerance_px': a.tol, 'worst_err_px': worst,
              'verdict': verdict, 'cells': rows}
    txt = json.dumps(report, ensure_ascii=False, indent=2)
    if a.out: open(a.out, 'w', encoding='utf-8').write(txt + '\n')
    print(txt)
    return 0 if verdict == 'pass' else 1

if __name__ == '__main__':
    sys.exit(main())
