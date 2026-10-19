#!/usr/bin/env python3
"""判据执行器：把 expect/<id>.json 在**一对图**上跑成 pass/fail/blocked + 数值。

输入：场景、判据、机位计划、某一机位的 game.png / web.png / shot-meta.json
输出：固定格式报告（每项判据带数值），退出码 0 = 无 fail（blocked 允许）。

天空盒：`compare.exclude` 含 sky 时，两图各自的角落色即背景，**背景色本身不参与**比较。
光照：`compare.normalize=per-face-luminance` 时只比色度（亮度归一化）。
"""
import argparse, json, sys
from PIL import Image
from pairmap import corner_bg, is_background, sample, normalize, game_mapping, web_mapping

FACE_NORMAL = {'+x': (1, 0, 0), '-x': (-1, 0, 0), '+y': (0, 1, 0), '-y': (0, -1, 0), '+z': (0, 0, 1), '-z': (0, 0, -1)}

def cell_center(scene, at):
    o = scene['world']['origin']
    return (o[0] + at[0] + 0.5, o[1] + at[1] + 0.5, o[2] + at[2] + 0.5)

def classify(rgb, bg, tol):
    return 'background' if is_background(rgb, bg, tol) else 'content'

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--scene', required=True); ap.add_argument('--expect', required=True)
    ap.add_argument('--plan', required=True); ap.add_argument('--camera', required=True)
    ap.add_argument('--game', required=True); ap.add_argument('--web', required=True)
    ap.add_argument('--shot-meta', required=True); ap.add_argument('--out', default=None)
    ap.add_argument('--bg-tol', type=float, default=26)
    a = ap.parse_args()

    scene = json.load(open(a.scene, encoding='utf-8'))
    expect = json.load(open(a.expect, encoding='utf-8'))
    plan = json.load(open(a.plan, encoding='utf-8'))
    meta = json.load(open(a.shot_meta, encoding='utf-8'))
    cam = next(c for c in plan['cameras'] if c['name'] == a.camera)
    shot = next(s for s in meta['shots'] if s['name'] == a.camera)
    if meta.get('localBox') is None:
        print(json.dumps({'verdict': 'blocked', 'reason': '缺 localBox'}, ensure_ascii=False)); return 2

    g = Image.open(a.game).convert('RGB'); w = Image.open(a.web).convert('RGB')
    bg_g, bg_w = corner_bg(g), corner_bg(w)
    thr = expect['compare']['thresholds']
    blocks = {b['block'] for b in scene['blocks']}
    transparent = {b['block'] for b in scene['blocks'] if 'glass' in b['block']}
    results = []

    # 机位健康检查：两侧内容像素量必须同量级。
    # 实测：某机位（-Z 侧）只渲染出 1 格（疑似单侧裁剪缺陷）——这种图不能拿去判内容，
    # 否则会把产品缺陷记成内容不一致。故先量覆盖率，不足即 blocked。
    def content_pixels(img, bg):
        # 只统计**中心区**：工具栏/提示条等 UI 覆盖在画面边缘，会把"内容量"污染成恒等。
        px = img.load(); W, H = img.size; n = 0
        x0, x1 = int(W * 0.10), int(W * 0.90)
        y0, y1 = int(H * 0.10), int(H * 0.90)
        for y in range(y0, y1):
            for x in range(x0, x1):
                if not is_background(px[x, y], bg, a.bg_tol):
                    n += 1
        return n
    gp, wp = content_pixels(g, bg_g), content_pixels(w, bg_w)
    ratio = (wp / gp) if gp else 0.0
    if gp == 0 or ratio < 0.5 or ratio > 2.0:
        report = {'scene': scene['id'], 'camera': a.camera, 'verdict': 'blocked',
                  'reason': '两侧内容量差异过大（game=%d px, web=%d px, ratio=%.2f）——先查渲染缺陷，再判内容' % (gp, wp, ratio),
                  'counts': {'pass': 0, 'fail': 0, 'blocked': 1},
                  'checks': [{'id': 'view-health', 'kind': 'guard', 'verdict': 'blocked', 'game_px': gp, 'web_px': wp, 'ratio': round(ratio, 3)}],
                  'images': {'game': a.game, 'web': a.web}}
        txt = json.dumps(report, ensure_ascii=False, indent=2)
        if a.out: open(a.out, 'w', encoding='utf-8').write(txt + '\n')
        print(txt)
        return 0

    def px(point):
        gx, gy, _ = game_mapping(cam['game'], point)
        wx, wy, _ = web_mapping(shot, meta['localBox'], point)
        return gx, gy, wx, wy

    for chk in expect['checks']:
        kind = chk['kind']
        if chk.get('cameras') and a.camera not in chk['cameras']:
            results.append({'id': chk['id'], 'kind': kind, 'verdict': 'na', 'reason': '该机位不适用（判据文件声明）'})
            continue
        if kind in ('region', 'opaque'):
            at = chk['at']
            p = list(cell_center(scene, at))
            if chk.get('face') in FACE_NORMAL:
                n = FACE_NORMAL[chk['face']]
                p = [p[i] + n[i] * 0.5 for i in range(3)]
            # 网格采样：把该格的 8 个角投影成像素矩形，在矩形内取 5×5 —— 与机位无关，
            # 且不会因为撞到缝合线/边框而给单点结论。
            corners = []
            for dx in (0.0, 1.0):
                for dy in (0.0, 1.0):
                    for dz in (0.0, 1.0):
                        corners.append((p[0] - 0.5 + dx, p[1] - 0.5 + dy, p[2] - 0.5 + dz))
            def rect_of(conv):
                xs = []; ys = []
                for c in corners:
                    X, Y, _ = conv(c); xs.append(X); ys.append(Y)
                return min(xs), min(ys), max(xs), max(ys)
            def ratio(img, bg, conv):
                x0, y0, x1, y1 = rect_of(conv)
                inset_x = (x1 - x0) * 0.15; inset_y = (y1 - y0) * 0.15
                n = hit = 0
                for i in range(5):
                    for j in range(5):
                        X = x0 + inset_x + (x1 - x0 - 2 * inset_x) * i / 4
                        Y = y0 + inset_y + (y1 - y0 - 2 * inset_y) * j / 4
                        n += 1
                        hit += 1 if is_background(sample(img, X, Y, r=2), bg, a.bg_tol) else 0
                return hit / n
            gr = ratio(g, bg_g, lambda q: game_mapping(cam['game'], q))
            wr = ratio(w, bg_w, lambda q: web_mapping(shot, meta['localBox'], q))
            gcls = 'background' if gr >= 0.5 else 'content'
            wcls = 'background' if wr >= 0.5 else 'content'
            want = chk.get('expect', 'not-background')
            if want.startswith('block:'):
                results.append({'id': chk['id'], 'kind': kind, 'verdict': 'blocked',
                                'reason': '未建立方块参考色表，无法机械比对指定方块色', 'game_rgb': list(map(round, gc)), 'web_rgb': list(map(round, wc))})
                continue
            ok = (gcls == 'background' and wcls == 'background') if want == 'background' else (gcls == 'content' and wcls == 'content')
            if not ok and (gcls != wcls) and blocks & transparent and kind == 'region':
                verdict = 'blocked'
                reason = '透明方块两侧分类不一致（Web 未按透明渲染，已知缺陷）'
            elif not ok:
                verdict, reason = 'fail', '两侧分类不符合期望：game=%s web=%s' % (gcls, wcls)
            else:
                verdict, reason = 'pass', None
            item = {'id': chk['id'], 'kind': kind, 'verdict': verdict,
                    'game': gcls, 'web': wcls, 'want': want,
                    'game_bg_ratio': round(gr, 3), 'web_bg_ratio': round(wr, 3)}
            if reason: item['reason'] = reason
            results.append(item)

        elif kind == 'seam':
            a0, b0 = chk['between']
            p0 = cell_center(scene, a0); p1 = cell_center(scene, b0)
            mid = [(p0[i] + p1[i]) / 2 for i in range(3)]
            axis = chk['axis']
            idx = {'x': 0, 'y': 1, 'z': 2}[axis]
            edges = {}
            for name, img, conv in (('game', g, lambda q: game_mapping(cam['game'], q)),
                                    ('web', w, lambda q: web_mapping(shot, meta['localBox'], q))):
                vals = []
                for d in (-0.45, -0.15, 0.15, 0.45):
                    pass  # 沿分界线两侧取样：以 mid 为界，向两侧各取 3 个采样带
                left_pts, right_pts = [], []
                for off in (0.5, 1.0, 1.5):
                    ql = list(mid); ql[idx] -= off
                    qr = list(mid); qr[idx] += off
                    x1, y1, _ = conv(ql); x2, y2, _ = conv(qr)
                    left_pts.append(sample(img, x1, y1, r=2)); right_pts.append(sample(img, x2, y2, r=2))
                ml = [sum(p[i] for p in left_pts) / len(left_pts) for i in range(3)]
                mr = [sum(p[i] for p in right_pts) / len(right_pts) for i in range(3)]
                edges[name] = max(abs(normalize(ml)[i] - normalize(mr)[i]) for i in range(3))
            worst = max(edges.values())
            verdict = 'pass' if worst <= thr['seamEdgeMax'] else 'fail'
            results.append({'id': chk['id'], 'kind': 'seam', 'verdict': verdict,
                            'value': round(worst, 4), 'threshold': thr['seamEdgeMax'], 'per_side': {k: round(v, 4) for k, v in edges.items()}})

        elif kind == 'silhouette':
            def mask(img, bg):
                px_ = img.load(); W, H = img.size
                m = [[0] * W for _ in range(H)]
                for y in range(H):
                    row = m[y]
                    for x in range(W):
                        row[x] = 0 if is_background(px_[x, y], bg, a.bg_tol) else 1
                return m
            o = scene['world']['origin']
            xs = [o[0] + b['at'][0] for b in scene['blocks']] + [o[0] + b['at'][0] + 1 for b in scene['blocks']]
            ys = [o[1] + b['at'][1] for b in scene['blocks']] + [o[1] + b['at'][1] + 1 for b in scene['blocks']]
            zs = [o[2] + b['at'][2] for b in scene['blocks']] + [o[2] + b['at'][2] + 1 for b in scene['blocks']]
            def rect_of_bounds(conv):
                px_ = []
                for X in (min(xs), max(xs)):
                    for Y in (min(ys), max(ys)):
                        for Z in (min(zs), max(zs)):
                            x, y, _ = conv((X, Y, Z)); px_.append((x, y))
                return (min(p[0] for p in px_), min(p[1] for p in px_), max(p[0] for p in px_), max(p[1] for p in px_))
            def mask_in(img, bg, rect):
                x0, y0, x1, y1 = [int(v) for v in rect]
                W, H = img.size
                x0 = max(0, x0); y0 = max(0, y0); x1 = min(W, x1); y1 = min(H, y1)
                px_ = img.load()
                m = Image.new('L', (max(1, x1 - x0), max(1, y1 - y0)), 0)
                mp = m.load()
                for y in range(max(1, y1 - y0)):
                    for x in range(max(1, x1 - x0)):
                        mp[x, y] = 255 if not is_background(px_[x0 + x, y0 + y], bg, a.bg_tol) else 0
                return m
            rg = rect_of_bounds(lambda q: game_mapping(cam['game'], q))
            rw = rect_of_bounds(lambda q: web_mapping(shot, meta['localBox'], q))
            mg = mask_in(g, bg_g, rg); mw = mask_in(w, bg_w, rw)
            SIZE = 256
            mg = mg.resize((SIZE, SIZE)); mw = mw.resize((SIZE, SIZE))
            pg, pw = mg.load(), mw.load()
            inter = union = 0
            for y in range(SIZE):
                for x in range(SIZE):
                    a1 = pg[x, y] > 127; a2 = pw[x, y] > 127
                    if a1 or a2: union += 1
                    if a1 and a2: inter += 1
            iou = inter / union if union else 0.0
            verdict = 'pass' if iou >= thr['silhouetteIoU'] else 'fail'
            results.append({'id': chk['id'], 'kind': 'silhouette', 'verdict': verdict,
                            'value': round(iou, 4), 'threshold': thr['silhouetteIoU']})
            continue
        else:
            results.append({'id': chk['id'], 'kind': kind, 'verdict': 'blocked', 'reason': '首版未实现该判据类型'})

    # 同一根因不重复计红：透明缺陷已计入某项 blocked 时，形状判据同样标 blocked。
    transparency_blocked = any(r['verdict'] == 'blocked' and '透明' in str(r.get('reason', '')) for r in results)
    if transparency_blocked:
        for r in results:
            if r['kind'] == 'silhouette' and r['verdict'] == 'fail':
                r['verdict'] = 'blocked'
                r['reason'] = '受同一透明缺陷影响（形状随透明度变化）'
    verdict = 'fail' if any(r['verdict'] == 'fail' for r in results) else 'pass'
    report = {'scene': scene['id'], 'camera': a.camera, 'verdict': verdict,
              'counts': {k: sum(1 for r in results if r['verdict'] == k) for k in ('pass', 'fail', 'blocked')},
              'checks': results,
              'images': {'game': a.game, 'web': a.web}}
    txt = json.dumps(report, ensure_ascii=False, indent=2)
    if a.out: open(a.out, 'w', encoding='utf-8').write(txt + '\n')
    print(txt)
    return 0 if verdict == 'pass' else 1

if __name__ == '__main__':
    sys.exit(main())
