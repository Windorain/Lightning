package com.lightning.mod.client.controlplane.mc.export;

import java.io.File;
import java.nio.file.Files;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.lightning.mod.client.controlplane.core.ActionContext;
import com.lightning.mod.client.controlplane.core.ArtifactStore;
import com.lightning.mod.client.controlplane.core.Contract;
import com.lightning.mod.client.controlplane.core.CpException;
import com.lightning.mod.client.controlplane.core.ErrorCodes;
import com.lightning.mod.client.controlplane.core.EventStream;
import com.lightning.mod.client.controlplane.core.Json;
import com.lightning.mod.client.controlplane.mc.CpLog;
import com.lightning.mod.client.controlplane.mc.SteppingActionBase;
import com.lightning.mod.client.controlplane.mc.WorldRuntime;
import com.lightning.mod.client.export.ExportBundleClient;
import com.lightning.mod.core.export.RegistryDumpDelivery;

/**
 * {@code export.registry}（scene，步进）：{@code /sde dump} 的 cp 等价动作——把三份注册表写到<b>本 run 目录</b>
 * 并登记哈希清单（Gitea #102 裁决 7）。
 *
 * <h2>这是三条搬迁链路里唯一必须新增机制的一条</h2>
 *
 * {@code /sde dump} 的产物由<b>客户端 tick</b>写（{@link ExportBundleClient#writeFullRegistryDump}），
 * 而 run 目录由<b>作业</b>持有。两者只能通过一个显式投递单接头——{@link RegistryDumpDelivery}。
 * 动作在 {@code onBegin} 登记请求（落点 = 本 run 目录的 {@code registry/} 子目录，<b>绝对路径</b>），
 * 客户端 tick 消费后写出，动作在后续阶段校验并登记。
 *
 * <h2>★ 反模式：不要设计成「{@code /sde dump} 自己开一个 run」</h2>
 *
 * 命令通道跑在 {@code Server thread}，它<b>没有</b> {@code ActionContext}/{@code JobHandle}，
 * 拿不到 runId 也开不了 cp run。强行开 run 会产出「不属于任何 cp 作业」的孤儿 run，
 * 违反 contract.md §1.8 与 #96 §8.7。正确形态是<b>run 由发起方持有</b>：
 *
 * <ul>
 * <li>cp 通道：本动作开 run → 投递单指向该 run → 客户端写进去 → 本动作登记；</li>
 * <li>命令通道：{@code cmd.exec {command:"/sde dump"}} → {@code cmd.exec} 开 run（{@code caseId="cmd-exec"}）
 * → 投递单指向该 run → 产物同样进清单（C5 达成），且两条通道写的是<b>同一个写出体</b>
 * （{@code ExportBundleClient.writeFullRegistryDump}），满足 D2。</li>
 * </ul>
 *
 * <h2>投递单不进清单</h2>
 *
 * 请求件（{@code registry/dump-request.json}）是<b>内部件</b>：消费后删除，且<b>从不登记</b>——
 * 否则清单里会出现「一个指向自己的条目」这种自引用怪象。
 */
public final class ExportRegistryAction extends SteppingActionBase {

    /** 动作名。 */
    public static final String NAME = "export.registry";

    /** 产物子目录（run 目录内相对路径）。 */
    public static final String DIR = "registry";

    /** 投递单文件名（内部件；从不登记）。 */
    public static final String REQUEST_FILE = DIR + "/dump-request.json";

    /** 三份注册表与它们的 role（顺序即写出顺序，与 {@code ExportBundleClient} 一致）。 */
    public static final String[][] FILES = { { "block_registry.json", "registry-block" },
        { "material_registry.json", "registry-material" }, { "model_registry.json", "registry-model" } };

    /** 等待客户端消费的上限（tick）——按 20 tick/s 折算，600 tick ≈ 30 s。 */
    public static final int DEFAULT_WAIT_TICKS = 600;

    /** 客户端消费一次所需的最少 tick 数（投递单在 tick 排空器里被消费，本动作也在同一 tick 排空器里）。 */
    public static final int MIN_SETTLE_TICKS = 2;

    private RegistryDumpDelivery.Request request;
    private int waitedTicks;
    private int maxWaitTicks;
    private String registryDirAbs;
    private JsonArray artifacts;

    @Override
    protected void onBegin(ActionContext ctx) throws Exception {
        this.maxWaitTicks = ctx.optInt("waitTicks", DEFAULT_WAIT_TICKS);
        if (maxWaitTicks < MIN_SETTLE_TICKS) {
            throw CpException
                .param("waitTicks 过小", "waitTicks", "至少 " + MIN_SETTLE_TICKS + " tick（收到 " + maxWaitTicks + "）");
        }
        if (WorldRuntime.mc() == null || WorldRuntime.mc().theWorld == null) {
            throw new CpException(
                ErrorCodes.STATE,
                "客户端世界不可用：注册表 dump 需要方块图集已注册（TextureMap.mapRegisteredSprites）",
                Json.object(
                    "action",
                    NAME,
                    "stage",
                    "begin",
                    "hint",
                    "先 world.rebuild 进入托管世界，等图集就绪（进入世界后首个 tick 即就绪）；" + "命令通道 /sde dump 同样要求已进世界"));
        }

        ArtifactStore.Run run = ctx.beginRun("export-registry");
        File registryDir = run.resolve(DIR)
            .toFile();
        if (!registryDir.isDirectory() && !registryDir.mkdirs()) {
            throw CpException.io("无法创建注册表目录: " + registryDir.getAbsolutePath(), null);
        }
        this.registryDirAbs = registryDir.getAbsolutePath();
        this.artifacts = new JsonArray();
        this.waitedTicks = 0;

        // 投递单：落点由发起方（本动作）给出，客户端不推导（裁决 7 的核心）
        this.request = RegistryDumpDelivery.request(run.runId(), registryDir, NAME);
        if (request == null) {
            throw new CpException(
                ErrorCodes.BUSY,
                "已有一次注册表 dump 请求待客户端消费（投递单是单槽，幂等）",
                Json.object(
                    "action",
                    NAME,
                    "pendingRunId",
                    RegistryDumpDelivery.peek() == null ? null
                        : RegistryDumpDelivery.peek()
                            .runId(),
                    "hint",
                    "等它被消费（客户端 tick 每 tick 检查一次）后重试；或先查 export.session / read.run 确认是否已完成"));
        }

        // 内部件落盘（诊断用；从不登记）：让「这次 dump 是谁发的、落点在哪」在磁盘上可追溯
        JsonObject reqJson = new JsonObject();
        reqJson.addProperty("schema", RegistryDumpDelivery.SCHEMA);
        reqJson.addProperty("runId", run.runId());
        reqJson.addProperty("exportRoot", registryDirAbs);
        reqJson.addProperty("requestedBy", NAME);
        reqJson.addProperty("seq", request.seq());
        reqJson.addProperty("atEpochMs", request.atEpochMs());
        reqJson.addProperty("note", "内部件：客户端 tick 消费后写出三份注册表并删除本文件；本文件从不登记为 run 产物（避免自引用清单项）");
        // 直接写文件而**不**经 ArtifactStore：内部件不得进清单（否则清单里会出现指向自己的条目）
        try {
            Files.write(
                new File(registryDir, "dump-request.json").toPath(),
                Json.toPretty(reqJson)
                    .getBytes(java.nio.charset.StandardCharsets.UTF_8));
        } catch (java.io.IOException e) {
            throw CpException.io("写注册表投递单失败: " + REQUEST_FILE, e);
        }

        ctx.emit(
            EventStream.LEVEL_INFO,
            ExportSceneSupport.KIND_EXPORT,
            "注册表导出已请求: 落点 " + registryDirAbs,
            Json.object(
                "action",
                NAME,
                "runId",
                run.runId(),
                "exportRoot",
                registryDirAbs,
                "seq",
                Long.valueOf(request.seq()),
                "waitTicks",
                Integer.valueOf(maxWaitTicks)));

        enterStage("wait-client");
    }

    @Override
    protected JsonObject advance(ActionContext ctx) throws Exception {
        if ("wait-client".equals(stage())) {
            if (!request.done()) {
                waitedTicks++;
                if (waitedTicks > maxWaitTicks) {
                    // 超时：显式失败 + 上下文（不静默返回空清单）。收尾时释放单槽，避免堵住后续调用。
                    throw new CpException(
                        ErrorCodes.EXEC_TIMEOUT,
                        "等待客户端消费注册表投递单超时（" + waitedTicks + " tick）：客户端 tick 未消费（世界未加载 / 被探针避让挡住）",
                        Json.object(
                            "action",
                            NAME,
                            "stage",
                            "wait-client",
                            "waitedTicks",
                            Integer.valueOf(waitedTicks),
                            "maxWaitTicks",
                            Integer.valueOf(maxWaitTicks),
                            "exportRoot",
                            registryDirAbs,
                            "hint",
                            "确认已进世界（world.info.loaded=true）且控制面自身空闲（about.probeActive；#104 后该字段表达控制面自身忙闲）；"
                                + "探针激活时控制面 tick 层单向避让，不排空作业"),
                        null);
                }
                progress(
                    ctx,
                    Math.min(0.6d, waitedTicks / (double) maxWaitTicks),
                    "等待客户端写出注册表（" + waitedTicks + "/" + maxWaitTicks + " tick）");
                return null;
            }
            if (request.error() != null) {
                throw new CpException(
                    ErrorCodes.EXEC_FAILED,
                    "客户端写出注册表失败: " + request.error(),
                    Json.object(
                        "action",
                        NAME,
                        "stage",
                        "wait-client",
                        "exportRoot",
                        registryDirAbs,
                        "error",
                        request.error()));
            }
            enterStage("verify");
            return null;
        }

        if ("verify".equals(stage())) {
            JsonObject detail = new JsonObject();
            JsonArray present = new JsonArray();
            JsonArray missing = new JsonArray();
            for (String[] pair : FILES) {
                File f = new File(registryDirAbs, pair[0]);
                if (Files.isRegularFile(f.toPath()) && f.length() > 0) {
                    // gson 2.2.4 兼容：JsonArray 没有 add(String)，一律经 Json.add（内部包 new JsonPrimitive）
                    Json.add(present, pair[0]);
                } else {
                    Json.add(missing, pair[0]);
                }
            }
            detail.add("present", present);
            detail.add("missing", missing);
            if (missing.size() > 0) {
                throw new CpException(
                    ErrorCodes.EXEC_FAILED,
                    "注册表写出不完整：缺 " + missing.size() + " 份（" + missing + "）——不静默跳过",
                    Json.object(
                        "action",
                        NAME,
                        "stage",
                        "verify",
                        "exportRoot",
                        registryDirAbs,
                        "present",
                        present,
                        "missing",
                        missing,
                        "hint",
                        "客户端写出体（ExportBundleClient.writeFullRegistryDump）在任一份失败时会抛错；" + "此处缺失说明写出被中断或目录被外部改动"));
            }
            // schemaVersion 合法性（可解析性）：注册表消费方依赖它选解析路径
            JsonArray schemaErrors = new JsonArray();
            for (String[] pair : FILES) {
                File f = new File(registryDirAbs, pair[0]);
                try {
                    String text = new String(Files.readAllBytes(f.toPath()), java.nio.charset.StandardCharsets.UTF_8);
                    JsonObject o = Json.parseStrictObject(text);
                    if (!o.has("schemaVersion")) {
                        JsonObject e = new JsonObject();
                        e.addProperty("file", pair[0]);
                        e.addProperty("reason", "缺 schemaVersion（消费方据此选解析路径）");
                        schemaErrors.add(e);
                    }
                } catch (Exception ex) {
                    JsonObject e = new JsonObject();
                    e.addProperty("file", pair[0]);
                    e.addProperty("reason", String.valueOf(ex));
                    schemaErrors.add(e);
                }
            }
            if (schemaErrors.size() > 0) {
                throw new CpException(
                    ErrorCodes.EXEC_FAILED,
                    "注册表可解析性校验失败（" + schemaErrors.size() + " 份）",
                    Json.object("action", NAME, "stage", "verify", "errors", schemaErrors));
            }
            enterStage("register");
            return null;
        }

        if ("register".equals(stage())) {
            ArtifactStore store = ctx.artifacts();
            ArtifactStore.Run run = ctx.run();
            for (String[] pair : FILES) {
                ArtifactStore.Artifact a = store.registerArtifact(run, DIR + "/" + pair[0], pair[1]);
                JsonObject o = new JsonObject();
                o.addProperty("file", pair[0]);
                o.addProperty("path", a.path());
                o.addProperty("bytes", a.bytes());
                o.addProperty("sha256", a.sha256());
                o.addProperty("role", a.role());
                artifacts.add(o);
            }
            // 内部件：消费后删除（且从不登记）——避免「指向自己的清单项」
            File reqFile = new File(registryDirAbs, "dump-request.json");
            boolean deleted = !reqFile.exists() || reqFile.delete();
            if (!deleted) {
                CpLog.warn("[SDE][CP] export.registry 无法删除内部投递单: %s", reqFile.getAbsolutePath());
            }

            JsonObject result = new JsonObject();
            result.addProperty("schema", ExportSceneSupport.SCHEMA_REGISTRY_RESULT);
            result.addProperty("contractVersion", Contract.VERSION);
            result.addProperty("action", NAME);
            result.addProperty("runId", run == null ? null : run.runId());
            result.addProperty("exportRoot", registryDirAbs);
            result.add("artifacts", artifacts);
            result.addProperty("artifactCount", artifacts.size());
            result.addProperty("waitedTicks", waitedTicks);
            result.addProperty("requestSeq", request.seq());
            result.addProperty("requestFileRemoved", deleted);
            result.addProperty(
                "note",
                "三份注册表落在本 run 目录的 registry/ 下并登记 sha256（裁决 6 单一归属 + C5）。"
                    + "与命令通道 /sde dump 共用同一个写出体（ExportBundleClient.writeFullRegistryDump），"
                    + "故 D2 的产物语义比对是机械成立的；差别只有落点（本 run 目录 vs CWD 相对 structure_exports/）"
                    + "与清单登记。内部件 dump-request.json 已删除且从不登记。");
            for (JsonObject a : jsonObjects(artifacts)) {
                ctx.emit(
                    EventStream.LEVEL_INFO,
                    ExportSceneSupport.KIND_EXPORT,
                    "注册表产物: " + Json.optString(a, "path", "?") + "（role " + Json.optString(a, "role", "?") + "）",
                    a);
            }
            enterStage("done");
            return result;
        }

        throw new CpException(ErrorCodes.EXEC_FAILED, "未知阶段: " + stage());
    }

    @Override
    protected void onFinish(ActionContext ctx) {
        // 失败路径必须释放单槽：否则一次超时会让后续所有 dump 调用都撞 CP-BUSY-001
        if (request != null && !request.done()) {
            RegistryDumpDelivery.clear();
            RegistryDumpDelivery.finish(request, "动作收尾（阶段 " + stage() + "）：投递单已释放");
            CpLog.warn("[SDE][CP] export.registry 收尾：释放未消费的投递单（阶段 %s）", stage());
        }
    }

    private static java.util.List<JsonObject> jsonObjects(JsonArray arr) {
        java.util.List<JsonObject> out = new java.util.ArrayList<JsonObject>();
        for (int i = 0; i < arr.size(); i++) {
            out.add(
                arr.get(i)
                    .getAsJsonObject());
        }
        return out;
    }
}
