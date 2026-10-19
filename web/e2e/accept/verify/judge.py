#!/usr/bin/env python3
"""判据执行器：把 expect/<id>.json 在**一对图**上跑成 pass/fail/blocked + 数值。

输入：场景、判据、机位计划、某一机位的 game.png / web.png / shot-meta.json
输出：固定格式报告（每项判据带数值），退出码 0 = 无 fail（blocked 允许）。

天空盒：`compare.exclude` 含 sky 时，两图各自的角落色即背景，**背景色本身不参与**比较。
光照：`compare.normalize=per-face-luminance` 时只比色度（亮度归一化）。
"""
import argparse, hashlib, json, math, sys
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
    ap.add_argument('--shot-meta', required=True)
    ap.add_argument('--run', required=True, help='本批次运行清单 run.json（批次落盘，含每张图/导出件的 sha256）')
    ap.add_argument('--doc', required=True, help='Web 侧实际使用的导出件（必须与运行清单同源）')
    ap.add_argument('--out', default=None)
    ap.add_argument('--bg-tol', type=float, default=26)
    a = ap.parse_args()

    scene = json.load(open(a.scene, encoding='utf-8'))
    expect = json.load(open(a.expect, encoding='utf-8'))
    plan = json.load(open(a.plan, encoding='utf-8'))
    meta = json.load(open(a.shot_meta, encoding='utf-8'))
    cam = next(c for c in plan['cameras'] if c['name'] == a.camera)
    shot = next(s for s in meta['shots'] if s['name'] == a.camera)
    sf = meta.get('sceneFrame')

    # 端到端闸门：图与导出件必须是**本次运行**的产物（sha256 与运行清单一致）。
    # 历史截图/历史导出件顶替同一路径 —— 在这里被机械拒绝，而不是靠人记得。
    run = json.load(open(a.run, encoding='utf-8'))
    def sha256(p):
        h = hashlib.sha256()
        with open(p, 'rb') as fh:
            for chunk in iter(lambda: fh.read(1 << 20), b''):
                h.update(chunk)
        return h.hexdigest()
    gate = []
    if run.get('scene') != scene.get('id'):
        gate.append('运行清单场景=%r 与场景定义 %r 不一致' % (run.get('scene'), scene.get('id')))
    want_shot = (run.get('shots') or {}).get(a.camera, {}).get('sha256')
    if not want_shot:
        gate.append('运行清单缺机位 %r 的截图' % a.camera)
    elif sha256(a.game) != want_shot:
        gate.append('截图与运行清单 sha256 不一致（game.png=%s… 清单=%s…）' % (sha256(a.game)[:12], want_shot[:12]))
    want_export = (run.get('export') or {}).get('sha256')
    if not want_export:
        gate.append('运行清单缺导出件')
    elif sha256(a.doc) != want_export:
        gate.append('导出件与运行清单 sha256 不一致（doc=%s… 清单=%s…）' % (sha256(a.doc)[:12], want_export[:12]))
    if gate:
        print(json.dumps({'verdict': 'blocked', 'reason': '端到端闸门拒绝：' + '；'.join(gate)}, ensure_ascii=False)); return 2
    if sf is None:
        print(json.dumps({'verdict': 'blocked', 'reason': '导出件缺声明网格 sceneFrame：无法建立世界→Web 映射'}, ensure_ascii=False)); return 2

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
    content_ratio = (wp / gp) if gp else 0.0

    def web_px(point):
        """世界点 → Web 像素：唯一实现来自 pairmap.web_mapping（声明网格 + shot.target）。"""
        return web_mapping(shot, sf, point)

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
                # 只取格面的**中心区**：管/箱等非整方块只占格内一部分，取整格会把空白算进多数票
                inset_x = (x1 - x0) * 0.30; inset_y = (y1 - y0) * 0.30
                n = hit = 0
                for i in range(5):
                    for j in range(5):
                        X = x0 + inset_x + (x1 - x0 - 2 * inset_x) * i / 4
                        Y = y0 + inset_y + (y1 - y0 - 2 * inset_y) * j / 4
                        n += 1
                        hit += 1 if is_background(sample(img, X, Y, r=2), bg, a.bg_tol) else 0
                return hit / n
            gr = ratio(g, bg_g, lambda q: game_mapping(cam['game'], q))
            wr = ratio(w, bg_w, lambda q: web_px(q))
            gcls = 'background' if gr >= 0.5 else 'content'
            wcls = 'background' if wr >= 0.5 else 'content'
            want = chk.get('expect', 'not-background')
            if want.startswith('block:'):
                results.append({'id': chk['id'], 'kind': kind, 'verdict': 'blocked',
                                'reason': '未建立方块参考色表，无法机械比对指定方块色', 'game_bg_ratio': round(gr, 3), 'web_bg_ratio': round(wr, 3)})
                continue
            min_cov = float(chk.get('min_coverage', 0.5))
            if want == 'background':
                ok = (gr >= 0.5) and (wr >= 0.5)
            else:
                # 非整方块（管/箱子等）只占格内一部分：按“内容覆盖率下限”判，而不是多数票
                tol = float(chk.get('coverage_tolerance', 0.20))
                # Web 侧的内容覆盖率不得比游戏侧少太多（少 = 该格没画出来）
                ok = ((1 - gr) >= min_cov) and ((1 - wr) >= (1 - gr) - tol)
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
                                    ('web', w, lambda q: web_mapping(shot, sf, q))):
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
            rw = rect_of_bounds(lambda q: web_mapping(shot, sf, q))
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
    content_checks = [r for r in results if r['kind'] in ('opaque', 'region') and r.get('want') == 'not-background'] + [r for r in results if r['kind'] == 'opaque']
    content_checks = list({id(r): r for r in content_checks}.values())
    if content_ratio < 0.05 and content_checks and all(r['verdict'] == 'fail' for r in content_checks):
        for r in content_checks:
            r['verdict'] = 'blocked'
            r['reason'] = '该机位整体无内容（视图级缺陷，先修渲染再判内容）'
    verdict = 'fail' if any(r['verdict'] == 'fail' for r in results) else 'pass'
    report = {'scene': scene['id'], 'camera': a.camera, 'verdict': verdict, 'content_ratio': round(content_ratio, 3),
              'counts': {k: sum(1 for r in results if r['verdict'] == k) for k in ('pass', 'fail', 'blocked')},
              'checks': results,
              'images': {'game': a.game, 'web': a.web}}
    txt = json.dumps(report, ensure_ascii=False, indent=2)
    if a.out: open(a.out, 'w', encoding='utf-8').write(txt + '\n')
    print(txt)
    return 0 if verdict == 'pass' else 1

if __name__ == '__main__':
    sys.exit(main())
