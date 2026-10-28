package com.lightning.mod.client.controlplane.core;

import java.util.ArrayList;
import java.util.List;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;

/**
 * {@code capture} 段（捕获会话参数，case-file.md §4 / contract.md §7.3）的零 MC 依赖模型。
 *
 * <p>
 * 语义：本段是 {@code capture.begin}/{@code capture.end} 的包围参数——
 * {@link #lighting()} 与 {@link #renderMode()} 是<b>会话默认</b>，可被逐机位覆盖
 * （{@link CameraSpecs#resolveRenderMode}/{@link CameraSpecs#resolveLighting}）；
 * {@link #worldTime()} 决定拍摄光照基准（{@code <0} 表示不指定、沿用当前世界时刻）。
 *
 * <p>
 * 三个字段全部可空；段本身为空对象也合法（等于「用契约默认值开一次捕获会话」）。
 */
public final class CaptureSpec {

    /** 光照口径：不干预光照管线（默认）。 */
    public static final String LIGHTING_NATURAL = "natural";

    /** 光照口径：注入中性光照使暗部可读（contract.md §9 第 6 条的「豁免一」）。 */
    public static final String LIGHTING_NEUTRAL_FLAT = "neutral-flat";

    /** 渲染模式：本色（默认）。 */
    public static final String RENDER_MODE_NATIVE = "本色";

    /** 渲染模式：参与光照。 */
    public static final String RENDER_MODE_LIT = "参与光照";

    /** 允许的字段。 */
    public static final java.util.Set<String> FIELDS = java.util.Collections.unmodifiableSet(
        new java.util.LinkedHashSet<String>(java.util.Arrays.asList("lighting", "renderMode", "worldTime")));

    /** {@code worldTime} 取值范围（1.7.10 一天 24000 tick）。 */
    public static final long MIN_WORLD_TIME = 0L;

    /** 见 {@link #MIN_WORLD_TIME}。 */
    public static final long MAX_WORLD_TIME = 23999L;

    private final String lighting;
    private final String renderMode;
    private final long worldTime;

    CaptureSpec(String lighting, String renderMode, long worldTime) {
        this.lighting = lighting;
        this.renderMode = renderMode;
        this.worldTime = worldTime;
    }

    /** 会话默认光照口径；未声明返回 null。 */
    public String lighting() {
        return lighting;
    }

    /** 会话默认渲染模式；未声明返回 null。 */
    public String renderMode() {
        return renderMode;
    }

    /** 拍摄光照基准（世界时刻）；未声明返回 -1。 */
    public long worldTime() {
        return worldTime;
    }

    /** 是否指定了拍摄时刻。 */
    public boolean hasWorldTime() {
        return worldTime >= 0L;
    }

    /** 光照口径是否合法。 */
    public static boolean isLighting(String v) {
        if (v == null) {
            return false;
        }
        String s = v.trim();
        return LIGHTING_NATURAL.equals(s) || LIGHTING_NEUTRAL_FLAT.equals(s);
    }

    /** 渲染模式是否合法。 */
    public static boolean isRenderMode(String v) {
        if (v == null) {
            return false;
        }
        String s = v.trim();
        return RENDER_MODE_NATIVE.equals(s) || RENDER_MODE_LIT.equals(s);
    }

    /** 规范化 JSON。 */
    public JsonObject toJson() {
        JsonObject o = new JsonObject();
        if (lighting != null) {
            o.addProperty("lighting", lighting);
        }
        if (renderMode != null) {
            o.addProperty("renderMode", renderMode);
        }
        if (hasWorldTime()) {
            o.addProperty("worldTime", worldTime);
        }
        return o;
    }

    /** 解析（错误累计进 {@code fields}，不抛异常）；{@code json} 为 null 时返回 null。 */
    public static CaptureSpec parse(JsonObject json, String field, Fields fields) {
        if (json == null) {
            return null;
        }
        CameraSpec.checkUnknown(json, FIELDS, field, fields);
        String lighting = CameraSpec.optStringOf(json, "lighting", field + ".lighting", fields);
        if (lighting != null && !lighting.trim()
            .isEmpty() && !isLighting(lighting)) {
            fields
                .add(field + ".lighting", "须为 " + LIGHTING_NATURAL + " 或 " + LIGHTING_NEUTRAL_FLAT + "，收到 " + lighting);
        }
        String renderMode = CameraSpec.optStringOf(json, "renderMode", field + ".renderMode", fields);
        if (renderMode != null && !renderMode.trim()
            .isEmpty() && !isRenderMode(renderMode)) {
            fields
                .add(field + ".renderMode", "须为 " + RENDER_MODE_NATIVE + " 或 " + RENDER_MODE_LIT + "，收到 " + renderMode);
        }
        long worldTime = -1L;
        JsonElement wt = Json.get(json, "worldTime");
        if (wt != null) {
            if (!CameraSpec.isIntegral(wt) || !CameraSpec.isFinite(wt)) {
                fields.add(field + ".worldTime", "须为整数（1.7.10 一天 0.." + MAX_WORLD_TIME + " tick）");
            } else {
                long v = wt.getAsLong();
                if (v < MIN_WORLD_TIME || v > MAX_WORLD_TIME) {
                    fields.add(field + ".worldTime", "须在 " + MIN_WORLD_TIME + ".." + MAX_WORLD_TIME + "，收到 " + v);
                } else {
                    worldTime = v;
                }
            }
        }
        return new CaptureSpec(
            lighting == null || lighting.trim()
                .isEmpty() ? null : lighting.trim(),
            renderMode == null || renderMode.trim()
                .isEmpty() ? null : renderMode.trim(),
            worldTime);
    }

    /** 解析并抛错（{@code case.validate} 之外的调用方用）。 */
    public static CaptureSpec parseOrThrow(JsonObject json, String field) {
        Fields fields = new Fields();
        CaptureSpec spec = parse(json, field, fields);
        fields.throwIfAny("capture 段非法（" + fields.size() + " 处）");
        return spec;
    }

    /** 空会话默认（无任何声明）。 */
    public static CaptureSpec empty() {
        return new CaptureSpec(null, null, -1L);
    }

    /** 供校验器累计多字段错误的空列表（避免调用方各自 new）。 */
    static List<String> warnings() {
        return new ArrayList<String>();
    }
}
