package com.lightning.mod.client.controlplane.mc.export;

import java.util.List;
import java.util.Map;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonPrimitive;
import com.lightning.mod.client.controlplane.core.ActionContext;
import com.lightning.mod.client.controlplane.core.CpException;
import com.lightning.mod.client.controlplane.core.ErrorCodes;
import com.lightning.mod.client.controlplane.core.EventStream;
import com.lightning.mod.client.controlplane.core.Fields;
import com.lightning.mod.client.controlplane.core.Json;
import com.lightning.mod.core.session.ExportSceneWriter;
import com.lightning.mod.core.session.ExportSession;

/**
 * 导出族（{@code export.*}，Gitea #102）共用的解析、校验与序列化原语。
 *
 * <h2>为什么独立成类</h2>
 *
 * 三个动作（{@code export.scene} / {@code export.registry} / {@code export.multiblock}）共享四件东西：
 * 参数形态校验（形态/预算/文件名）、帧号与哈希的序列化口径、选区序列化、预算错误的 {@code context} 骨架。
 * 复制三份会让「同一个量在两处读法不同」这种最难的缺陷有藏身之处——尤其预算口径，
 * 它必须与自述里的默认值<b>逐字一致</b>（D3 默认值可见），而默认值只有一份常量。
 */
public final class ExportSceneSupport {

    /** 结果 schema。 */
    public static final String SCHEMA_RESULT = "lightning.cp-export-scene/1";

    /** 注册表导出结果 schema。 */
    public static final String SCHEMA_REGISTRY_RESULT = "lightning.cp-export-registry/1";

    /** 数据集导出结果 schema。 */
    public static final String SCHEMA_MULTIBLOCK_RESULT = "lightning.cp-export-multiblock/1";

    /** 事件 kind：导出族调用。 */
    public static final String KIND_EXPORT = "cp-export";

    /** 文件名安全上限（防路径过长与误把路径塞进 name）。 */
    public static final int MAX_NAME_LENGTH = 96;

    private ExportSceneSupport() {}

    // ------------------------------------------------------------ 参数

    /**
     * 解析产物形态（{@code shape} 参数）。
     *
     * @param def 未给参数时的默认形态
     * @throws CpException CP-VALID-002：取值非法（逐字段 + choices）
     */
    public static ExportSceneWriter.Shape parseShape(ActionContext ctx, ExportSceneWriter.Shape def) {
        String s = ctx.optString("shape", null);
        if (s == null || s.trim()
            .isEmpty()) {
            return def;
        }
        ExportSceneWriter.Shape parsed = ExportSceneWriter.Shape.parse(s);
        if (parsed == null) {
            throw CpException.param(
                "shape 取值非法",
                "shape",
                "合法取值 " + ExportSceneWriter.Shape.choices() + "（默认 " + def.id() + "），收到 \"" + s + "\"");
        }
        return parsed;
    }

    /**
     * 文件名净化：只保留 {@code [A-Za-z0-9._-]}，其余替换为 {@code -}。
     *
     * <p>
     * 净化而不是报错：文件名来自 {@code /sde setname} 或参数，调用方常见做法是写中文或带空格的展示名；
     * 直接报错会让「本来能导出的场景」失败。但净化后的结果会<b>如实出现在结果与产物路径里</b>
     * （{@code name} 字段回显净化后的值），调用方不会以为写的是别的名字。
     */
    public static String safeName(String raw) {
        String s = raw == null ? "" : raw.trim();
        if (s.isEmpty()) {
            s = "export";
        }
        if (s.length() > MAX_NAME_LENGTH) {
            s = s.substring(0, MAX_NAME_LENGTH);
        }
        StringBuilder sb = new StringBuilder(s.length());
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            boolean ok = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')
                || (c >= '0' && c <= '9')
                || c == '.'
                || c == '_'
                || c == '-';
            sb.append(ok ? c : '-');
        }
        String out = sb.toString();
        // 防「..」与空串
        while (out.startsWith(".")) {
            out = out.substring(1);
        }
        return out.isEmpty() ? "export" : out;
    }

    /** 整数预算参数：非法或超天花板一律 CP-VALID-002（不静默钳到上限）。 */
    public static int requireBudget(ActionContext ctx, String field, int def, int hard) {
        JsonElement e = ctx.param(field);
        if (e == null || e.isJsonNull()) {
            return def;
        }
        if (!e.isJsonPrimitive() || !e.getAsJsonPrimitive()
            .isNumber()) {
            throw CpException.param("预算参数类型不符", field, "须为整数（默认 " + def + "）");
        }
        int v = e.getAsInt();
        if (v <= 0) {
            throw CpException.param("预算参数非法", field, "须为正整数（默认 " + def + "），收到 " + v);
        }
        if (v > hard) {
            throw CpException.param("预算参数超出绝对上限", field, "上限 " + hard + "（收到 " + v + "）；更高的值会把堆打爆，本动作不提供");
        }
        return v;
    }

    /** 长整数预算参数（同 {@link #requireBudget}）。 */
    public static long requireBudgetLong(ActionContext ctx, String field, long def, long hard) {
        JsonElement e = ctx.param(field);
        if (e == null || e.isJsonNull()) {
            return def;
        }
        if (!e.isJsonPrimitive() || !e.getAsJsonPrimitive()
            .isNumber()) {
            throw CpException.param("预算参数类型不符", field, "须为整数（默认 " + def + "）");
        }
        long v = e.getAsLong();
        if (v <= 0) {
            throw CpException.param("预算参数非法", field, "须为正整数（默认 " + def + "），收到 " + v);
        }
        if (v > hard) {
            throw CpException.param("预算参数超出绝对上限", field, "上限 " + hard + "（收到 " + v + "）");
        }
        return v;
    }

    // ------------------------------------------------------------ 预算

    /** 选区体积（闭区间方块数）；选区不完整返回 0。 */
    public static long volumeOf(ExportSession.Snapshot s) {
        if (s == null || !s.selectionComplete()) {
            return 0L;
        }
        long dx = Math.abs((long) s.pos1x() - (long) s.pos2x()) + 1L;
        long dy = Math.abs((long) s.pos1y() - (long) s.pos2y()) + 1L;
        long dz = Math.abs((long) s.pos1z() - (long) s.pos2z()) + 1L;
        return dx * dy * dz;
    }

    /** 选区尺寸文本（错误上下文用）。 */
    public static String sizeText(ExportSession.Snapshot s) {
        if (s == null || !s.selectionComplete()) {
            return "incomplete";
        }
        return (Math.abs(s.pos1x() - s.pos2x()) + 1) + "x"
            + (Math.abs(s.pos1y() - s.pos2y()) + 1)
            + "x"
            + (Math.abs(s.pos1z() - s.pos2z()) + 1);
    }

    /**
     * 预算超限的 {@code context}（C6：错误码 + 上下文，不静默截断）。
     *
     * <p>
     * 上下文刻意包含<b>预算值本身与推算方式</b>（{@code volumePerFrame} × {@code frames} = {@code volumeTotal}），
     * 因为「超了多少」与「怎么算出来的」是两件事：前者让调用方知道该缩多少，后者让它能自己复算
     * （#96 §10-D2「可复算」的精神同样适用于错误上下文）。
     */
    public static JsonObject budgetContext(String field, int frames, int maxFrames, long perFrame, long total,
        long maxCells) {
        JsonObject c = Json.object(
            "action",
            field,
            "frames",
            Integer.valueOf(frames),
            "maxFrames",
            Integer.valueOf(maxFrames),
            "volumePerFrame",
            Long.valueOf(perFrame),
            "volumeTotal",
            Long.valueOf(total),
            "maxCells",
            Long.valueOf(maxCells),
            "computed",
            "volumePerFrame = sizeX × sizeY × sizeZ（闭区间方块数）；volumeTotal = volumePerFrame × frames");
        Fields f = new Fields();
        if (frames > maxFrames) {
            f.add("frames", "实际 " + frames + " 帧 > 上限 " + maxFrames + "（不静默截断）");
        }
        if (perFrame > maxCells) {
            f.add("maxCells", "单帧 " + perFrame + " 格 > 上限 " + maxCells + "（选区 " + perFrame + " 格）");
        }
        if (total > maxCells) {
            f.add("maxCells", "预计总量 " + total + " 格 > 上限 " + maxCells + "（" + perFrame + " × " + frames + "）");
        }
        c.add("fields", f.toJson());
        return c;
    }

    // ------------------------------------------------------------ 帧与哈希

    /** 帧号数组（升序）。 */
    public static JsonArray frameList(Map<Integer, String> frames) {
        JsonArray a = new JsonArray();
        if (frames == null) {
            return a;
        }
        for (Integer f : frames.keySet()) {
            a.add(new JsonPrimitive(f));
        }
        return a;
    }

    /** 帧号数组（来自快照，保持原序）。 */
    public static JsonArray frameList(int[] frames) {
        JsonArray a = new JsonArray();
        if (frames != null) {
            for (int f : frames) {
                a.add(new JsonPrimitive(Integer.valueOf(f)));
            }
        }
        return a;
    }

    /** 已录帧号数组（快照口径）。 */
    public static JsonArray frameList(ExportSession.Snapshot s) {
        return frameList(s == null ? null : s.recordedFrames());
    }

    /** 只保留选中帧的「帧号 → 内容哈希」对象（与 {@code export.session.frameSha256} 同源）。 */
    public static JsonObject hashArray(ExportSession.Snapshot snap, Map<Integer, String> frames) {
        JsonObject o = new JsonObject();
        if (snap == null || frames == null) {
            return o;
        }
        int[] arr = snap.recordedFrames();
        String[] hashes = snap.frameSha256();
        int n = Math.min(arr.length, hashes.length);
        for (int i = 0; i < n; i++) {
            if (frames.containsKey(Integer.valueOf(arr[i]))) {
                o.addProperty(Integer.toString(arr[i]), hashes[i]);
            }
        }
        return o;
    }

    // ------------------------------------------------------------ 选区

    /** 选区对象（与 {@code export.session.selection} 同形；供溯源与结果引用）。 */
    public static JsonObject selectionJson(ExportSession.Snapshot s) {
        JsonObject sel = new JsonObject();
        if (s == null) {
            sel.addProperty("complete", false);
            return sel;
        }
        sel.addProperty("complete", s.selectionComplete());
        sel.add("pos1", coords(s.pos1x(), s.pos1y(), s.pos1z()));
        sel.add("pos2", coords(s.pos2x(), s.pos2y(), s.pos2z()));
        sel.add("min", coords(min(s.pos1x(), s.pos2x()), min(s.pos1y(), s.pos2y()), min(s.pos1z(), s.pos2z())));
        sel.add("max", coords(max(s.pos1x(), s.pos2x()), max(s.pos1y(), s.pos2y()), max(s.pos1z(), s.pos2z())));
        if (s.selectionComplete()) {
            sel.addProperty("sizeX", Math.abs(s.pos1x() - s.pos2x()) + 1);
            sel.addProperty("sizeY", Math.abs(s.pos1y() - s.pos2y()) + 1);
            sel.addProperty("sizeZ", Math.abs(s.pos1z() - s.pos2z()) + 1);
        }
        return sel;
    }

    /** 逐帧明细产物的溯源（单帧形态；帧号写进溯源，C3 判据据此发现跨次拼接）。 */
    public static JsonObject frameProvenance(String exportId, int frameIndex, ExportSession.Snapshot s) {
        JsonObject p = ExportSceneWriter.provenance(
            exportId,
            exportId == null || exportId.indexOf('#') < 0 ? null : exportId.substring(0, exportId.indexOf('#')),
            ExportSceneWriter.Shape.STRUCTURE,
            s == null ? 0L : s.bufferGeneration(),
            new int[] { frameIndex },
            new String[] { hashOf(s, frameIndex) },
            s != null && s.inSession(),
            selectionJson(s));
        p.addProperty("frameIndex", frameIndex);
        return p;
    }

    private static String hashOf(ExportSession.Snapshot s, int frameIndex) {
        if (s == null) {
            return null;
        }
        int[] arr = s.recordedFrames();
        String[] hashes = s.frameSha256();
        for (int i = 0; i < arr.length && i < hashes.length; i++) {
            if (arr[i] == frameIndex) {
                return hashes[i];
            }
        }
        return null;
    }

    private static JsonArray coords(Integer x, Integer y, Integer z) {
        if (x == null || y == null || z == null) {
            return null;
        }
        JsonArray a = new JsonArray();
        a.add(new JsonPrimitive(x));
        a.add(new JsonPrimitive(y));
        a.add(new JsonPrimitive(z));
        return a;
    }

    private static Integer min(Integer a, Integer b) {
        return a == null || b == null ? null : Integer.valueOf(Math.min(a, b));
    }

    private static Integer max(Integer a, Integer b) {
        return a == null || b == null ? null : Integer.valueOf(Math.max(a, b));
    }

    // ------------------------------------------------------------ expectFrames（C3）

    /**
     * 校验 {@code expectFrames}（C3「同会话同缓冲」的调用方侧判据）。
     *
     * <p>
     * 语义：调用方<b>显式声明</b>「这次导出应当包含哪些帧」。不符即 {@code CP-STATE-001}——
     * 它拦的正是跨会话拼接：动作 A 录了 F0..F2，动作 B 又录了 F9，B 导出时缓冲里是 F0..F2+F9，
     * 若调用方声明 {@code expectFrames:[0,1,2]}，这次导出会<b>当场判红</b>而不是静默产出一份拼接物。
     *
     * <p>
     * 形态：{@code {frames:[int...], requireSameSession?:bool}} 或裸数组 {@code [int...]}。
     */
    public static void assertExpectFrames(JsonObject param, Map<Integer, String> selected) {
        if (param == null || Json.size(param) == 0) {
            return;
        }
        JsonArray want = Json.optArray(param, "frames");
        if (want == null) {
            throw CpException.param("expectFrames 形态非法", "expectFrames", "须为 {frames:[int...]} 或 [int...]（见自述）");
        }
        java.util.Set<Integer> got = new java.util.TreeSet<Integer>(selected.keySet());
        java.util.Set<Integer> expect = new java.util.TreeSet<Integer>();
        Fields fields = new Fields();
        for (int i = 0; i < want.size(); i++) {
            JsonElement e = want.get(i);
            if (e == null || !e.isJsonPrimitive()
                || !e.getAsJsonPrimitive()
                    .isNumber()) {
                fields.add("expectFrames.frames[" + i + "]", "须为整数帧号");
                continue;
            }
            expect.add(Integer.valueOf(e.getAsInt()));
        }
        fields.throwIfAny("expectFrames 参数非法");
        if (!expect.equals(got)) {
            throw new CpException(
                ErrorCodes.STATE,
                "帧集与 expectFrames 不符：声明 " + expect + "，实际 " + got + "（C3 判据：多帧必须落在同一会话同一缓冲内，跨会话拼接不算合法产物）",
                Json.object(
                    "action",
                    "export.scene",
                    "expected",
                    intArray(expect),
                    "actual",
                    intArray(got),
                    "extra",
                    intArray(diff(got, expect)),
                    "missing",
                    intArray(diff(expect, got)),
                    "hint",
                    "要导出缓冲内的全部帧请省略 expectFrames；要显式限定帧集请用 frames:[...] 并把 expectFrames 与它对齐"));
        }
    }

    private static JsonArray intArray(java.util.Collection<Integer> c) {
        JsonArray a = new JsonArray();
        for (Integer v : c) {
            a.add(new JsonPrimitive(v));
        }
        return a;
    }

    private static java.util.Set<Integer> diff(java.util.Set<Integer> a, java.util.Set<Integer> b) {
        java.util.Set<Integer> out = new java.util.TreeSet<Integer>(a);
        out.removeAll(b);
        return out;
    }

    // ------------------------------------------------------------ 杂项

    /** 事件级别常量转发（避免动作实现直接依赖 EventStream 的内部常量名）。 */
    public static final String LEVEL_INFO = EventStream.LEVEL_INFO;

    /** 帧数文本（诊断用）。 */
    public static String describe(List<Integer> frames) {
        return frames == null ? "[]" : frames.toString();
    }
}
