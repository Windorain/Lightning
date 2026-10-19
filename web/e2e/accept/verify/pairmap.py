"""两侧图像的世界→像素映射与采样（判据执行器与对齐检查共用）。"""
import math

def cross(a, b):
    return [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]]

def norm3(v):
    l = math.sqrt(sum(x*x for x in v)) or 1.0
    return [x / l for x in v]

def dot(a, b):
    return sum(x*y for x, y in zip(a, b))

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

def sample(im, x, y, r=5):
    px = im.load(); w, h = im.size
    acc = [0.0, 0.0, 0.0]; n = 0
    for yy in range(max(0, int(y) - r), min(h, int(y) + r + 1)):
        for xx in range(max(0, int(x) - r), min(w, int(x) + r + 1)):
            c = px[xx, yy]; acc[0] += c[0]; acc[1] += c[1]; acc[2] += c[2]; n += 1
    return (0.0, 0.0, 0.0) if n == 0 else tuple(v / n for v in acc)

def normalize(v):
    s = sum(v) or 1.0
    return tuple(x / s for x in v)

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
    off = [web['targetWorld'][i] - lc[i] for i in range(3)]
    pl = [point[i] - off[i] for i in range(3)]
    rel = [pl[i] - cam_pos[i] for i in range(3)]
    ppb = H * zoom / 10
    return (W/2 + dot(rel, right)*ppb, H/2 - dot(rel, up)*ppb, ppb)
