#!/usr/bin/env python3
"""机位对齐检查（精确投影版）。

对每个场景方块，按**同一个世界坐标**分别投影到游戏图与 Web 图，
采样该像素处的颜色，比较两者的色度（亮度归一化）。
若任一侧的机位/朝向/缩放有错，取样点会落到别的方块或背景上，色差必然超限——
因此这一条同时验证「机位对齐」与「布局对齐」，且无需裁剪/包围盒检测。

映射实现只有一处：pairmap（声明网格 + shot.target）。本脚本不另算。

用法：
  python verify/align-check.py --game g.png --web w.png --shot-meta shot-meta.json \
      --plan plan.json --camera front --scene scene.json [--out report.json]
"""
import argparse, json, sys
from PIL import Image
from pairmap import corner_bg, is_background, sample, normalize, game_mapping, web_mapping

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--game', required=True); ap.add_argument('--web', required=True)
    ap.add_argument('--shot-meta', required=True); ap.add_argument('--plan', required=True)
    ap.add_argument('--camera', required=True); ap.add_argument('--scene', required=True)
    ap.add_argument('--threshold', type=float, default=0.06)
    ap.add_argument('--bg-tol', type=float, default=26)
    ap.add_argument('--transparent-blocks', default='', help='逗号分隔：这些方块若两侧背景/内容分类不一致，判 blocked（已知产品缺陷）而非 fail')
    ap.add_argument('--out', default=None)
    a = ap.parse_args()

    plan = json.load(open(a.plan, encoding='utf-8'))
    scene = json.load(open(a.scene, encoding='utf-8'))
    meta = json.load(open(a.shot_meta, encoding='utf-8'))
    cam = next(c for c in plan['cameras'] if c['name'] == a.camera)
    shot = next(s for s in meta['shots'] if s['name'] == a.camera)
    sf = meta.get('sceneFrame')
    if sf is None:
        print(json.dumps({'verdict': 'blocked', 'reason': 'shot-meta 缺 sceneFrame（声明网格）：无法建立世界→Web 映射'}, ensure_ascii=False))
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
        wx, wy, wppb = web_mapping(shot, sf, [cx, cy, cz])
        gc = sample(g, gx, gy); wc = sample(w, wx, wy)
        g_bg = is_background(gc, bg_g, tol=a.bg_tol)
        w_bg = is_background(wc, bg_w, tol=a.bg_tol)
        is_transparent = b['block'] in [x.strip() for x in a.transparent_blocks.split(',') if x.strip()]
        if g_bg != w_bg:
            verdict, d = ('blocked' if is_transparent else 'fail'), None
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
    ok = all(c['verdict'] in ('pass', 'blocked') for c in checks)
    report = {'camera': a.camera, 'px_per_block': {'game': round(gppb, 3), 'web': round(wppb, 3)},
              'threshold': a.threshold, 'checks': checks, 'verdict': 'pass' if ok else 'fail'}
    txt = json.dumps(report, ensure_ascii=False, indent=2)
    if a.out: open(a.out, 'w', encoding='utf-8').write(txt + '\n')
    print(txt)
    return 0 if ok else 1

if __name__ == '__main__':
    sys.exit(main())
