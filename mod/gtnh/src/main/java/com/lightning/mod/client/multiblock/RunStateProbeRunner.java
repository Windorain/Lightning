package com.lightning.mod.client.multiblock;

import java.io.File;
import java.io.FileInputStream;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

import net.minecraft.client.Minecraft;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.google.gson.JsonPrimitive;

import cpw.mods.fml.common.FMLLog;
import cpw.mods.fml.relauncher.Side;
import cpw.mods.fml.relauncher.SideOnly;

/**
 * T0.3 探针的落盘编排：跑完所有目标，把结果写进 {@code <mcDataDir>/runstate_probe/run-NNNN/}，
 * 并自动与上一次运行的同名目标做签名比对（可重复性的机器判据，不是靠人眼看日志）。
 * <p>
 * 输出布局：
 * 
 * <pre>
 * runstate_probe/
 *   run-0001/
 *     mte-electric-blast-furnace.json   每台机器一份（两态签名 / 差异量 / 样本）
 *     mte-exo-foundry.json
 *     result.json                       本次运行汇总 + 与上一次运行的签名比对
 *   latest.json                         最近一次运行的汇总副本
 * </pre>
 */
@SideOnly(Side.CLIENT)
public final class RunStateProbeRunner {

    public static final String OUTPUT_DIR = "runstate_probe";

    private RunStateProbeRunner() {}

    public static File outputDir(Minecraft mc) {
        return new File(mc.mcDataDir, OUTPUT_DIR);
    }

    /** 触发文件：存在即代表「本进程跑 T0.3 探针」。内容留空即可（当前不使用其内容）。 */
    public static File triggerFile(Minecraft mc) {
        return new File(mc.mcDataDir, "sde_runstate_probe.json");
    }

    public static JsonObject run(Minecraft mc) throws Exception {
        return run(mc, null);
    }

    public static JsonObject run(Minecraft mc, JsonObject environment) throws Exception {
        long started = System.currentTimeMillis();
        File dir = outputDir(mc);
        if (!dir.isDirectory() && !dir.mkdirs()) {
            throw new IllegalStateException("Cannot mkdir: " + dir.getAbsolutePath());
        }
        int previousRunIndex = previousRunIndex(dir);
        int runIndex = previousRunIndex + 1;
        File runDir = new File(dir, String.format("run-%04d", runIndex));
        if (!runDir.isDirectory() && !runDir.mkdirs()) {
            throw new IllegalStateException("Cannot mkdir: " + runDir.getAbsolutePath());
        }

        List<ProbeTarget> targets = ProbeTarget.defaults();
        JsonObject result = new JsonObject();
        result.addProperty("probe", "T0.3 run-state reachability");
        result.addProperty("probeSchema", 1);
        result.addProperty("runIndex", runIndex);
        result.addProperty("runDir", runDir.getAbsolutePath());
        result.addProperty("startedAtEpochMs", started);
        result.addProperty("targetCount", targets.size());
        if (environment != null) {
            result.add("environment", environment);
        }

        JsonArray perTarget = new JsonArray();
        List<String> filesWritten = new ArrayList<String>();
        List<JsonObject> targetResults = new ArrayList<JsonObject>();

        for (ProbeTarget target : targets) {
            JsonObject one;
            try {
                one = RunStateProbe.probeOne(target);
            } catch (Throwable t) {
                one = new JsonObject();
                one.addProperty("targetFqcn", target.fqcn);
                one.addProperty("targetLabel", target.label);
                one.addProperty("status", "probe-threw");
                one.addProperty(
                    "failure",
                    t.getClass()
                        .getName() + ": "
                        + t.getMessage());
            }
            one.addProperty("runIndex", runIndex);
            writeJson(new File(runDir, target.slug() + ".json"), one);
            filesWritten.add(target.slug() + ".json");
            targetResults.add(one);
            perTarget.add(one);
            logTargetSummary(one);
        }

        result.add("targets", perTarget);
        JsonArray files = new JsonArray();
        for (String f : filesWritten) {
            files.add(new JsonPrimitive(f));
        }
        result.add("files", files);
        result.add("signatureComparison", compareWithPrevious(dir, previousRunIndex, targetResults));
        result.addProperty("elapsedMs", System.currentTimeMillis() - started);

        writeJson(new File(runDir, "result.json"), result);
        filesWritten.add("result.json");
        writeJson(new File(dir, "latest.json"), result);

        FMLLog.info(
            "[SDE][T0.3] run-%04d 完成：%d 台目标，%d ms，输出目录 %s",
            Integer.valueOf(runIndex),
            Integer.valueOf(targets.size()),
            Long.valueOf(System.currentTimeMillis() - started),
            runDir.getAbsolutePath());
        return result;
    }

    public static JsonObject runAndWrite(Minecraft mc) throws Exception {
        return run(mc, null);
    }

    public static JsonObject runAndWrite(Minecraft mc, JsonObject environment) throws Exception {
        return run(mc, environment);
    }

    // ------------------------------------------------------------------ helpers

    private static int previousRunIndex(File dir) {
        File[] children = dir.listFiles();
        int max = 0;
        if (children == null) {
            return 0;
        }
        for (File c : children) {
            if (!c.isDirectory()) {
                continue;
            }
            String n = c.getName();
            if (!n.startsWith("run-")) {
                continue;
            }
            try {
                max = Math.max(max, Integer.parseInt(n.substring(4)));
            } catch (NumberFormatException ignored) {
                // 非规范目录名忽略
            }
        }
        return max;
    }

    /** 与上一次运行逐目标比对两态签名；没有上一次运行则记为 {@code null}。 */
    private static JsonObject compareWithPrevious(File dir, int previousRunIndex, List<JsonObject> current) {
        JsonObject out = new JsonObject();
        if (previousRunIndex <= 0) {
            out.add("previousRunIndex", com.google.gson.JsonNull.INSTANCE);
            out.addProperty("allMatch", false);
            out.addProperty("note", "本目录下没有更早的运行，无法比对（第二次运行起才有重复性证据）");
            return out;
        }
        File prevDir = new File(dir, String.format("run-%04d", previousRunIndex));
        out.addProperty("previousRunIndex", previousRunIndex);
        out.addProperty("previousRunDir", prevDir.getAbsolutePath());
        JsonArray rows = new JsonArray();
        boolean allMatch = true;
        for (JsonObject cur : current) {
            String label = cur.has("targetLabel") ? cur.get("targetLabel")
                .getAsString() : "?";
            String slug = label.toLowerCase(java.util.Locale.ROOT)
                .replaceAll("[^a-z0-9]+", "-")
                .replaceAll("^-|-$", "");
            JsonObject row = new JsonObject();
            row.addProperty("targetLabel", label);
            File prevFile = new File(prevDir, slug + ".json");
            if (!prevFile.isFile()) {
                row.addProperty("previousFile", "missing");
                row.addProperty("allMatch", false);
                allMatch = false;
                rows.add(row);
                continue;
            }
            try {
                JsonObject prev = new JsonParser().parse(readAll(prevFile))
                    .getAsJsonObject();
                boolean idleMatch = stringEquals(cur, prev, "states/idle/signature");
                boolean activeMatch = stringEquals(cur, prev, "states/active/signature");
                int curDiff = intOf(cur, "diff/differingQuads");
                int prevDiff = intOf(prev, "diff/differingQuads");
                boolean diffMatch = curDiff == prevDiff;
                row.addProperty("idleSignatureMatch", idleMatch);
                row.addProperty("activeSignatureMatch", activeMatch);
                row.addProperty("differingQuadsMatch", diffMatch);
                row.addProperty("currentIdleSignature", stringOf(cur, "states/idle/signature"));
                row.addProperty("previousIdleSignature", stringOf(prev, "states/idle/signature"));
                row.addProperty("currentActiveSignature", stringOf(cur, "states/active/signature"));
                row.addProperty("previousActiveSignature", stringOf(prev, "states/active/signature"));
                boolean ok = idleMatch && activeMatch && diffMatch;
                row.addProperty("allMatch", ok);
                allMatch = allMatch && ok;
            } catch (Exception e) {
                row.addProperty("error", e.toString());
                row.addProperty("allMatch", false);
                allMatch = false;
            }
            rows.add(row);
        }
        out.add("targets", rows);
        out.addProperty("allMatch", allMatch);
        return out;
    }

    private static boolean stringEquals(JsonObject a, JsonObject b, String path) {
        String va = stringOf(a, path);
        String vb = stringOf(b, path);
        return va != null && va.equals(vb);
    }

    private static String stringOf(JsonObject o, String path) {
        JsonElement e = navigate(o, path);
        return e == null || e.isJsonNull() ? null : e.getAsString();
    }

    private static int intOf(JsonObject o, String path) {
        JsonElement e = navigate(o, path);
        return e == null || e.isJsonNull() ? -1 : e.getAsInt();
    }

    private static JsonElement navigate(JsonObject o, String path) {
        JsonObject cur = o;
        String[] parts = path.split("/");
        for (int i = 0; i < parts.length - 1; i++) {
            if (!cur.has(parts[i]) || !cur.get(parts[i])
                .isJsonObject()) {
                return null;
            }
            cur = cur.getAsJsonObject(parts[i]);
        }
        return cur.get(parts[parts.length - 1]);
    }

    private static String readAll(File file) throws Exception {
        try (InputStreamReader r = new InputStreamReader(new FileInputStream(file), StandardCharsets.UTF_8)) {
            StringBuilder sb = new StringBuilder();
            char[] buf = new char[4096];
            int n;
            while ((n = r.read(buf)) > 0) {
                sb.append(buf, 0, n);
            }
            return sb.toString();
        }
    }

    static void writeJson(File file, JsonObject json) throws Exception {
        Gson gson = new GsonBuilder().setPrettyPrinting()
            .create();
        try (
            OutputStreamWriter w = new OutputStreamWriter(new java.io.FileOutputStream(file), StandardCharsets.UTF_8)) {
            w.write(gson.toJson(json));
        }
    }

    private static void logTargetSummary(JsonObject one) {
        String label = one.has("targetLabel") ? one.get("targetLabel")
            .getAsString() : "?";
        String status = one.has("status") ? one.get("status")
            .getAsString() : "?";
        if (!"ok".equals(status)) {
            FMLLog.warning("[SDE][T0.3] %s: status=%s", label, status);
            return;
        }
        JsonObject trace = one.getAsJsonObject("runStateTrace");
        JsonObject diff = one.getAsJsonObject("diff");
        JsonObject states = one.getAsJsonObject("states");
        FMLLog.info(
            "[SDE][T0.3] %s: 状态机派生=%s 机制=%s | 待机 quad=%s 运行 quad=%s 差异 quad=%s | idleSig=%s activeSig=%s",
            label,
            String.valueOf(
                trace.get("stateMachineDerivedActive")
                    .getAsBoolean()),
            trace.get("activeMechanism")
                .getAsString(),
            String.valueOf(diff.get("quadCountIdle")),
            String.valueOf(diff.get("quadCountActive")),
            String.valueOf(diff.get("differingQuads")),
            states.getAsJsonObject("idle")
                .get("signature")
                .getAsString(),
            states.getAsJsonObject("active")
                .get("signature")
                .getAsString());
    }
}
