package com.lightning.mod.client.controlplane.core;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;

/**
 * 机位规格 {@code CameraSpec}（contract.md §4.1）的零 MC 依赖模型 + 校验。
 *
 * <p>
 * 字段名/类型/未知字段的口径与 {@link CaseParser} 一致（段内未知字段报错，防笔误静默）；
 * 取值范围在 {@link CameraSpecs} 里与 {@link CaseValidator} 共用同一份判定，因此
 * {@code case.validate} 报的约束与 {@code shot.multi} 执行期受的约束<b>是同一份代码</b>。
 *
 * <p>
 * 坐标用 {@code double}（机位常在方块面/半格上）；投影二选一（{@code perspective}+{@code fov} /
 * {@code ortho}+{@code orthoHeight}），各自的参数必填且不得混用。
 */
public final class CameraSpec {

    /** 机位名合法形态（与用例 id 同形，产物文件名直接用它）。 */
    public static final String NAME_PATTERN = "[a-z0-9][a-z0-9._-]*";

    /** 机位名长度上限（防路径过长）。 */
    public static final int MAX_NAME_LENGTH = 64;

    /** 透视投影。 */
    public static final String PROJECTION_PERSPECTIVE = "perspective";

    /** 正交投影；{@code orthoHeight} 是视高（方块数），宽按画面宽高比推。 */
    public static final String PROJECTION_ORTHO = "ortho";

    /**
     * fov 下限（度）。原版滑块范围 30..110 只钳制 {@code gameSettings.fovSetting}，而我们的投影覆写
     * 直接写投影矩阵、不经滑块——取证望远镜机位（fov 3~10，K1 门控对照实测需要）合法。下限 5
     * 只挡笔误（0/负值会让投影矩阵退化）。
     */
    public static final double MIN_FOV = 5.0d;

    /** 见 {@link #MIN_FOV}。 */
    public static final double MAX_FOV = 110.0d;

    /** 正交视高下限（方块）：小于 1 几乎只剩一个方块，判为配置错误。 */
    public static final double MIN_ORTHO_HEIGHT = 0.5d;

    /** 正交视高上限（方块）：1.7.10 载入圆半径的量级上限。 */
    public static final double MAX_ORTHO_HEIGHT = 512.0d;

    /** 分辨率单边上限（像素）；再高会顶到 {@code GL_MAX_TEXTURE_SIZE}。 */
    public static final int MAX_RESOLUTION_SIDE = 8192;

    /** 分辨率单边下限。 */
    public static final int MIN_RESOLUTION_SIDE = 16;

    /** 拼接 tile 的数上限（contract §4.1：1..8）。 */
    public static final int MAX_TILE_DIVISIONS = 8;

    /** overlap 上限（contract §4.1：0..0.5）。 */
    public static final double MAX_OVERLAP = 0.5d;

    /** 机位名（产物文件名 {@code shots/<name>.png}）。 */
    private final String name;

    /** 相机世界坐标 {@code [x,y,z]}。 */
    private final double[] pos;

    /** 偏航角（度）。 */
    private final double yaw;

    /** 俯仰角（度）。原样写入 {@code rotationPitch}——MC 语义：正=俯视、负=仰视。 */
    private final double pitch;

    /** {@link #PROJECTION_PERSPECTIVE} 或 {@link #PROJECTION_ORTHO}。 */
    private final String projection;

    /** 透视 FOV（度）；正交机位为 {@link Double#NaN}。 */
    private final double fov;

    /** 正交视高（方块）；透视机位为 {@link Double#NaN}。 */
    private final double orthoHeight;

    /** 输出分辨率 {@code [w,h]}（像素）。 */
    private final int[] resolution;

    /** 超分拼接列数（1 = 不拼接）。 */
    private final int tileCols;

    /** 超分拼接行数（1 = 不拼接）。 */
    private final int tileRows;

    /** 拼接重叠比例（0..0.5），最终取默认 0.05。 */
    private final double tileOverlap;

    /** 机位级 renderMode 覆盖（contract §4.3.6）；未给为 null。 */
    private final String renderMode;

    /** 机位级 lighting 覆盖；未给为 null。 */
    private final String lighting;

    /** 声明值原样（null 表示未声明）；仅用于判重与错误报告，不参与渲染。 */
    private final String declaredName;

    CameraSpec(String name, double[] pos, double yaw, double pitch, String projection, double fov, double orthoHeight,
        int[] resolution, int tileCols, int tileRows, double tileOverlap, String renderMode, String lighting,
        String declaredName) {
        this.declaredName = declaredName;
        this.name = name;
        this.pos = pos.clone();
        this.yaw = yaw;
        this.pitch = pitch;
        this.projection = projection;
        this.fov = fov;
        this.orthoHeight = orthoHeight;
        this.resolution = resolution.clone();
        this.tileCols = tileCols;
        this.tileRows = tileRows;
        this.tileOverlap = tileOverlap;
        this.renderMode = renderMode;
        this.lighting = lighting;
    }

    /** 机位 id。 */
    public String name() {
        return name;
    }

    /** 相机世界坐标（副本）。 */
    public double[] pos() {
        return pos.clone();
    }

    /** 偏航角（度）。 */
    public double yaw() {
        return yaw;
    }

    /** 俯仰角（度）。 */
    public double pitch() {
        return pitch;
    }

    /** {@code perspective} 或 {@code ortho}。 */
    public String projection() {
        return projection;
    }

    /** 是否正交投影。 */
    public boolean isOrtho() {
        return PROJECTION_ORTHO.equals(projection);
    }

    /** 透视 FOV（度）；正交机位为 NaN。 */
    public double fov() {
        return fov;
    }

    /** 正交视高（方块）；透视机位为 NaN。 */
    public double orthoHeight() {
        return orthoHeight;
    }

    /** 输出分辨率 {@code [w,h]}（副本）。 */
    public int[] resolution() {
        return resolution.clone();
    }

    /** 输出宽度（像素）。 */
    public int width() {
        return resolution[0];
    }

    /** 输出高度（像素）。 */
    public int height() {
        return resolution[1];
    }

    /** 拼接列数（≥1）。 */
    public int tileCols() {
        return tileCols;
    }

    /** 拼接行数（≥1）。 */
    public int tileRows() {
        return tileRows;
    }

    /** 拼接重叠比例（0..0.5）。 */
    public double tileOverlap() {
        return tileOverlap;
    }

    /** 是否需要投影偏移拼接（tile 段存在且 &gt;1x1）。 */
    public boolean tiled() {
        return tileCols > 1 || tileRows > 1;
    }

    /** 单 tile 的渲染分辨率 {@code [w,h]}：整除切分，余数留在最后一列/行。 */
    public int[] tileSize(int col, int row) {
        int w = tileSpan(resolution[0], tileCols, col);
        int h = tileSpan(resolution[1], tileRows, row);
        return new int[] { w, h };
    }

    /** 机位级 renderMode；未声明返回 null（用会话默认）。 */
    public String renderMode() {
        return renderMode;
    }

    /** 机位级 lighting；未声明返回 null（用会话默认）。 */
    public String lighting() {
        return lighting;
    }

    /** 该列/行的像素跨度（前 n-1 列/行等分，余数归最后一列/行）。 */
    public static int tileSpan(int total, int divisions, int index) {
        int base = total / divisions;
        return index == divisions - 1 ? total - base * (divisions - 1) : base;
    }

    /** 该列/行在总图中的像素起点。 */
    public static int tileOffset(int total, int divisions, int index) {
        return (total / divisions) * index;
    }

    /** 规范化 JSON（观测记录 {@code cameras[]} 与 {@code shot-meta} 共用）。 */
    public JsonObject toJson() {
        JsonObject o = new JsonObject();
        o.addProperty("name", name);
        JsonArray p = new JsonArray();
        Json.add(p, Double.valueOf(pos[0]));
        Json.add(p, Double.valueOf(pos[1]));
        Json.add(p, Double.valueOf(pos[2]));
        o.add("pos", p);
        o.addProperty("yaw", Double.valueOf(yaw));
        o.addProperty("pitch", Double.valueOf(pitch));
        JsonObject proj = new JsonObject();
        proj.addProperty("type", projection);
        if (isOrtho()) {
            proj.addProperty("orthoHeight", Double.valueOf(orthoHeight));
        } else {
            proj.addProperty("fov", Double.valueOf(fov));
        }
        o.add("projection", proj);
        JsonArray res = new JsonArray();
        Json.add(res, Integer.valueOf(resolution[0]));
        Json.add(res, Integer.valueOf(resolution[1]));
        o.add("resolution", res);
        if (tiled()) {
            JsonObject t = new JsonObject();
            t.addProperty("cols", tileCols);
            t.addProperty("rows", tileRows);
            t.addProperty("overlap", Double.valueOf(tileOverlap));
            o.add("tile", t);
        }
        if (renderMode != null) {
            o.addProperty("renderMode", renderMode);
        }
        if (lighting != null) {
            o.addProperty("lighting", lighting);
        }
        return o;
    }

    // ------------------------------------------------------------ 解析 / 校验

    /** 允许的字段。 */
    public static final Set<String> FIELDS = unmodifiable(
        "name",
        "pos",
        "yaw",
        "pitch",
        "projection",
        "resolution",
        "tile",
        "renderMode",
        "lighting");

    /** {@code projection} 段允许的字段。 */
    public static final Set<String> PROJECTION_FIELDS = unmodifiable("type", "fov", "orthoHeight");

    /** {@code tile} 段允许的字段。 */
    public static final Set<String> TILE_FIELDS = unmodifiable("cols", "rows", "overlap");

    /**
     * 解析单个机位规格；任一处不合法即抛 {@code CP-VALID-002}（{@code context.fields} 逐字段）。
     *
     * @param ctx 字段前缀（如 {@code cameras[0]}，或 {@code cameras} 用于 {@code shot.multi} 的单机位简写）
     */
    public static CameraSpec parse(JsonObject json, String ctx) {
        Fields fields = new Fields();
        List<String> warnings = new ArrayList<String>();
        CameraSpec spec = parse(json, ctx, fields, warnings);
        fields.throwIfAny("机位规格非法（" + fields.size() + " 处）");
        return spec;
    }

    /**
     * 解析单个机位规格（错误累计进 {@code fields}，不抛异常）。
     *
     * @return 解析结果；有字段级错误时仍尽力返回（调用方按 {@code fields} 判定失败）
     */
    public static CameraSpec parse(JsonObject json, String ctx, Fields fields, List<String> warnings) {
        JsonObject o = json == null ? new JsonObject() : json;
        checkUnknown(o, FIELDS, ctx, fields);

        String name = stringOf(o, "name", ctx + ".name", fields);
        if (name == null) {
            fields.add(ctx + ".name", "必填（机位 id，用作产物文件名）");
        } else if (name.length() > MAX_NAME_LENGTH) {
            fields.add(ctx + ".name", "长度不得超过 " + MAX_NAME_LENGTH);
        } else if (!name.matches(NAME_PATTERN)) {
            fields.add(ctx + ".name", "须匹配 " + NAME_PATTERN + "（小写字母/数字/._-，供产物文件名使用）");
        }

        double[] pos = doubleArray(o, "pos", ctx + ".pos", 3, fields);
        double yaw = finiteOf(o, "yaw", ctx + ".yaw", 0.0d, fields);
        double pitch = finiteOf(o, "pitch", ctx + ".pitch", 0.0d, fields);
        if (pitch < -90.0d || pitch > 90.0d) {
            fields.add(ctx + ".pitch", "须在 -90..90（度，MC 语义正=俯视），收到 " + pitch);
        }

        Projection proj = parseProjection(o, ctx, fields);
        int[] resolution = parseResolution(o, ctx, fields);
        Tile tile = parseTile(o, ctx, fields);

        String renderMode = optStringOf(o, "renderMode", ctx + ".renderMode", fields);
        if (renderMode != null && !renderMode.trim()
            .isEmpty() && !CaptureSpec.isRenderMode(renderMode)) {
            fields.add(
                ctx + ".renderMode",
                "须为 " + CaptureSpec.RENDER_MODE_NATIVE + " 或 " + CaptureSpec.RENDER_MODE_LIT + "，收到 " + renderMode);
        }
        String lighting = optStringOf(o, "lighting", ctx + ".lighting", fields);
        if (lighting != null && !lighting.trim()
            .isEmpty() && !CaptureSpec.isLighting(lighting)) {
            fields.add(
                ctx + ".lighting",
                "须为 " + CaptureSpec.LIGHTING_NATURAL + " 或 " + CaptureSpec.LIGHTING_NEUTRAL_FLAT + "，收到 " + lighting);
        }

        return new CameraSpec(
            name == null ? "camera" : name,
            pos == null ? new double[] { 0.0d, 0.0d, 0.0d } : pos,
            yaw,
            pitch,
            proj.type,
            proj.fov,
            proj.orthoHeight,
            resolution == null ? new int[] { 1920, 1080 } : resolution,
            tile.cols,
            tile.rows,
            tile.overlap,
            renderMode,
            lighting,
            name);
    }

    /**
     * 机位名集合里不允许重复（产物文件名冲突会让「重名旧图先删」变成互相删除）。
     *
     * <p>
     * 计数的是<b>声明值</b>（{@code spec.name()} 是「声明为空时的兜底名」，不能拿来判重）：
     * 两个都缺 name 的机位各自已经有一条 {@code name 必填} 的字段错误，不该再报一条莫名其妙的
     * 「camera 重复」淹没它。
     */
    public static void checkUniqueNames(List<CameraSpec> specs, String listField, Fields fields) {
        Set<String> seen = new LinkedHashSet<String>();
        for (CameraSpec s : specs) {
            String declared = s.declaredName;
            if (declared == null || declared.isEmpty()) {
                continue;
            }
            if (!seen.add(declared)) {
                fields.add(listField, "机位名重复: " + declared + "（产物文件名会互相覆盖）");
            }
        }
    }

    // ------------------------------------------------------------ 内部解析

    /** 投影段的解析结果。 */
    private static final class Projection {

        private String type;
        private double fov = Double.NaN;
        private double orthoHeight = Double.NaN;
    }

    private static Projection parseProjection(JsonObject o, String ctx, Fields fields) {
        Projection p = new Projection();
        JsonObject proj = Json.optObject(o, "projection");
        if (proj == null) {
            fields.add(
                ctx + ".projection",
                "必填，且是二选一：{\"type\":\"perspective\",\"fov\":70} 或 " + "{\"type\":\"ortho\",\"orthoHeight\":16.0}");
            p.type = PROJECTION_PERSPECTIVE;
            p.fov = 70.0d;
            return p;
        }
        checkUnknown(proj, PROJECTION_FIELDS, ctx + ".projection", fields);
        String type = stringOf(proj, "type", ctx + ".projection.type", fields);
        if (type == null) {
            fields.add(ctx + ".projection.type", "必填（perspective | ortho）");
            type = PROJECTION_PERSPECTIVE;
        } else {
            type = type.toLowerCase(Locale.ROOT);
        }
        if (PROJECTION_PERSPECTIVE.equals(type)) {
            if (proj.has("orthoHeight")) {
                fields.add(ctx + ".projection.orthoHeight", "透视投影不得声明 orthoHeight（二选一）");
            }
            if (!proj.has("fov")) {
                fields.add(ctx + ".projection.fov", "透视投影必填 fov（度，" + (int) MIN_FOV + ".." + (int) MAX_FOV + "）");
            } else {
                double fov = finiteOf(proj, "fov", ctx + ".projection.fov", Double.NaN, fields);
                if (!Double.isNaN(fov) && (fov < MIN_FOV || fov > MAX_FOV)) {
                    fields.add(ctx + ".projection.fov", "须在 " + (int) MIN_FOV + ".." + (int) MAX_FOV + "（度），收到 " + fov);
                }
                p.fov = fov;
            }
            p.type = PROJECTION_PERSPECTIVE;
        } else if (PROJECTION_ORTHO.equals(type)) {
            if (proj.has("fov")) {
                fields.add(ctx + ".projection.fov", "正交投影不得声明 fov（二选一）");
            }
            if (!proj.has("orthoHeight")) {
                fields.add(ctx + ".projection.orthoHeight", "正交投影必填 orthoHeight（视高，方块数；宽按画面宽高比推）");
            } else {
                double h = finiteOf(proj, "orthoHeight", ctx + ".projection.orthoHeight", Double.NaN, fields);
                if (!Double.isNaN(h) && (h < MIN_ORTHO_HEIGHT || h > MAX_ORTHO_HEIGHT)) {
                    fields.add(
                        ctx + ".projection.orthoHeight",
                        "须在 " + MIN_ORTHO_HEIGHT + ".." + (int) MAX_ORTHO_HEIGHT + "（方块），收到 " + h);
                }
                p.orthoHeight = h;
            }
            p.type = PROJECTION_ORTHO;
        } else {
            fields.add(ctx + ".projection.type", "未知投影类型: " + type + "（支持 perspective/ortho）");
            p.type = PROJECTION_PERSPECTIVE;
            p.fov = 70.0d;
        }
        return p;
    }

    private static int[] parseResolution(JsonObject o, String ctx, Fields fields) {
        if (!o.has("resolution")) {
            fields.add(ctx + ".resolution", "必填 [width,height]（正整数像素）");
            return null;
        }
        JsonArray a = Json.optArray(o, "resolution");
        if (a == null || a.size() != 2) {
            fields.add(ctx + ".resolution", "须为 [width,height] 两个整数，收到 " + (a == null ? "非数组" : a.size() + " 个"));
            return null;
        }
        int[] out = new int[2];
        boolean ok = true;
        for (int i = 0; i < 2; i++) {
            String side = i == 0 ? "width" : "height";
            JsonElement e = a.get(i);
            if (!isIntegral(e) || !isFinite(e)) {
                fields.add(ctx + ".resolution[" + i + "]", side + " 须为正整数");
                ok = false;
                continue;
            }
            long v = e.getAsLong();
            if (v < MIN_RESOLUTION_SIDE || v > MAX_RESOLUTION_SIDE) {
                fields.add(
                    ctx + ".resolution[" + i + "]",
                    side + " 须在 " + MIN_RESOLUTION_SIDE + ".." + MAX_RESOLUTION_SIDE + " 像素，收到 " + v);
                ok = false;
                continue;
            }
            out[i] = (int) v;
        }
        return ok ? out : null;
    }

    /** tile 段的解析结果。 */
    private static final class Tile {

        private int cols = 1;
        private int rows = 1;
        private double overlap = 0.05d;
    }

    private static Tile parseTile(JsonObject o, String ctx, Fields fields) {
        Tile t = new Tile();
        if (!o.has("tile")) {
            return t;
        }
        JsonObject tile = Json.optObject(o, "tile");
        if (tile == null) {
            fields.add(ctx + ".tile", "须为 object {cols,rows,overlap?}");
            return t;
        }
        checkUnknown(tile, TILE_FIELDS, ctx + ".tile", fields);
        boolean hasCols = tile.has("cols");
        boolean hasRows = tile.has("rows");
        if (!hasCols && !hasRows) {
            fields.add(ctx + ".tile", "至少声明 cols 或 rows（1.." + MAX_TILE_DIVISIONS + "）");
        }
        t.cols = division(tile, "cols", ctx, fields, hasCols);
        t.rows = division(tile, "rows", ctx, fields, hasRows);
        if (tile.has("overlap")) {
            double v = finiteOf(tile, "overlap", ctx + ".tile.overlap", 0.05d, fields);
            if (!Double.isNaN(v) && (v < 0.0d || v > MAX_OVERLAP)) {
                fields.add(ctx + ".tile.overlap", "须在 0.." + MAX_OVERLAP + "，收到 " + v);
            }
            t.overlap = v;
        }
        return t;
    }

    private static int division(JsonObject tile, String key, String ctx, Fields fields, boolean present) {
        String field = ctx + ".tile." + key;
        if (!present) {
            return 1;
        }
        JsonElement e = Json.get(tile, key);
        if (!isIntegral(e) || !isFinite(e)) {
            fields.add(field, "须为整数 1.." + MAX_TILE_DIVISIONS);
            return 1;
        }
        long v = e.getAsLong();
        if (v < 1 || v > MAX_TILE_DIVISIONS) {
            fields.add(field, "须在 1.." + MAX_TILE_DIVISIONS + "，收到 " + v);
            return 1;
        }
        return (int) v;
    }

    // ------------------------------------------------------------ 小工具（与 CaseParser 同口径）

    /** 段内未知字段一律记错（严格模式口径，case-file.md §9）。 */
    public static void checkUnknown(JsonObject o, Set<String> allowed, String prefix, Fields fields) {
        if (o == null) {
            return;
        }
        for (String key : Json.keys(o)) {
            if (!allowed.contains(key)) {
                fields.add(prefix.isEmpty() ? key : prefix + "." + key, "未知字段");
            }
        }
    }

    /** 数值是否有限（拒绝 NaN/Infinity；JSON 字面量一般到不了，但 1e999 会）。 */
    public static boolean isFinite(JsonElement e) {
        if (e == null || !e.isJsonPrimitive()) {
            return false;
        }
        try {
            return !Double.isNaN(e.getAsDouble()) && !Double.isInfinite(e.getAsDouble());
        } catch (RuntimeException ex) {
            return false;
        }
    }

    /** 整数（无小数点、无指数）判定。 */
    public static boolean isIntegral(JsonElement e) {
        if (e == null || !e.isJsonPrimitive()
            || !e.getAsJsonPrimitive()
                .isNumber()) {
            return false;
        }
        String s = e.getAsString();
        return s.indexOf('.') < 0 && s.indexOf('e') < 0 && s.indexOf('E') < 0;
    }

    private static String stringOf(JsonObject o, String key, String field, Fields fields) {
        JsonElement e = Json.get(o, key);
        if (e == null) {
            return null;
        }
        if (!e.isJsonPrimitive() || !e.getAsJsonPrimitive()
            .isString()) {
            fields.add(field, "须为 string");
            return null;
        }
        return e.getAsString();
    }

    /** 可选字符串：缺失返回 null；存在但类型不符记错。 */
    public static String optStringOf(JsonObject o, String key, String field, Fields fields) {
        JsonElement e = Json.get(o, key);
        if (e == null) {
            return null;
        }
        if (!e.isJsonPrimitive() || !e.getAsJsonPrimitive()
            .isString()) {
            fields.add(field, "须为 string");
            return null;
        }
        return e.getAsString();
    }

    /** 有限数值：缺失返回默认值；存在但非法记错并返回默认值。 */
    public static double finiteOf(JsonObject o, String key, String field, double def, Fields fields) {
        JsonElement e = Json.get(o, key);
        if (e == null) {
            return def;
        }
        if (!e.isJsonPrimitive() || !e.getAsJsonPrimitive()
            .isNumber()) {
            fields.add(field, "须为数值");
            return def;
        }
        if (!isFinite(e)) {
            fields.add(field, "须为有限数值（拒绝 NaN/Infinity）");
            return def;
        }
        return e.getAsDouble();
    }

    private static double[] doubleArray(JsonObject o, String key, String field, int size, Fields fields) {
        JsonElement e = Json.get(o, key);
        if (e == null) {
            fields.add(field, "必填 [x,y,z]（数值数组，允许半格坐标）");
            return null;
        }
        if (!e.isJsonArray()) {
            fields.add(field, "须为 [x,y,z] 数值数组");
            return null;
        }
        JsonArray a = e.getAsJsonArray();
        if (a.size() != size) {
            fields.add(field, "须为 " + size + " 个数值，收到 " + a.size() + " 个");
            return null;
        }
        double[] out = new double[size];
        boolean ok = true;
        for (int i = 0; i < size; i++) {
            JsonElement v = a.get(i);
            if (!isFinite(v) || v.isJsonNull()
                || !v.isJsonPrimitive()
                || !v.getAsJsonPrimitive()
                    .isNumber()) {
                fields.add(field + "[" + i + "]", "须为有限数值");
                ok = false;
                continue;
            }
            out[i] = v.getAsDouble();
        }
        return ok ? out : null;
    }

    private static Set<String> unmodifiable(String... names) {
        return java.util.Collections.unmodifiableSet(new LinkedHashSet<String>(java.util.Arrays.asList(names)));
    }
}
