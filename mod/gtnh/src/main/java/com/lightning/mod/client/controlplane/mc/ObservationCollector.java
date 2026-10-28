package com.lightning.mod.client.controlplane.mc;

import net.minecraft.client.Minecraft;
import net.minecraft.client.settings.GameSettings;
import net.minecraft.world.World;
import net.minecraft.world.WorldServer;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.lightning.mod.client.controlplane.core.ArtifactStore;
import com.lightning.mod.client.controlplane.core.CameraSpecs;
import com.lightning.mod.client.controlplane.core.CaptureSpec;
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
 * <li><b>observation</b>：观察条件（1.0 占位机位 {@code player}/{@code perspective}、target 包围盒、
 * 世界时刻、光照口径、渲染模式、玩家位置）；</li>
 * <li><b>runtimeReads / artifacts</b>：读过的运行期状态摘要与哈希、产物引用与哈希。</li>
 * </ol>
 *
 * <p>
 * 哈希口径（observation-record.md §2 第 1 条）：{@code runtimeReads[].sha256} 对<b>摘要对象的规范化 JSON</b>
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

        /** 1.1：机位摘要数组（{@code observation.cameras[]}，见 observation-record.md §2 第 4 条）。 */
        public JsonArray cameras;

        /** 1.1：捕获会话参数（写入 observation.lighting/renderMode/worldTime 的实际会话默认）。 */
        public CaptureSpec captureSpec;

        /** 1.1：拍摄结果（逐机位实际参数留痕）。 */
        public JsonObject shotResult;

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
        addCameraObservation(b, in);
        addRuntimeReads(b, in);
        addArtifacts(b, in);
        return b.build();
    }

    /**
     * 1.1 的相机观测口径（observation-record.md §2 第 4 条）。
     *
     * <p>
     * 有机位时：{@code observation.camera} 记<b>首个机位</b>（会话代表，含真实 pos/yaw/pitch/projection），
     * {@code observation.cameras[]} 追加全部机位摘要；{@code projection} 记首个机位的投影类型。
     * 无机位时保持 1.0 的占位值（{@code player}/{@code perspective}）——字段一经引入不得改义。
     *
     * <p>
     * {@code playerPos} 由 {@link #observation} 单独采集（门控位置分离，A3）：机位只写 camera.*，
     * 绝不动 playerPos。
     */
    private static void addCameraObservation(ObservationRecord.Builder b, Input in) {
        JsonArray cameras = in.cameras;
        if (cameras == null || cameras.size() == 0) {
            return;
        }
        JsonObject first = cameras.get(0)
            .getAsJsonObject();
        JsonObject camera = new JsonObject();
        camera.addProperty("mode", "injected");
        camera.addProperty("name", Json.optString(first, "name", null));
        JsonElement pos = Json.get(first, "pos");
        if (pos != null) {
            camera.add("pos", Json.copy(pos));
        }
        camera.addProperty("yaw", Double.valueOf(optDouble(first, "yaw", 0.0d)));
        camera.addProperty("pitch", Double.valueOf(optDouble(first, "pitch", 0.0d)));
        JsonObject projection = Json.optObject(first, "projection");
        if (projection != null) {
            camera.add("projection", Json.copyObject(projection));
        }
        JsonObject observation = b.observationView();
        if (observation != null) {
            observation.add("camera", camera);
            if (projection != null) {
                observation.addProperty("projection", Json.optString(projection, "type", "perspective"));
            }
            if (in.captureSpec != null) {
                observation.addProperty("lighting", CameraSpecs.resolveLighting(null, in.captureSpec));
                observation.addProperty("renderMode", CameraSpecs.resolveRenderMode(null, in.captureSpec));
                if (in.captureSpec.hasWorldTime()) {
                    observation.addProperty("worldTime", in.captureSpec.worldTime());
                }
            }
            observation.addProperty("cameraCount", cameras.size());
        }
        b.cameras(cameras);
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
     * 1.0 的 {@code camera.mode}/{@code projection} 是契约写死的占位值
     * （{@code player}/{@code perspective}），1.1 由拍摄动作填真实机位；字段一经引入不得改义。
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
        addTeReads(b, in);
    }

    /**
     * TE 运行期状态读数（1.2 运行期轨，observation-record.md §1 的 {@code te.*} 条目）。
     *
     * <p>
     * 键名口径沿用规范里的示例形态：{@code te.<族>[x,y,z].state}（族名 = 用例 {@code te} 步声明的
     * completer 名，如 {@code lp-pipe}/{@code ae2-part}）。每条登记的 {@code sha256} 是对<b>描述器
     * 输出对象</b>的规范化 JSON 计算的（{@link ObservationRecord.Builder#read(String, String, JsonElement)}
     * 内部走 {@link ObservationRecord#hashSummary}），因此离线据本文件即可解释「这次观测看到的 TE
     * 运行期状态是什么」。
     *
     * <p>
     * 位置来自<b>规范化计划</b>的 {@code build} 段（{@code op:"te"} 步），不是场景清单——
     * 按段续跑（没跑 build 段）时清单可能来自世界内记录，而计划里的 te 步才是「本 run 该看哪里」的
     * 权威声明。该族没有描述器（整合包缺 LP/AE2）时整条跳过，不写假读数。
     */
    private static void addTeReads(ObservationRecord.Builder b, Input in) {
        JsonArray build = in.plan == null ? null : Json.optArray(in.plan, "build");
        WorldServer world = WorldRuntime.serverWorld();
        for (int i = 0; build != null && i < build.size(); i++) {
            JsonElement e = build.get(i);
            if (e == null || !e.isJsonObject()) {
                continue;
            }
            JsonObject step = e.getAsJsonObject();
            if (!"te".equals(Json.optString(step, "op", null))) {
                continue;
            }
            int[] at = ints(Json.optArray(step, "at"));
            if (at == null) {
                continue;
            }
            String family = Json.optString(step, "completer", "?");
            if (!TeDescribers.contains(family)) {
                continue;
            }
            String key = "te." + family + "[" + at[0] + "," + at[1] + "," + at[2] + "].state";
            JsonObject state = TeDescribers.describeByFamily(family, world, at[0], at[1], at[2]);
            if (state == null) {
                b.read(key, "无可描述的 TE（族 " + family + " 的描述器不认领该位置）", Json.object("te", "absent", "family", family));
            } else {
                b.read(key, teSummary(family, state), state);
            }
        }
    }

    /** {@code te.*} 条目的人读摘要（族 + 关键判别字段；具体字段由各族自定，取不到就给族名）。 */
    private static String teSummary(String family, JsonObject state) {
        String pipe = Json.optString(state, "pipeType", null);
        if (pipe != null) {
            return family + " pipeType=" + pipe + " initialized=" + Json.optBool(state, "initialized", false);
        }
        JsonObject parts = Json.optObject(state, "parts");
        if (parts != null) {
            int n = 0;
            for (java.util.Map.Entry<String, JsonElement> en : Json.entries(parts)) {
                if (en.getValue() != null && !en.getValue()
                    .isJsonNull()) {
                    n++;
                }
            }
            return family + " parts=" + n;
        }
        return family + " " + Json.toJson(state);
    }

    private static int[] ints(JsonArray a) {
        if (a == null || a.size() != 3) {
            return null;
        }
        int[] out = new int[3];
        for (int i = 0; i < 3; i++) {
            JsonElement v = a.get(i);
            if (v == null || !v.isJsonPrimitive()) {
                return null;
            }
            out[i] = v.getAsInt();
        }
        return out;
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

    /** 数值成员（gson 2.2.4 口径：只有 optInt/optLong，故自行解析字符串形式）。 */
    private static double optDouble(JsonObject o, String key, double def) {
        JsonElement e = Json.get(o, key);
        if (e == null || !e.isJsonPrimitive()) {
            return def;
        }
        try {
            return e.getAsDouble();
        } catch (RuntimeException ex) {
            return def;
        }
    }
}
