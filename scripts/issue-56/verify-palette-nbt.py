#!/usr/bin/env python3
# Gitea issue #56 验证工具：palette nbt ↔ 扫描档 tileNbtB64 ground truth 逐键比对。
#
# 用法:
#   python verify-palette-nbt.py <fixoff-scan.json> <fixon-baked-a.json> [fixon-baked-b.json]
#
# 断言:
#   1. fixoff 档 geometryPhase == "scan"（修复前导出中止的现场: 产物未被烘焙件覆盖）；
#   2. 每个 fixon 档 geometryPhase == "baked"；
#   3. fixon blockPalette 中每个带 nbt 的条目, 其 nbt 与 fixoff 扫描档同 registryId+meta(+facing)
#      的 cellType 的 tileNbtB64 解码结果逐键一致（防 catch(Throwable) 放宽后静默丢字段）;
#   4. fixon blockPalette 至少有一条带 nbt 的条目（断言不空转）;
#   5. 若给 B 档: A/B 逐字节相同（幂等）。
# 退出码: 0 全绿; 1 有失败。
import base64
import gzip
import json
import struct
import sys

def mutf8(b):
    # NBT 字符串是 Java Modified UTF-8：U+0000 编为 C0 80、增补字符编为代理对两段 3 字节。
    # 先还原 null，再用 surrogatepass 解出 lone surrogates，最后合并代理对。
    s = b.replace(b"\xc0\x80", b"\x00").decode("utf-8", "surrogatepass")
    out = []
    k = 0
    while k < len(s):
        c = ord(s[k])
        if 0xD800 <= c <= 0xDBFF and k + 1 < len(s):
            c2 = ord(s[k + 1])
            if 0xDC00 <= c2 <= 0xDFFF:
                out.append(chr(0x10000 + ((c - 0xD800) << 10) + (c2 - 0xDC00)))
                k += 2
                continue
        out.append(s[k])
        k += 1
    return "".join(out)

class NbtReader:
    def __init__(self, data):
        self.d = data
        self.i = 0

    def u1(self):
        v = self.d[self.i]
        self.i += 1
        return v

    def read(self, fmt):
        n = struct.calcsize(fmt)
        v = struct.unpack_from(fmt, self.d, self.i)
        self.i += n
        return v if len(v) > 1 else v[0]

    def name(self):
        ln = self.read(">H")
        s = mutf8(self.d[self.i:self.i + ln])
        self.i += ln
        return s

    def payload(self, tid):
        if tid == 1:
            return struct.unpack(">b", bytes([self.u1()]))[0]
        if tid == 2:
            return self.read(">h")
        if tid == 3:
            return self.read(">i")
        if tid == 4:
            return self.read(">q")
        if tid == 5:
            return self.read(">f")
        if tid == 6:
            return self.read(">d")
        if tid == 7:
            n = self.read(">i")
            v = [struct.unpack(">b", bytes([b]))[0] for b in self.d[self.i:self.i + n]]
            self.i += n
            return v
        if tid == 8:
            return self.name()
        if tid == 9:
            et = self.u1()
            n = self.read(">i")
            return [self.payload(et) for _ in range(n)]
        if tid == 10:
            obj = {}
            while True:
                t = self.u1()
                if t == 0:
                    return obj
                nm = self.name()  # 必须先读键：obj[k]=v 形式会先求值 RHS 导致错位
                obj[nm] = self.payload(t)
        if tid == 11:
            n = self.read(">i")
            return [self.read(">i") for _ in range(n)]
        if tid == 12:
            n = self.read(">i")
            return [self.read(">q") for _ in range(n)]
        raise ValueError("unknown tag id %d" % tid)

def decode_tile_nbt(b64):
    raw = gzip.decompress(base64.b64decode(b64))
    r = NbtReader(raw)
    tid = r.u1()
    assert tid == 10, "root must be TAG_Compound"
    r.name()  # root name（空串）
    return r.payload(10)

def close(a, b):
    if isinstance(a, float) or isinstance(b, float):
        try:
            return abs(float(a) - float(b)) < 1e-6
        except (TypeError, ValueError):
            return False
    return a == b

def deep_eq(a, b, path, diffs):
    if isinstance(a, dict) and isinstance(b, dict):
        ka, kb = set(a), set(b)
        if ka != kb:
            diffs.append("%s: 键集合不同 仅扫描档有=%s 仅palette有=%s" % (path, sorted(ka - kb), sorted(kb - ka)))
            return
        for k in sorted(ka):
            deep_eq(a[k], b[k], "%s.%s" % (path, k), diffs)
    elif isinstance(a, list) and isinstance(b, list):
        if len(a) != len(b):
            diffs.append("%s: 长度不同 %d vs %d" % (path, len(a), len(b)))
            return
        for idx, (x, y) in enumerate(zip(a, b)):
            deep_eq(x, y, "%s[%d]" % (path, idx), diffs)
    else:
        if not close(a, b):
            diffs.append("%s: 值不同 %r vs %r" % (path, a, b))

def celltype_key(t):
    return (t.get("registryId"), t.get("meta"), t.get("facing") or "")

def palette_key(p):
    return (p.get("registryId"), p.get("meta"), p.get("facing") or "")

def main():
    if len(sys.argv) < 3:
        print(__doc__)
        return 1
    scan_path = sys.argv[1]
    baked_paths = sys.argv[2:]
    failures = []

    with open(scan_path, encoding="utf-8") as f:
        scan = json.load(f)
    phase = scan.get("geometryPhase")
    if phase != "scan":
        failures.append("fixoff 档 geometryPhase=%r（期望 scan：修复前导出应中止、产物不被烘焙覆盖）" % phase)
    else:
        print("OK  fixoff 档 geometryPhase=scan（修复前导出中止现场成立）")

    gt = {}
    for t in scan.get("cellTypes", []):
        if t.get("tileNbtB64"):
            # 同 registryId+meta+facing 的多个 cellType 可各带不同 NBT（如 4 根不同管道），
            # 按键聚成候选列表，后面对 palette 条目做逐一匹配（每候选至多配一次）
            gt.setdefault(celltype_key(t), []).append(decode_tile_nbt(t["tileNbtB64"]))
    print("OK  扫描档 ground truth cellTypes 带 tileNbtB64: %d 条 %s"
          % (sum(len(v) for v in gt.values()), sorted(set(k[0] for k in gt))))

    for bp in baked_paths:
        # 候选消耗按文件重置（A/B 两档各自独立匹配同一 ground truth 池）
        gt_pool = {k: list(v) for k, v in gt.items()}
        with open(bp, encoding="utf-8") as f:
            baked = json.load(f)
        bphase = baked.get("geometryPhase")
        if bphase != "baked":
            failures.append("%s geometryPhase=%r（期望 baked）" % (bp, bphase))
            continue
        print("OK  %s geometryPhase=baked" % bp)
        nbt_entries = [p for p in baked.get("blockPalette", []) if "nbt" in p]
        if not nbt_entries:
            failures.append("%s blockPalette 无任何带 nbt 的条目（断言空转）" % bp)
            continue
        for p in nbt_entries:
            k = palette_key(p)
            cands = gt_pool.get(k)
            if not cands:
                failures.append("%s palette 条目 %s 在扫描档找不到 ground truth" % (bp, k))
                continue
            best = None
            for cand in cands:
                diffs = []
                deep_eq(cand, p["nbt"], "nbt", diffs)
                if not diffs:
                    best = cand
                    break
                if best is None or len(diffs) < len(best[1]):
                    best = (cand, diffs)
            if best is not None and not isinstance(best, tuple):
                cands.remove(best)
                print("OK  %s palette %s nbt 与 ground truth 逐键一致（%d 键）" % (bp, k, len(best)))
            else:
                failures.append("%s palette %s nbt 与全部 %d 个 ground truth 候选都不一致，最接近者差异:\n    %s"
                                % (bp, k, len(cands), "\n    ".join(best[1][:20])))

    if len(baked_paths) == 2:
        with open(baked_paths[0], "rb") as f:
            a = f.read()
        with open(baked_paths[1], "rb") as f:
            b = f.read()
        if a == b:
            print("OK  A/B 两次导出逐字节相同（幂等）")
        else:
            failures.append("A/B 两次导出字节不同（幂等失败）")

    if failures:
        print("\nFAIL:")
        for x in failures:
            print("  - " + x)
        return 1
    print("\nALL GREEN")
    return 0

if __name__ == "__main__":
    sys.exit(main())
