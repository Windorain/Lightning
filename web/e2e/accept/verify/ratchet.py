#!/usr/bin/env python3
"""棘轮检查：当前产物与基线比，漂移超阈值即 fail（并给出数值）。"""
import argparse, hashlib, json, os, sys
from PIL import Image, ImageChops, ImageStat

def sha(p):
    h = hashlib.sha256()
    h.update(open(p, 'rb').read())
    return h.hexdigest()

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--scene', required=True); ap.add_argument('--camera', required=True)
    ap.add_argument('--game', required=True); ap.add_argument('--web', required=True)
    ap.add_argument('--report', default=None)
    ap.add_argument('--max-mean-diff', type=float, default=2.0)
    ap.add_argument('--root', default=None)
    a = ap.parse_args()
    root = a.root or os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
    base = os.path.join(root, 'baselines', a.scene)
    man_path = os.path.join(base, 'manifest.json')
    if not os.path.exists(man_path):
        print(json.dumps({'verdict': 'blocked', 'reason': '没有基线：' + man_path}, ensure_ascii=False)); return 0
    man = json.load(open(man_path, encoding='utf-8'))
    entry = man['cameras'].get(a.camera)
    if not entry:
        print(json.dumps({'verdict': 'blocked', 'reason': '该机位没有基线'}, ensure_ascii=False)); return 0
    out = {'scene': a.scene, 'camera': a.camera, 'checks': []}
    same = 0
    for side, cur in (('game', a.game), ('web', a.web)):
        cur_sha = sha(cur); base_png = os.path.join(base, a.camera, side + '.png')
        base_sha = entry['sha256'][side]
        if cur_sha == base_sha:
            out['checks'].append({'side': side, 'verdict': 'pass', 'mode': 'identical', 'sha256': cur_sha[:12]})
            same += 1
        else:
            im_cur = Image.open(cur).convert('RGB'); im_base = Image.open(base_png).convert('RGB')
            if im_cur.size != im_base.size:
                out['checks'].append({'side': side, 'verdict': 'fail', 'mode': 'size', 'cur': im_cur.size, 'base': im_base.size})
                continue
            diff = ImageChops.difference(im_cur, im_base)
            mean = sum(ImageStat.Stat(diff).mean) / 3
            ok = mean <= a.max_mean_diff
            out['checks'].append({'side': side, 'verdict': 'pass' if ok else 'fail', 'mode': 'diff',
                                  'mean_abs_diff': round(mean, 3), 'threshold': a.max_mean_diff,
                                  'sha256': cur_sha[:12]})
    out['verdict'] = 'fail' if any(c['verdict'] == 'fail' for c in out['checks']) else 'pass'
    print(json.dumps(out, ensure_ascii=False, indent=2))
    return 0 if out['verdict'] == 'pass' else 1

if __name__ == '__main__':
    sys.exit(main())
