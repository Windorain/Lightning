package com.lightning.mod.client.controlplane.mc;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;

import net.minecraft.client.Minecraft;
import net.minecraft.world.WorldServer;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.lightning.mod.client.controlplane.core.ActionContext;
import com.lightning.mod.client.controlplane.core.ArtifactStore;
import com.lightning.mod.client.controlplane.core.CpException;
import com.lightning.mod.client.controlplane.core.ErrorCodes;
import com.lightning.mod.client.controlplane.core.EventStream;
import com.lightning.mod.client.controlplane.core.Json;

/**
 * 托管世界重建机（{@code world.rebuild} 动作与 {@code case.run} 的 {@code world} 段<b>共用同一实现</b>）。
 *
 * <h2>固定序（contract.md §6.3）</h2>
 * <ol>
 * <li>离开当前世界（{@link WorldLoader#ensureLeft}）；</li>
 * <li>删除托管存档目录（<b>二次确认</b>：{@code cp_} 前缀 + 目录不存在或带 {@code cp_world.json}）；</li>
 * <li>{@code launchIntegratedServer(folder, display, WorldSettings(seed, CREATIVE, false, false, FLAT)
 * + 空层预设)}；</li>
 * <li>等进世界（超时由动作层的阶段超时给 {@code CP-EXEC-002}）；</li>
 * <li>（可选）执行场景构建段 —— 由调用方喂入 {@link SceneBuilder}；构建本身交给
 * {@link ServerBuildPump} 在<b>服务端 tick 线程</b>推进（#89 根治，评论 1689），本机只逐 tick
 * 轮询结局；</li>
 * <li>静置 {@code settleTicks}（构建段内部收尾，无构建段时本机自己等）；</li>
 * <li>写 {@code cp_world.json} 与 {@code scene-manifest.json}（存档目录 + run 目录），返回世界描述与
 * 场景清单哈希。</li>
 * </ol>
 *
 * <p>
 * 幂等性：同参数两次执行的场景清单 {@code sha256} 必然相等——哈希只覆盖「世界实际状态」
 * （见 {@link SceneManifest}），而步骤与种子都是固定输入。
 *
 * <p>
 * <b>可选 chunk 静默门</b>（默认关闭，#89 评论 1685 附带条件①）：设了
 * {@code -Dsde.cp.buildChunkQuietGateTicks=N}（N&gt;0）时，构建段<b>首次</b>开始前先跨 tick 等
 * chunk provider 安静（见 {@link BuildDiagnostics#chunkQuiet}），连续 {@link #QUIET_STREAK_REQUIRED}
 * tick 安静才放行；累计超过 N tick 仍不安静则抛 {@code CP-EXEC-001}（响亮失败，不无限静默）。
 * 属性未设时该子状态永不进入，行为与既有实现逐 tick 等价。
 */
public final class WorldRebuildRunner {

    /** 重建机需要的一切（两个入口各自组装）。 */
    public static final class Spec {

        /** 托管世界目录名（必须以 {@code cp_} 开头）。 */
        public String folder;

        /** 固定种子（必填）。 */
        public long seed;

        /** 构建基点；可为 null。 */
        public int[] base;

        /** 静置 tick 数。 */
        public int settleTicks = 60;

        /** 展示名；null 时用目录名。 */
        public String displayName;

        /** 已归一化的构建步骤；可为空数组（表示只重建世界、不铺场景）。 */
        public JsonArray buildSteps = new JsonArray();
    }

    /** 内部阶段。 */
    private enum Stage {
        /** 离开当前世界。 */
        LEAVE,
        /** 删除托管存档目录。 */
        DELETE,
        /** 启动并进入世界。 */
        ENTER,
        /** 场景构建。 */
        BUILD,
        /** 场景构建前的 chunk 静默等待（仅 {@code -Dsde.cp.buildChunkQuietGateTicks=N}，N>0 时进入）。 */
        BUILD_QUIET_WAIT,
        /** 无构建段时的静置。 */
        SETTLE,
        /** 写标记与清单。 */
        MARKER,
        /** 完成。 */
        DONE
    }

    private final Spec spec;
    private final WorldLoader loader;
    private final ActionContext ctx;

    /** chunk 静默门：放行所需的连续安静 tick 数。 */
    private static final int QUIET_STREAK_REQUIRED = 5;

    private Stage stage = Stage.LEAVE;
    private SceneBuilder builder;
    private int settleLeft;
    private long enteredAtMillis;
    private JsonObject worldDescription;
    private JsonObject worldMarker;
    private JsonObject manifest;
    private long contentBytes = -1L;

    /** chunk 静默门是否已做过一次性入口检查（避免放行后回到 BUILD 时再次开启）。 */
    private boolean quietGateCleared;

    /** chunk 静默门已等待的 tick 数（只统计真正做了静默检查的 tick；世界未就位不计入）。 */
    private int quietWaited;

    /** chunk 静默门当前连续安静 tick 数。 */
    private int quietStreak;

    private final ProgressThrottle throttle = new ProgressThrottle();

    public WorldRebuildRunner(Spec spec, ActionContext ctx) {
        if (spec == null || spec.folder == null) {
            throw new IllegalArgumentException("重建规格不能为空");
        }
        this.spec = spec;
        this.ctx = ctx;
        this.loader = new WorldLoader(
            spec.folder,
            spec.displayName,
            Long.valueOf(spec.seed),
            spec.base == null ? null : spec.base.clone());
        this.settleLeft = Math.max(0, spec.settleTicks);
    }

    /** 已进入的世界描述；未进入时为 null。 */
    public JsonObject worldDescription() {
        return worldDescription == null ? null : Json.copyObject(worldDescription);
    }

    /** 场景清单；无构建段或未完成时为 null。 */
    public JsonObject manifest() {
        return manifest == null ? null : Json.copyObject(manifest);
    }

    /**
     * 当前内部阶段名（供动作层在阶段切换时重置阶段超时计时）。
     *
     * <p>
     * 意义：整段「重建」包含 离开→删除→进入→构建→静置→写标记 六步，其中只有「进入」可能耗掉
     * 数十秒（集成服启动 + 世界下发）。把它当成一个大阶段计时会让进入世界这一段的可用时间被前面的
     * 步骤吃掉；按内部阶段重置计时，每个子阶段都有自己的预算，超时信息也更精确。
     */
    public String stageName() {
        return stage.name();
    }

    /**
     * 推进一步。
     *
     * @return 完成时的结果对象；未完成返回 null
     */
    public JsonObject tick(Minecraft mc) throws Exception {
        switch (stage) {
            case LEAVE: {
                phase(0.05d, "leave-world");
                if (!loader.ensureLeft(mc)) {
                    return null;
                }
                stage = Stage.DELETE;
                return null;
            }
            case DELETE: {
                phase(0.15d, "delete-world");
                Path dir = ManagedWorld.requireManagedFolder(mc.mcDataDir, spec.folder, "folder");
                ManagedWorld.assertDeletable(dir, spec.folder, "world.rebuild");
                if (Files.exists(dir)) {
                    try {
                        FileTrees.deleteTree(dir);
                    } catch (Exception e) {
                        throw CpException.io("删除托管存档目录失败: " + dir, e);
                    }
                }
                CpLog.info("已清空托管存档目录 %s（重建）", spec.folder);
                ctx.emit(
                    EventStream.LEVEL_INFO,
                    EventStream.Kinds.WORLD_REBUILD,
                    "托管世界已清空待重建: " + spec.folder,
                    Json.object("folder", spec.folder, "seed", Long.valueOf(spec.seed)));
                stage = Stage.ENTER;
                return null;
            }
            case ENTER: {
                phase(0.3d, "enter-world");
                JsonObject desc = loader.ensureEntered(mc);
                if (desc == null) {
                    return null;
                }
                worldDescription = desc;
                enteredAtMillis = System.currentTimeMillis();
                stage = spec.buildSteps != null && spec.buildSteps.size() > 0 ? Stage.BUILD : Stage.SETTLE;
                return null;
            }
            case BUILD: {
                // chunk 静默门（默认关闭，#89 评论 1685 附带条件①）：只在「首次进入构建」前做一次性等待，
                // 等 chunk provider 没有加载在途再放行，避免撞上服务端线程的并发 chunk 加载（H1）。
                int gateMax = BuildDiagnostics.quietGateMaxTicks();
                if (builder == null && !quietGateCleared && gateMax > 0) {
                    quietGateCleared = true;
                    quietWaited = 0;
                    quietStreak = 0;
                    CpLog.info(
                        "chunk 静默门开启：上限 %d tick，需连续 %d tick 无 chunk 加载在途",
                        Integer.valueOf(gateMax),
                        Integer.valueOf(QUIET_STREAK_REQUIRED));
                    progress(0.45d, "chunk-quiet-wait 0/" + gateMax);
                    stage = Stage.BUILD_QUIET_WAIT;
                    return null;
                }
                phase(0.5d, "build-scene");
                if (builder == null) {
                    builder = new SceneBuilder(spec.buildSteps, spec.folder, spec.seed, true, spec.settleTicks);
                    CpLog.info(
                        "开始场景构建：%s，%d 步，静置 %d tick（提交到服务端线程执行）",
                        spec.folder,
                        Integer.valueOf(builder.stepCount()),
                        Integer.valueOf(spec.settleTicks));
                    // #89 根治（评论 1689）：构建写服务端世界必须发生在服务端线程，故交给泵推进，
                    // 本处只逐 tick 轮询结局（阶段名/超时/进度语义与改前一致）。
                    ServerBuildPump.instance()
                        .submit(builder);
                }
                JsonObject m = ServerBuildPump.instance()
                    .poll();
                if (m == null) {
                    int total = Math.max(1, builder.stepCount());
                    progress(
                        0.5d + 0.4d * ((double) builder.doneSteps() / (double) total),
                        "build " + builder.doneSteps() + "/" + builder.stepCount());
                    return null;
                }
                manifest = m;
                stage = Stage.MARKER;
                return null;
            }
            case BUILD_QUIET_WAIT: {
                // 门在等待途中被关掉（防御性：属性本就是启动期输入）：直接放行。
                int gateMax = BuildDiagnostics.quietGateMaxTicks();
                if (gateMax <= 0) {
                    stage = Stage.BUILD;
                    return null;
                }
                // 与 BUILD 分支同一取法：世界未就位就本 tick 返回、下 tick 再来，不计入等待预算。
                WorldServer quietWorld = WorldRuntime.serverWorld();
                if (quietWorld == null) {
                    progress(0.45d, "chunk-quiet-wait " + quietWaited + "/" + gateMax + "（服务端世界未就位）");
                    return null;
                }
                quietWaited++;
                if (BuildDiagnostics.chunkQuiet(quietWorld)) {
                    quietStreak++;
                } else {
                    quietStreak = 0;
                }
                if (quietStreak >= QUIET_STREAK_REQUIRED) {
                    CpLog.info(
                        "chunk 静默门放行：等待 %d tick 后连续 %d tick 安静",
                        Integer.valueOf(quietWaited),
                        Integer.valueOf(quietStreak));
                    stage = Stage.BUILD;
                    return null;
                }
                // 有界 + 响亮失败（不带 probe 的静默失败正是 #89 本身要根除的东西）。
                if (quietWaited > gateMax) {
                    throw new CpException(
                        ErrorCodes.EXEC_FAILED,
                        "chunk 静默等待超时（" + quietWaited + " tick 仍不安静）|" + BuildDiagnostics.probe(quietWorld));
                }
                progress(0.45d, "chunk-quiet-wait " + quietWaited + "/" + gateMax);
                return null;
            }
            case SETTLE: {
                phase(0.6d, "settle");
                if (settleLeft > 0) {
                    settleLeft--;
                    return null;
                }
                stage = Stage.MARKER;
                return null;
            }
            case MARKER: {
                phase(0.9d, "write-marker");
                // 世界描述里补上重建耗时与静置信息
                if (worldDescription != null) {
                    if (enteredAtMillis > 0) {
                        worldDescription
                            .addProperty("sinceEnterMs", Long.valueOf(System.currentTimeMillis() - enteredAtMillis));
                    }
                    worldDescription.addProperty("settleTicks", spec.settleTicks);
                }
                Path dir = ManagedWorld.requireManagedFolder(mc.mcDataDir, spec.folder, "folder");
                worldMarker = ManagedWorld.writeMarker(dir, spec.folder, spec.seed, true);
                writeSceneManifest(dir);
                JsonObject result = result();
                ctx.emit(
                    EventStream.LEVEL_INFO,
                    EventStream.Kinds.WORLD_REBUILD,
                    "托管世界重建完成: " + spec.folder,
                    Json.object(
                        "folder",
                        spec.folder,
                        "seed",
                        Long.valueOf(spec.seed),
                        "sceneSha256",
                        manifest == null ? null : Json.optString(manifest, "sha256", null)));
                stage = Stage.DONE;
                progress(1.0d, "done");
                return result;
            }
            default:
                return result();
        }
    }

    // ------------------------------------------------------------ 内部

    /** 把场景清单落两处：存档目录（作为世界产物）+ run 目录（作为 run 产物，evidence 口径）。 */
    private void writeSceneManifest(Path worldDir) {
        if (manifest == null) {
            return;
        }
        byte[] bytes = Json.toPretty(manifest)
            .getBytes(StandardCharsets.UTF_8);
        try {
            Files.write(worldDir.resolve(SceneManifest.FILE_NAME), bytes);
        } catch (Exception e) {
            throw CpException.io("写存档内场景清单失败: " + worldDir, e);
        }
        if (ctx == null || ctx.run() == null || ctx.artifacts() == null) {
            return;
        }
        ArtifactStore.Run run = ctx.run();
        ArtifactStore.Artifact a = ctx.artifacts()
            .writeArtifact(run, SceneManifest.RUN_RELATIVE_PATH, bytes, "scene-manifest");
        contentBytes = a.bytes();
    }

    private JsonObject result() {
        JsonObject o = new JsonObject();
        o.addProperty("schema", ManagedWorld.SCHEMA);
        o.addProperty("folder", spec.folder);
        o.addProperty("seed", spec.seed);
        o.addProperty("void", true);
        o.addProperty("generatorOptions", VoidWorldPreset.GENERATOR_OPTIONS);
        o.addProperty("voidSpec", VoidWorldPreset.DESCRIPTION);
        o.addProperty("settleTicks", spec.settleTicks);
        if (ctx != null && ctx.run() != null) {
            o.addProperty(
                "runId",
                ctx.run()
                    .runId());
        }
        if (worldDescription != null) {
            o.add("world", worldDescription);
        }
        if (worldMarker != null) {
            o.add("marker", worldMarker);
        }
        JsonObject scene = new JsonObject();
        if (manifest != null) {
            scene.addProperty("sha256", Json.optString(manifest, "sha256", null));
            scene.addProperty("sceneManifestSha256", Json.optString(manifest, "sha256", null));
            scene.addProperty("stepCount", Json.optInt(manifest, "stepCount", 0));
            scene.addProperty("blockCount", size(Json.optArray(manifest, "blocks")));
            scene.addProperty("teCount", size(Json.optArray(manifest, "tileEntities")));
            scene.addProperty("mismatchCount", size(Json.optArray(manifest, "mismatches")));
            scene.addProperty("manifestPath", SceneManifest.RUN_RELATIVE_PATH);
            if (contentBytes >= 0) {
                scene.addProperty("manifestBytes", contentBytes);
            }
            if (manifest.has("mismatches")) {
                scene.add("mismatches", Json.optArray(manifest, "mismatches"));
            }
            scene.add("manifest", manifest);
        } else {
            scene.addProperty("sha256", (String) null);
            scene.addProperty("sceneManifestSha256", (String) null);
            scene.addProperty("stepCount", 0);
            scene.addProperty("note", "无 build 段：只重建世界，未铺场景");
        }
        o.add("scene", scene);
        // case-file.md §8.7：world.rebuild 结果含 sceneManifestSha256（顶层与 scene 内各给一份，
        // 免得调用方猜它挂在哪一层）
        String sceneSha = manifest == null ? null : Json.optString(manifest, "sha256", null);
        o.addProperty("sceneManifestSha256", sceneSha);
        o.addProperty("sceneIdempotencyKey", sceneSha);
        return o;
    }

    /** 上报一个带语境的进度点（阶段名 + 进度）。 */
    private void phase(double fraction, String name) {
        progress(fraction, name);
    }

    private void progress(double fraction, String message) {
        if (ctx == null || !throttle.shouldReport(fraction)) {
            return;
        }
        try {
            ctx.progress(fraction, message);
        } catch (Throwable t) {
            CpLog.warn("进度上报失败: %s", String.valueOf(t));
        }
    }

    private static int size(JsonArray a) {
        return a == null ? 0 : a.size();
    }

    /** 供动作层把 {@code base} 传给 {@link WorldLoader}。 */
    public int[] base() {
        return spec.base == null ? null : spec.base.clone();
    }

    /** 便捷：断言目录形态（两个入口共用同一校验）。 */
    public static Path requireFolder(java.io.File mcDataDir, String folder) {
        return ManagedWorld.requireManagedFolder(mcDataDir, folder, "folder");
    }

    /** 供动作层做「非托管世界拒绝写」的前置判断。 */
    public static void assertManagedIfExists(java.io.File mcDataDir, String folder) {
        Path dir = ManagedWorld.requireManagedFolder(mcDataDir, folder, "folder");
        if (Files.isDirectory(dir) && !ManagedWorld.hasMarker(dir)) {
            throw new CpException(
                ErrorCodes.STATE,
                "目录已存在但不是托管世界（缺 " + ManagedWorld.MARKER + "）: " + folder,
                Json.object("folder", folder, "dir", dir.toString()));
        }
    }
}
