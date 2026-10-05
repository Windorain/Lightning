package com.lightning.mod.client.controlplane.mc;

import java.nio.file.Files;
import java.nio.file.Path;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.lightning.mod.client.controlplane.core.ActionContext;
import com.lightning.mod.client.controlplane.core.CaseFile;
import com.lightning.mod.client.controlplane.core.CaseParser;
import com.lightning.mod.client.controlplane.core.CaseValidator;
import com.lightning.mod.client.controlplane.core.Contract;
import com.lightning.mod.client.controlplane.core.CpException;
import com.lightning.mod.client.controlplane.core.ErrorCodes;
import com.lightning.mod.client.controlplane.core.Fields;
import com.lightning.mod.client.controlplane.core.Json;

/**
 * 用例来源解析（{@code case.validate} / {@code case.run} 的 {@code file|inline} 参数），
 * 以及 {@code world.rebuild} 的 {@code build} 参数归一化。
 *
 * <h2>为什么 world.rebuild 的 build 段也走这里</h2>
 * 契约要求「整跑与按段共用同一实现」。构建步骤的<b>解析与归一化</b>（相对坐标展开成绝对坐标、
 * 未知字段报错、取值域校验、默认值补齐）在 core 的 {@link CaseParser}/{@link CaseValidator} 里只写了
 * 一份，因此 {@code world.rebuild} 的 {@code build} 参数被包进一份合成用例再交给同一解析器——
 * 两个入口的场景构建走的是同一份归一化产物与同一个 {@link SceneBuilder}。
 */
public final class CaseSources {

    /** 合成用例 id（world.rebuild 的 build 段归一化用）。 */
    public static final String SYNTHETIC_CASE_ID = "cp-world-rebuild";

    private CaseSources() {}

    /**
     * 解析 {@code {file|inline}} 之一为用例（并过一遍 {@link CaseValidator}）。
     *
     * @param ctx       动作上下文
     * @param casesRoot 相对路径基准（{@code <mcDataDir>/controlplane/cases}）
     * @return 已解析并校验通过的用例
     * @throws CpException CP-VALID-002 参数缺失/非法或内容非法；CP-IO-001 读取失败
     */
    public static CaseFile resolve(ActionContext ctx, Path casesRoot) {
        JsonElement fileEl = ctx.param("file");
        JsonElement inlineEl = ctx.param("inline");
        if (fileEl == null && inlineEl == null) {
            throw new CpException(
                ErrorCodes.VALID_PARAM,
                "必须给出 file 或 inline 之一",
                new Fields().add("file", "缺失")
                    .add("inline", "缺失")
                    .toContext());
        }
        if (fileEl != null && inlineEl != null) {
            throw new CpException(
                ErrorCodes.VALID_PARAM,
                "file 与 inline 不能同时给出",
                new Fields().add("file", "与 inline 互斥")
                    .add("inline", "与 file 互斥")
                    .toContext());
        }
        CaseFile file = fileEl != null ? parseFile(fileEl, casesRoot) : parseInline(inlineEl);
        // 取值范围与判据完备性：与 case.validate 同一校验器（失败即 CP-VALID-002 逐字段）
        new CaseValidator().plan(file);
        return file;
    }

    /** 规范化执行计划（{@code case.validate} 的返回）。 */
    public static JsonObject plan(CaseFile file) {
        return new CaseValidator().plan(file);
    }

    private static CaseFile parseFile(JsonElement fileEl, Path casesRoot) {
        if (!fileEl.isJsonPrimitive() || !fileEl.getAsJsonPrimitive()
            .isString()) {
            throw CpException.param("file 参数类型不符", "file", "应为 string");
        }
        String raw = fileEl.getAsString();
        if (raw.trim()
            .isEmpty()) {
            throw CpException.param("file 参数为空", "file", "不得为空");
        }
        Path path = CpPaths.resolve(casesRoot, raw.trim());
        if (!Files.isRegularFile(path)) {
            throw new CpException(
                ErrorCodes.IO,
                "用例文件不存在: " + path,
                Json.object("file", raw, "resolved", path.toString(), "casesRoot", casesRoot.toString()),
                404);
        }
        CaseFile file = new CaseParser().parseFile(path);
        CpLog.info("已读取用例文件 %s（id=%s）", path, file.id());
        return file;
    }

    private static CaseFile parseInline(JsonElement inlineEl) {
        if (inlineEl.isJsonObject()) {
            JsonObject o = inlineEl.getAsJsonObject();
            return new CaseParser().parse(o.deepCopy(), Json.toJson(o));
        }
        if (inlineEl.isJsonPrimitive() && inlineEl.getAsJsonPrimitive()
            .isString()) {
            String text = inlineEl.getAsString();
            if (text.trim()
                .isEmpty()) {
                throw CpException.param("inline 参数为空", "inline", "不得为空");
            }
            return new CaseParser().parse(text);
        }
        throw CpException.param("inline 参数类型不符", "inline", "应为 object 或用例 JSON 文本");
    }

    /**
     * 把 {@code world.rebuild} 的 {@code build} 参数归一化为绝对坐标步骤（复用用例解析器）。
     *
     * @param folder      托管世界目录名
     * @param seed        种子
     * @param base        构建基点（可为 null；出现相对坐标时为必填）
     * @param settleTicks 静置 tick 数
     * @param build       调用方给的 build 段（可为 null/空 → 返回空数组）
     * @return 已归一化的步骤数组（绝对坐标、默认值补齐、未知字段已拒）
     */
    public static JsonArray normalizeBuild(String folder, long seed, int[] base, int settleTicks, JsonArray build) {
        if (build == null || build.size() == 0) {
            return new JsonArray();
        }
        JsonObject world = new JsonObject();
        world.addProperty("folder", folder);
        world.addProperty("seed", seed);
        world.addProperty("void", true);
        if (base != null && base.length == 3) {
            JsonArray b = new JsonArray();
            for (int v : base) {
                b.add(v);
            }
            world.add("base", b);
        }
        world.addProperty("settleTicks", Math.max(0, settleTicks));

        JsonArray criteria = new JsonArray();
        JsonObject noop = new JsonObject();
        noop.addProperty("id", "noop");
        noop.addProperty("type", "artifact-exists");
        JsonObject params = new JsonObject();
        params.addProperty("path", "manifest.json");
        noop.add("params", params);
        criteria.add(noop);

        JsonObject evidence = new JsonObject();
        evidence.add("expect", new JsonArray());

        JsonObject synthetic = new JsonObject();
        synthetic.addProperty("schema", Contract.SCHEMA_CASE);
        synthetic.addProperty("id", SYNTHETIC_CASE_ID);
        synthetic.addProperty("label", "world.rebuild build 段（合成用例，仅用于归一化）");
        synthetic.add("world", world);
        synthetic.add("build", build.deepCopy());
        synthetic.add("criteria", criteria);
        synthetic.add("evidence", evidence);

        String text = Json.toJson(synthetic);
        CaseFile file = new CaseParser().parse(text);
        JsonObject plan = new CaseValidator().plan(file);
        JsonArray steps = Json.optArray(plan, "build");
        return steps == null ? new JsonArray() : steps;
    }
}
