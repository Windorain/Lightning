package com.lightning.mod.client.controlplane.core;

import java.util.ArrayList;
import java.util.List;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;

/**
 * {@code cameras} 段（机位表）的解析工具（contract.md §9 第 9 条）。
 *
 * <p>
 * 单独放在这里的理由：{@code case.validate} 的校验路径（{@link CaseValidator}）、
 * {@code case.run} 的 cameras 段、{@code shot.multi} 动作参数三条入口必须<b>共用同一份</b>
 * 解析与校验，否则「校验通过但执行报错」这类不一致会随时长出来。
 *
 * <p>
 * 三段输入形态共用同一实现：形状归一后逐条走 {@link CameraSpec#parse(JsonObject, String, Fields, List)}。
 */
public final class CameraSpecs {

    private CameraSpecs() {}

    /** 机位数量上限（防一次动作产出成百上千张图）。 */
    public static final int MAX_CAMERAS = 64;

    /** 逐条解析结果 + 累计字段错误。 */
    public static final class Parsed {

        private final List<CameraSpec> specs = new ArrayList<CameraSpec>();
        private final Fields fields = new Fields();

        /** 解析成功的机位（有错误的条目不在其中）。 */
        public List<CameraSpec> specs() {
            return specs;
        }

        /** 累计的字段错误。 */
        public Fields fields() {
            return fields;
        }

        /** 是否有字段级错误。 */
        public boolean hasErrors() {
            return !fields.isEmpty();
        }

        /** 有错误即抛 {@code CP-VALID-002}（{@code context.fields} 全部列出）。 */
        public Parsed throwIfAny(String message) {
            fields.throwIfAny(message);
            return this;
        }
    }

    /**
     * 解析机位表（{@code cameras} 数组形态）。
     *
     * @param array 机位数组；null 或空数组返回空结果（合法：不产截图）
     * @param field 字段前缀（{@code cameras}）
     */
    public static Parsed parseArray(JsonArray array, String field) {
        Parsed p = new Parsed();
        if (array == null || array.size() == 0) {
            return p;
        }
        if (array.size() > MAX_CAMERAS) {
            p.fields.add(field, "机位数不得超过 " + MAX_CAMERAS + "，收到 " + array.size());
            return p;
        }
        for (int i = 0; i < array.size(); i++) {
            String ctx = field + "[" + i + "]";
            JsonElement e = array.get(i);
            if (e == null || !e.isJsonObject()) {
                p.fields.add(ctx, "机位须为 object（CameraSpec，见 contract.md §9 第 9 条）");
                continue;
            }
            CameraSpec spec = CameraSpec.parse(e.getAsJsonObject(), ctx, p.fields, new ArrayList<String>());
            p.specs.add(spec);
        }
        CameraSpec.checkUniqueNames(p.specs, field, p.fields);
        return p;
    }

    /**
     * 解析 {@code shot.multi} 的机位入参：接受 {@code cameras:[CameraSpec]} 单对象形态。
     *
     * <p>
     * {@code cameras} 是对象时按单机位处理（调用方不用为「只拍一张」套一层数组），
     * 但字段错误的前缀仍是 {@code cameras}，与数组口径一致。
     */
    public static Parsed parseParam(JsonObject host, String key) {
        Parsed p = new Parsed();
        JsonElement e = Json.get(host, key);
        if (e == null) {
            p.fields.add(key, "必填：机位数组 [CameraSpec]，或单个 CameraSpec 对象");
            return p;
        }
        if (e.isJsonArray()) {
            return parseArray(e.getAsJsonArray(), key);
        }
        if (e.isJsonObject()) {
            CameraSpec spec = CameraSpec.parse(e.getAsJsonObject(), key, p.fields, new ArrayList<String>());
            p.specs.add(spec);
            return p;
        }
        p.fields.add(key, "须为数组或对象（CameraSpec）");
        return p;
    }

    /** 逐机位 JSON（无会话默认值）。 */
    public static JsonArray toJson(List<CameraSpec> specs) {
        JsonArray a = new JsonArray();
        for (CameraSpec s : specs) {
            a.add(s.toJson());
        }
        return a;
    }

    /**
     * 解析机位级/会话级的光照与渲染模式实际取值（contract.md §9 第 6 条）。
     *
     * <p>
     * 机位覆盖会话默认；两者都没有则用契约默认（{@code natural} / {@code 本色}）。
     * 「实际用了哪个」必须落 {@code shots/<name>.meta.json}——观测记录的可解释性靠它。
     */
    public static String resolveRenderMode(CameraSpec spec, CaptureSpec capture) {
        if (spec != null && spec.renderMode() != null
            && !spec.renderMode()
                .trim()
                .isEmpty()) {
            return spec.renderMode()
                .trim();
        }
        String mode = capture == null ? null : capture.renderMode();
        return mode == null ? CaptureSpec.RENDER_MODE_NATIVE : mode;
    }

    /** 见 {@link #resolveRenderMode}。 */
    public static String resolveLighting(CameraSpec spec, CaptureSpec capture) {
        if (spec != null && spec.lighting() != null
            && !spec.lighting()
                .trim()
                .isEmpty()) {
            return spec.lighting()
                .trim();
        }
        String lighting = capture == null ? null : capture.lighting();
        return lighting == null ? CaptureSpec.LIGHTING_NATURAL : lighting;
    }

    /**
     * 观测记录 {@code observation.cameras[]} 的摘要形态（observation-record.md §2 第 4 条）。
     *
     * <p>
     * 逐机位的<b>实际</b> renderMode/lighting/worldTime 不在这里：它们落
     * {@code shots/<name>.meta.json}（schema {@code lightning.shot-meta/1}），本数组只做会话摘要。
     */
    public static JsonObject summary(CameraSpec spec) {
        JsonObject o = new JsonObject();
        o.addProperty("name", spec.name());
        double[] pos = spec.pos();
        JsonArray p = new JsonArray();
        Json.add(p, Double.valueOf(pos[0]));
        Json.add(p, Double.valueOf(pos[1]));
        Json.add(p, Double.valueOf(pos[2]));
        o.add("pos", p);
        o.addProperty("yaw", Double.valueOf(spec.yaw()));
        o.addProperty("pitch", Double.valueOf(spec.pitch()));
        JsonObject proj = new JsonObject();
        proj.addProperty("type", spec.projection());
        if (spec.isOrtho()) {
            proj.addProperty("orthoHeight", Double.valueOf(spec.orthoHeight()));
        } else {
            proj.addProperty("fov", Double.valueOf(spec.fov()));
        }
        o.add("projection", proj);
        JsonArray res = new JsonArray();
        Json.add(res, Integer.valueOf(spec.width()));
        Json.add(res, Integer.valueOf(spec.height()));
        o.add("resolution", res);
        if (spec.tiled()) {
            JsonObject t = new JsonObject();
            t.addProperty("cols", spec.tileCols());
            t.addProperty("rows", spec.tileRows());
            t.addProperty("overlap", Double.valueOf(spec.tileOverlap()));
            o.add("tile", t);
        }
        return o;
    }

    /** 机位摘要数组。 */
    public static JsonArray summaries(List<CameraSpec> specs) {
        JsonArray a = new JsonArray();
        for (CameraSpec s : specs) {
            a.add(summary(s));
        }
        return a;
    }
}
