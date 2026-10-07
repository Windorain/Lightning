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
 * <li><b>标记前置</b>：写带 {@code complete:false} 的 {@code cp_world.json}（#123，见下）；</li>
 * <li>{@code launchIntegratedServer(folder, display, WorldSettings(seed, CREATIVE, false, false, FLAT)
 * + 空层预设)}；</li>
 * <li>等进世界（超时由动作层的阶段超时给 {@code CP-EXEC-002}）；</li>
 * <li>（可选）执行场景构建段 —— 由调用方喂入 {@link SceneBuilder}；</li>
 * <li>静置 {@code settleTicks}（构建段内部收尾，无构建段时本机自己等）；</li>
 * <li>标记收口：把标记改写为 {@code complete:true}，写 {@code scene-manifest.json}
 * （存档目录 + run 目录），返回世界描述与场景清单哈希。</li>
 * </ol>
 *
 * <h2>标记前置（issue #123）—— 为什么必须发生在「进世界之前」</h2>
 *
 * <p>
 * 标记本来就<b>只在最末的 MARKER 阶段</b>写：build 阶段失败即在存档根留下「有世界文件、无标记」
 * 的残留，而删除与重建都要求「带标记」⇒ <b>没有任何 API 能清掉它</b>（#117 段二实机擒获 D-2，
 * 只能手工删目录）。修法是标记前置：本阶段把 {@code complete:false} 的标记<b>先</b>落下，
 * 构建成功后（MARKER 阶段）改写为 {@code complete:true}。
 *
 * <p>
 * 前置点选在「删除之后、进世界之前」而不是「进世界之后」，理由是<b>覆盖全部失败点</b>：
 * {@code launchIntegratedServer} 与等进世界都会写存档文件（集成服一启动就建 {@code level.dat}
 * 与 region），若把前置点放在它们之后就仍会漏出一个「有世界文件、无标记」的窗口——而那正是
 * 本单要消灭的状态。放在进世界之前后，ARM 之后的每个失败点（启动、等待、build、settle）
 * 都在标记覆盖之下。ARM 自身失败（写盘失败）时目录是空的（DELETE 刚清过），不构成残留。
 *
 * <p>
 * 语义（消费方必须照此判读，contract.md §6.1）：{@code complete:false} =
 * 「曾经开始过、可以删可以重建，但<b>不得</b>当作构建完成的世界复用」——场景可能只铺了一半、
 * TE 补全可能未完成。判据分两处：{@link ManagedWorld#hasMarker}（可以删/重建）与
 * {@link ManagedWorld#isComplete}／{@link ManagedWorld#assertCompleteWorld}（可当成品复用）。
 *
 * <p>
 * 幂等性：同参数两次执行的场景清单 {@code sha256} 必然相等——哈希只覆盖「世界实际状态」
 * （见 {@link SceneManifest}），而步骤与种子都是固定输入。
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

        /**
         * 本段收尾时是否把标记改写为 {@code complete:true}（{@code #123}）。
         *
         * <p>
         * 默认 {@code true}：{@code world.rebuild} 的构建段在本机内部，MARKER 阶段即「世界 + 场景」
         * 都已完成，可以收口。
         *
         * <p>
         * {@code case.run} 的 {@code world} 段在同一次运行里<b>后面还有一个独立的 build 段</b>，
         * 此时必须置 {@code false}：否则世界段一收口就把标记写成 {@code complete:true}，
         * 而随后的 build 段失败会留下「标记说完成、场景只铺了一半」的世界——那会让下游
         * （如 {@code world.snapshot} 的成品复用门）误判为可复用。{@code case.run} 在 build 段
         * 成功后才自行收口（见 {@code CaseRunAction.stepBuild}）。
         */
        public boolean markComplete = true;
    }

    /** 内部阶段。 */
    private enum Stage {
        /** 离开当前世界。 */
        LEAVE,
        /** 删除托管存档目录。 */
        DELETE,
        /** 标记前置：写带 {@code complete:false} 的标记（见类注释「标记前置」）。 */
        ARM,
        /** 启动并进入世界。 */
        ENTER,
        /** 场景构建。 */
        BUILD,
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

    private Stage stage = Stage.LEAVE;
    private SceneBuilder builder;
    private int settleLeft;
    private long enteredAtMillis;
    private JsonObject worldDescription;
    private JsonObject worldMarker;
    private JsonObject manifest;
    private long contentBytes = -1L;
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
                stage = Stage.ARM;
                return null;
            }
            case ARM: {
                phase(0.2d, "arm-marker");
                worldMarker = armMarker(mc.mcDataDir, spec.folder, spec.seed);
                CpLog.info("已前置写托管标记（complete:false，失败残留可重建）: %s", spec.folder);
                ctx.emit(
                    EventStream.LEVEL_INFO,
                    EventStream.Kinds.WORLD_REBUILD,
                    "托管世界标记已前置（构建中）: " + spec.folder,
                    Json.object("folder", spec.folder, "seed", Long.valueOf(spec.seed), "complete", Boolean.FALSE));
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
                phase(0.5d, "build-scene");
                if (builder == null) {
                    builder = new SceneBuilder(spec.buildSteps, spec.folder, spec.seed, true, spec.settleTicks);
                    CpLog.info(
                        "开始场景构建：%s，%d 步，静置 %d tick",
                        spec.folder,
                        Integer.valueOf(builder.stepCount()),
                        Integer.valueOf(spec.settleTicks));
                }
                WorldServer world = WorldRuntime.serverWorld();
                JsonObject m = builder.tick(world);
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
                worldMarker = closeMarker(dir, spec.folder, spec.seed, spec.markComplete);
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

    // ------------------------------------------------------------ 标记生命周期（可离线测的接缝）

    /**
     * <b>标记前置</b>（{@code #123}，{@link Stage#ARM} 的全部副作用）：二次确认 + 写
     * {@code complete:false} 的标记。
     *
     * <p>
     * 抽成静态方法是为了让单测<b>驱动生产路径</b>而不是自己拼一份标记：本方法的调用序
     * （先 {@code assertDeletable} 再写盘）正是安全属性所在，测试直接调它才锁得住。
     *
     * @return 落盘的标记对象
     * @throws CpException CP-STATE-001 目录未过删除确认（无标记且非空）；CP-IO-001 写盘失败
     */
    public static JsonObject armMarker(java.io.File mcDataDir, String folder, long seed) {
        Path dir = ManagedWorld.requireManagedFolder(mcDataDir, folder, "folder");
        ManagedWorld.assertDeletable(dir, folder, "world.rebuild");
        return ManagedWorld.writeMarker(dir, folder, seed, true, false);
    }

    /**
     * <b>标记收口</b>（{@link Stage#MARKER} 的标记部分）：把前置的 {@code complete:false} 改写为
     * {@code complete:true}；{@code markComplete=false} 时保持未完成（{@code case.run} 后面还有
     * 独立 build 段的场景，见 {@link Spec#markComplete}）。
     *
     * @return 收口后的标记对象（保持未完成时为当前标记）
     */
    public static JsonObject closeMarker(Path dir, String folder, long seed, boolean markComplete) {
        if (!markComplete) {
            // 本段后面还有独立的 build 段（case.run）：保持 complete:false，由 build 段收口。
            CpLog.info("本段不收口标记（后面还有 build 段）: %s 保持 complete:false", folder);
            return ManagedWorld.readMarker(dir);
        }
        // 标记收口（#123）：ARM 阶段的前置标记在此翻为 complete:true。此后本目录才允许被当作
        // 「构建完成的成品世界」复用（如 world.snapshot 整目录复制）。
        return ManagedWorld.promoteMarker(dir, folder, seed, true);
    }

    /** 供动作层把 {@code base} 传给 {@link WorldLoader}。 */
    public int[] base() {
        return spec.base == null ? null : spec.base.clone();
    }

    /** 便捷：断言目录形态（两个入口共用同一校验）。 */
    public static Path requireFolder(java.io.File mcDataDir, String folder) {
        return ManagedWorld.requireManagedFolder(mcDataDir, folder, "folder");
    }

    /**
     * 供动作层做「非托管世界拒绝写」的前置判断（安全属性：<b>无标记的目录一律拒绝</b>）。
     *
     * <p>
     * 判据刻意保持为「有没有标记」而不看 {@code complete}：本方法的职责是安全边界（不碰非托管
     * 目录），不是可用性边界。带 {@code complete:false} 标记的失败残留<b>允许通过</b>——
     * 它正是 #123 要救回的那类目录，重跑重建会自行删除并重建它。
     */
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
