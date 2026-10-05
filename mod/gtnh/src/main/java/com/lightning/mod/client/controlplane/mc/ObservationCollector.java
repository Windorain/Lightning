package com.lightning.mod.client.controlplane.mc;

import net.minecraft.client.Minecraft;
import net.minecraft.client.settings.GameSettings;
import net.minecraft.world.World;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.lightning.mod.client.controlplane.core.ArtifactStore;
import com.lightning.mod.client.controlplane.core.CaseFile;
import com.lightning.mod.client.controlplane.core.Json;
import com.lightning.mod.client.controlplane.core.ObservationRecord;
import com.lightning.mod.client.controlplane.core.TimeSource;

/**
 * 观测记录采集（{@code lightning.observation/1}，见 docs/control-plane/observation-record.md）。
 *
 * <p>
 * 采集全部由 mc 层完成，结构由 core 的 {@link ObservationRecord} 保证。A10 的核心要求是
 * 「仅据本文件即可解释一次观测」——因此这里固定填四类：
 * <ol>
 * <li><b>versions</b>：mod/MC/Forge 版本 + 与场景相关的模组清单（{@link VersionInfo}）；</li>
 * <li><b>clientConfig</b>：渲染相关客户端配置快照（FOV/视距/画质/FBO/分辨率/GUI 缩放/立体）；</li>
 * <li><b>observation</b>：观察条件（PR-1 占位机位 {@code player}/{@code perspective}、target 包围盒、
 * 世界时刻、光照口径、渲染模式、玩家位置）；</li>
 * <li><b>runtimeReads / artifacts</b>：读过的运行期状态摘要与哈希、产物引用与哈希。</li>
 * </ol>
 *
 * <p>
 * 哈希口径（observation-record.md §2.1）：{@code runtimeReads[].sha256} 对<b>摘要对象的规范化 JSON</b>
 * 计算（{@link ObservationRecord#hashSummary}），产物 {@code sha256} 对文件字节计算
 * （由 {@link ArtifactStore} 登记时算好）。
 */
public final class ObservationCollector {

    /** 采集输入。 */
    public static final class Input {

        /** 客户端实例。 */
        public Minecraft mc;

        /** 本次 run（产物引用来源）。 */
        public ArtifactStore.Run run;

        /** 用例（id 与内容哈希）。 */
        public CaseFile caseFile;

        /** 规范化计划（target 包围盒从 build 段推）。 */
        public JsonObject plan;

        /** 场景清单（可为 null：没有 build 段时）。 */
        public JsonObject manifest;

        /** 判据汇总结论（可为 null：未跑 criteria 段）。 */
        public JsonObject criteria;

        /** PD-2 透传段落（capture/cameras）的延后说明。 */
        public JsonArray deferred;

        /** 负对照变体校验结果（可为 null）。 */
        public JsonObject variant;

        /** 失败信息（可为 null：成功跑完）。 */
        public JsonObject failure;
    }

    private ObservationCollector() {}

    /** 采集一条观测记录。 */
    public static ObservationRecord collect(Input in) {
        Minecraft mc = in.mc;
        ObservationRecord.Builder b = ObservationRecord.builder(
            in.run == null ? "" : in.run.runId(),
            in.caseFile == null ? "" : in.caseFile.id(),
            in.caseFile == null ? "" : in.caseFile.sha256());
        b.createdAt(
            TimeSource.system()
                .isoNow());
        b.versions(VersionInfo.observationVersions());
        b.clientConfig(clientConfig(mc));
        b.observation(observation(mc, in.plan, in.manifest));
        addRuntimeReads(b, in);
        addArtifacts(b, in);
        return b.build();
    }

    /** 渲染相关客户端配置快照。 */
    public static JsonObject clientConfig(Minecraft mc) {
        JsonObject o = new JsonObject();
        GameSettings gs = mc == null ? null : mc.gameSettings;
        if (gs != null) {
            o.addProperty("fovSetting", Float.valueOf(gs.fovSetting));
            o.addProperty("renderDistanceChunks", gs.renderDistanceChunks);
            o.addProperty("fancyGraphics", gs.fancyGraphics);
            o.addProperty("fboEnable", gs.fboEnable);
            o.addProperty("guiScale", gs.guiScale);
            o.addProperty("anaglyph", gs.anaglyph);
            o.addProperty("pauseOnLostFocus", gs.pauseOnLostFocus);
            o.addProperty("viewBobbing", gs.viewBobbing);
            o.addProperty("ambientOcclusion", gs.ambientOcclusion);
            o.addProperty("gamma", Float.valueOf(gs.gammaSetting));
            o.addProperty("particles", gs.particleSetting);
        }
        if (mc != null) {
            o.addProperty("displayWidth", mc.displayWidth);
            o.addProperty("displayHeight", mc.displayHeight);
        }
        return o;
    }

    /**
     * 观察条件。
     *
     * <p>
     * PR-1 的 {@code camera.mode}/{@code projection} 是契约写死的占位值
     * （{@code player}/{@code perspective}），PR-2 由拍摄动作填真实机位；字段一经引入不得改义。
     */
    private static JsonObject observation(Minecraft mc, JsonObject plan, JsonObject manifest) {
        JsonObject o = new JsonObject();
        JsonObject camera = new JsonObject();
        camera.addProperty("mode", ObservationRecord.PLACEHOLDER_CAMERA_MODE);
        o.add("camera", camera);
        o.addProperty("projection", ObservationRecord.PLACEHOLDER_PROJECTION);
        World world = mc == null ? null : mc.theWorld;
        o.addProperty("worldTime", world == null ? 0L : world.getWorldTime());
        o.addProperty("lighting", "natural");
        o.addProperty("renderMode", "本色");
        JsonArray bbox = targetBbox(plan);
        if (bbox != null) {
            o.add("target", Json.object("bbox", bbox));
        } else {
            JsonObject target = new JsonObject();
            target.addProperty("bbox", (String) null);
            target.addProperty("note", "计划未声明 build 段坐标，无法给出观察包围盒");
            o.add("target", target);
        }
        if (mc != null && mc.thePlayer != null) {
            JsonArray pos = new JsonArray();
            Json.add(pos, Double.valueOf(round(mc.thePlayer.posX)));
            Json.add(pos, Double.valueOf(round(mc.thePlayer.posY)));
            Json.add(pos, Double.valueOf(round(mc.thePlayer.posZ)));
            o.add("playerPos", pos);
        }
        if (manifest != null) {
            o.addProperty("sceneSha256", Json.optString(manifest, "sha256", null));
        }
        return o;
    }

    /** 由 build 段坐标推观察包围盒：{@code [[minx,miny,minz],[maxx,maxy,maxz]]}。 */
    public static JsonArray targetBbox(JsonObject plan) {
        if (plan == null) {
            return null;
        }
        JsonArray build = Json.optArray(plan, "build");
        int[] min = null;
        int[] max = null;
        if (build != null) {
            for (int i = 0; i < build.size(); i++) {
                JsonElement e = build.get(i);
                if (e == null || !e.isJsonObject()) {
                    continue;
                }
                JsonObject step = e.getAsJsonObject();
                for (String key : new String[] { "at", "from", "to" }) {
                    JsonArray a = Json.optArray(step, key);
                    if (a == null || a.size() != 3) {
                        continue;
                    }
                    int[] p = new int[] { a.get(0)
                        .getAsInt(),
                        a.get(1)
                            .getAsInt(),
                        a.get(2)
                            .getAsInt() };
                    if (min == null) {
                        min = p.clone();
                        max = p.clone();
                    } else {
                        for (int k = 0; k < 3; k++) {
                            min[k] = Math.min(min[k], p[k]);
                            max[k] = Math.max(max[k], p[k]);
                        }
                    }
                }
            }
        }
        if (min == null) {
            JsonObject world = Json.optObject(plan, "world");
            JsonArray base = world == null ? null : Json.optArray(world, "base");
            if (base != null && base.size() == 3) {
                min = new int[] { base.get(0)
                    .getAsInt(),
                    base.get(1)
                        .getAsInt(),
                    base.get(2)
                        .getAsInt() };
                max = min.clone();
            }
        }
        if (min == null) {
            return null;
        }
        JsonArray out = new JsonArray();
        out.add(posArray(min));
        out.add(posArray(max));
        return out;
    }

    private static void addRuntimeReads(ObservationRecord.Builder b, Input in) {
        if (in.manifest != null) {
            b.read("world.sceneManifest", SceneManifest.summary(in.manifest), SceneManifest.hashSubset(in.manifest));
            b.read(
                "world.sceneSha256",
                Json.optString(in.manifest, "sha256", null),
                Json.optString(in.manifest, "sha256", null));
            b.read(
                "world.sceneMeta",
                "folder=" + Json.optString(in.manifest, "folder", null)
                    + " seed="
                    + Json.optLong(in.manifest, "seed", 0L)
                    + " settleTicks="
                    + Json.optInt(in.manifest, "settleTicks", 0),
                Json.object(
                    "folder",
                    Json.optString(in.manifest, "folder", null),
                    "seed",
                    Long.valueOf(Json.optLong(in.manifest, "seed", 0L)),
                    "stepCount",
                    Integer.valueOf(Json.optInt(in.manifest, "stepCount", 0)),
                    "settleTicks",
                    Integer.valueOf(Json.optInt(in.manifest, "settleTicks", 0)),
                    "void",
                    Boolean.valueOf(Json.optBool(in.manifest, "void", false))));
        }
        JsonObject world = WorldDescriber.describe(in.mc);
        b.read(
            "world.info",
            "folder=" + Json.optString(world, "folder", null)
                + " managed="
                + Json.optBool(world, "managed", false)
                + " void="
                + Json.optBool(world, "void", false),
            world);
        if (in.criteria != null) {
            b.read(
                "criteria.summary",
                "overall=" + Json.optString(in.criteria, "overall", null)
                    + " "
                    + Json.toJson(Json.optObject(in.criteria, "counts")),
                Json.optObject(in.criteria, "counts"));
        }
        if (in.run != null) {
            JsonObject manifestRef = new JsonObject();
            manifestRef.addProperty("runId", in.run.runId());
            manifestRef.addProperty("caseId", in.run.caseId());
            manifestRef.addProperty("jobSeq", in.run.jobSeq());
            manifestRef.addProperty("createdAt", in.run.createdAt());
            manifestRef.addProperty(
                "artifactCount",
                in.run.artifacts()
                    .size());
            b.read(
                "run.manifest",
                "run=" + in.run.runId()
                    + " artifacts="
                    + in.run.artifacts()
                        .size(),
                manifestRef);
        }
        if (in.failure != null) {
            b.read("run.failure", Json.optString(in.failure, "code", null), in.failure);
        }
    }

    private static void addArtifacts(ObservationRecord.Builder b, Input in) {
        if (in.run == null) {
            return;
        }
        for (ArtifactStore.Artifact a : in.run.artifacts()
            .values()) {
            b.artifact(a);
        }
    }

    private static JsonArray posArray(int[] p) {
        JsonArray a = new JsonArray();
        for (int v : p) {
            Json.add(a, Integer.valueOf(v));
        }
        return a;
    }

    private static double round(double v) {
        return Math.round(v * 1000.0d) / 1000.0d;
    }
}
