"""两侧图像的世界→像素映射与采样（判据执行器与对齐检查共用，唯一实现）。

对齐口径（两侧必须瞄同一个世界点）：
  - 游戏侧：机位 = 世界坐标；像素 = 正交投影。
  - Web 侧：内核把**声明网格**居中 ⇒ 世界点 − 网格中心 = 局部坐标；
    机位 target 是**局部**目标点（= 世界内容中心 − 网格中心），由 shot-meta 记录。

任何脚本不得另算映射；缺 sceneFrame/target 一律报错，不许退化成"渲染出来的包围盒"。
"""
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

def grid_center(scene_frame):
    """声明网格中心（世界坐标）。内核把网格居中 ⇒ 该点落在 Web 局部原点。"""
    if not scene_frame or 'min' not in scene_frame or 'size' not in scene_frame:
        raise ValueError('缺声明网格 sceneFrame{min,size}：无法建立世界→Web 映射')
    return [scene_frame['min'][i] + scene_frame['size'][i] / 2 for i in range(3)]

def web_camera(shot):
    """Web 机位：target 为局部目标点，机位 = target + 方向×距离。"""
    t = shot.get('target')
    if isinstance(t, dict):
        t = [t['x'], t['y'], t['z']]
    if not t:
        raise ValueError('shot 缺 target（局部目标点）：无法建立世界→Web 映射')
    yaw = math.radians(shot['web']['yawDeg']); elev = math.radians(shot['web']['elevationDeg'])
    d = [math.sin(yaw)*math.cos(elev), math.sin(elev), math.cos(yaw)*math.cos(elev)]
    pos = [t[i] + d[i]*shot['web']['distance'] for i in range(3)]
    return t, pos, d

def web_mapping(shot, scene_frame, point):
    """世界点 → Web 图像像素。平移来自**声明网格**，目标来自 shot.target。"""
    off = grid_center(scene_frame)
    local = [point[i] - off[i] for i in range(3)]
    t, cam_pos, _ = web_camera(shot)
    forward = norm3([t[i] - cam_pos[i] for i in range(3)])
    right = cross(forward, [0, 1, 0])
    if math.sqrt(sum(v*v for v in right)) < 1e-6:   # 俯视/仰视：右向退化，取 +x
        right = [1.0, 0.0, 0.0]
    right = norm3(right)
    up = cross(right, forward)
    rel = [local[i] - cam_pos[i] for i in range(3)]
    ppb = shot['canvas']['height'] * shot['zoom'] / 10
    W, H = shot['canvas']['width'], shot['canvas']['height']
    return (W/2 + dot(rel, right)*ppb, H/2 - dot(rel, up)*ppb, ppb)
