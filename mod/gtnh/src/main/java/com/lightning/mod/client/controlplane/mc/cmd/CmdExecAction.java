package com.lightning.mod.client.controlplane.mc.cmd;

import java.io.File;
import java.util.List;

import net.minecraft.entity.player.EntityPlayerMP;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.lightning.mod.client.controlplane.core.ActionContext;
import com.lightning.mod.client.controlplane.core.Contract;
import com.lightning.mod.client.controlplane.core.ControlAction;
import com.lightning.mod.client.controlplane.core.CpException;
import com.lightning.mod.client.controlplane.core.ErrorCodes;
import com.lightning.mod.client.controlplane.core.EventStream;
import com.lightning.mod.client.controlplane.core.Json;
import com.lightning.mod.client.controlplane.mc.CpLog;
import com.lightning.mod.client.controlplane.mc.WorldRuntime;

/**
 * {@code cmd.exec}：白名单内 {@code /sde} 子命令的**服务端线程**执行通道（命令通道的承重件）。
 *
 * <h2>职责边界</h2>
 *
 * 本动作只做三件事，<b>不</b>做第四件：
 *
 * <ol>
 * <li><b>查白名单</b>——唯一权威是 {@link SdeCommandWhitelist}，本类不内联任何子命令名；</li>
 * <li><b>拒绝</b>——白名单外一律显式拒绝：错误码 + 原因 + <b>可行替代</b>（失败显式）；</li>
 * <li><b>转发执行</b>——把命令原样交给 {@link ServerCommandInvoker}（服务端线程、真实回报），
 * 并把「命令文本 / 回报 / 产物」三样如实落事件流水（任务单「真实回报…调用与产物如实入 run 审计」）。</li>
 * </ol>
 *
 * <p>
 * <b>不做</b>的是：不自己实现任何命令语义、不解析 {@code /sde} 的参数、不在命令前后追加或跳过任何步骤。
 * 这是「命令不扭曲行为」的直接落地——本动作是<b>通道</b>，不是<b>第二套实现</b>。
 *
 * <h2>为什么「白名单」而不是「拒绝一切命令」</h2>
 *
 * 通用命令执行（能跑 {@code /op}、{@code /give}、{@code /tp}）会把控制面变成「任何 MC 状态的写入口」，
 * 那与 L0 原语面的边界（由 {@code scene.*} 原语面承担）重合且更弱：原语面有参数校验、
 * 有产物、有判据可引用；裸命令什么都没有。白名单模式把能力面限制在<b>本职所需</b>的 {@code /sde} 家族，
 * 每条都有明确语义、且都能被 {@code export.session} 读面验证——这才是「可判定」的通道。
 *
 * <h2>审计（产物可复核）</h2>
 *
 * 每次调用（含<b>拒绝</b>）都落一条 {@code cmd-exec} 事件，{@code data} 携带：
 * {@code command}（提交文本）、{@code allowed}（是否白名单内）、{@code sub}、{@code tier}、
 * {@code status}/{@code executedOnThread}/{@code serverTick}/{@code elapsedMs}（执行类）、
 * {@code reply}（真实回报全文）、{@code artifacts}（本次命令声明的产物路径）。
 *
 * <p>
 * 产物登记：{@code export}/{@code dump} 会产生文件（{@code structure_exports/...}）。这些文件落在
 * <b>CWD 相对路径</b>下（{@code runClient} 下 CWD == mcDataDir），<b>不在</b> cp 的 run 目录内，
 * 因此本动作<b>把路径与是否存在如实写进结果的 {@code artifacts[]}</b>，但不假造 run 清单条目——
 * 产物纪律收口（迁入 run 目录并入哈希清单）属后续范围，本次不搬迁。
 * 这符合「产物显式：每个动作声明它产出什么」：声明了、可发现（事件流水 + 结果字段），
 * 只是不走 run 清单那条尚未迁移的路径。
 *
 * <h2>D1/D3/D4 自检口径</h2>
 *
 * <ul>
 * <li><b>D1 自述完备</b>：注册处（{@code ActionRegistrar}）逐参数写全，并附白名单全表与排除理由；</li>
 * <li><b>D3 默认值可见</b>：{@code timeoutMs} 默认值来自 {@link ServerCommandInvoker#DEFAULT_TIMEOUT_MS}，
 * 在自描述里以字面默认值出现；{@code command} 为必填（无默认）；</li>
 * <li><b>D4 失败显式</b>：四类失败各有稳定码与上下文——白名单外 {@code CP-VALID-002}、
 * 无服务端玩家 {@code CP-STATE-001}、等待超时 {@code CP-EXEC-002}、命令内部异常 {@code CP-EXEC-001}。</li>
 * </ul>
 */
public final class CmdExecAction implements ControlAction {

    /** 单次调用允许的最大命令长度（防误把整份脚本塞进来）。 */
    public static final int MAX_COMMAND_LENGTH = 512;

    /** 正常执行（命令跑完，无论语义成败）的默认等待上限，见 {@link ServerCommandInvoker}。 */
    public static final long DEFAULT_TIMEOUT_MS = ServerCommandInvoker.DEFAULT_TIMEOUT_MS;

    /** 事件 kind：命令通道调用（含拒绝）。 */
    public static final String KIND_CMD_EXEC = "cmd-exec";

    @Override
    public JsonObject execute(ActionContext ctx) {
        String raw = ctx.optString("command", null);
        if (raw == null || raw.trim()
            .isEmpty()) {
            throw CpException.param("缺少必填参数", "command", "必填，形如 \"/sde status\" 或 \"sde status\"");
        }
        if (raw.length() > MAX_COMMAND_LENGTH) {
            throw CpException
                .param("参数非法", "command", "长度 " + raw.length() + " 超过上限 " + MAX_COMMAND_LENGTH + "（本通道只服务单条 /sde 子命令）");
        }
        long timeoutMs = ctx.optLong("timeoutMs", DEFAULT_TIMEOUT_MS);

        Parsed parsed = Parsed.of(raw);
        SdeCommandWhitelist.Decision decision = SdeCommandWhitelist.classify(parsed.root, parsed.sub);

        if (decision != SdeCommandWhitelist.Decision.ALLOWED) {
            throw reject(ctx, raw, parsed, decision, timeoutMs);
        }

        SdeCommandWhitelist.Entry entry = SdeCommandWhitelist.entry(parsed.sub);
        // 权限级按内容升格（任务单「权限与 confirm 按契约定级（写操作类命令升格）」）：
        // 动作静态级是 scene（可写级 ⇒ 框架已强制 confirm:true）；这里再做一次「按内容」的运行期判定，
        // 使得即便调用方只有 scene 级 token，也 <b>不可能</b>执行一条被登记为更高权限级的子命令。
        requireTier(ctx, entry);

        ServerCommandInvoker.ensureRegistered();
        EntityPlayerMP player = WorldRuntime.serverPlayer();
        if (player == null) {
            JsonObject data = auditData(raw, parsed, true, entry, timeoutMs);
            data.addProperty("status", ServerCommandInvoker.STATUS_NO_SERVER);
            ctx.emit(EventStream.LEVEL_WARN, KIND_CMD_EXEC, "命令通道失败（无服务端玩家）: " + parsed.normalized, data);
            throw new CpException(
                ErrorCodes.STATE,
                "没有服务端玩家：控制面已连上，但客户端未进入世界或集成服未启动",
                Json.object(
                    "command",
                    parsed.normalized,
                    "sub",
                    parsed.sub,
                    "hint",
                    "先经 world.rebuild / world.info 确认已进入可用世界；cmd.exec 需要真实玩家作为命令发送者"
                        + "（/sde 多个子命令要求 EntityPlayerMP）"));
        }

        ServerCommandInvoker.Result r = ServerCommandInvoker.execute(parsed.normalized, player, timeoutMs);

        // run 归属（单一归属 + run 由发起方持有）：命令通道的产物同样要进 run 清单。
        // run 由**发起方**持有——这里就是发起方（cmd.exec 自己开 run，caseId="cmd-exec"）。
        // 只有会产出文件的子命令才开 run（否则每次只读命令都留一个空 run 目录，污染产物面）。
        com.lightning.mod.client.controlplane.core.ArtifactStore.Run run = null;
        if (PRODUCING_SUBS.contains(parsed.sub)) {
            run = ctx.beginRun("cmd-exec");
        }

        JsonObject result = new JsonObject();
        result.addProperty("schema", "lightning.cp-cmd-exec/1");
        result.addProperty("contractVersion", Contract.VERSION);
        result.addProperty("command", r.command());
        result.addProperty("sub", parsed.sub);
        result.addProperty(
            "tier",
            entry == null ? null
                : entry.tier()
                    .id());
        result.addProperty("status", r.status());
        result.addProperty("reply", r.replyText());
        result.addProperty("runId", run == null ? null : run.runId());

        JsonArray replies = new JsonArray();
        for (String line : r.replies()) {
            Json.add(replies, line);
        }
        result.add("replies", replies);
        result.addProperty(
            "replyLineCount",
            r.replies()
                .size());
        result.addProperty("executedOnThread", r.executedOnThread());
        result.addProperty("serverTick", r.serverTick());
        result.addProperty("elapsedMs", r.elapsedMs());
        result.addProperty("timeoutMs", timeoutMs);
        result.addProperty("senderName", player.getCommandSenderName());
        // 命令跑完后立刻取一次单例态快照：调用方不必再调 export.session 就能看到「命令生效后的状态」。
        // 这是附加字段（不是替代）——export.session 仍是唯一的结构化读面，此处只是省一次往返。
        result.add("sessionAfter", ExportSessionAction.snapshotJson());

        JsonArray artifacts = artifactsFor(parsed.sub, r, ctx, run);
        result.add("artifacts", artifacts);

        JsonObject data = auditData(raw, parsed, true, entry, timeoutMs);
        data.addProperty("status", r.status());
        data.addProperty("executedOnThread", r.executedOnThread());
        data.addProperty("serverTick", r.serverTick());
        data.addProperty("elapsedMs", r.elapsedMs());
        data.addProperty("reply", r.replyText());
        data.add("artifacts", artifacts);
        // 回报文本本身也落一条独立的 info 事件，便于只按 message 检索审计流水。
        ctx.emit(EventStream.LEVEL_INFO, KIND_CMD_EXEC, "命令通道执行: " + r.command(), data);
        ctx.log(
            "cmd.exec " + r.command()
                + " → "
                + r.status()
                + "（"
                + r.elapsedMs()
                + "ms，回报 "
                + r.replies()
                    .size()
                + " 行）");

        if (ServerCommandInvoker.STATUS_TIMEOUT.equals(r.status())) {
            throw new CpException(
                ErrorCodes.EXEC_TIMEOUT,
                "命令在服务端线程等待超时（" + r.elapsedMs() + "ms）：服务端未运行或单 tick 耗时过长",
                Json.object(
                    "command",
                    r.command(),
                    "sub",
                    parsed.sub,
                    "timeoutMs",
                    Long.valueOf(timeoutMs),
                    "elapsedMs",
                    Long.valueOf(r.elapsedMs())),
                null);
        }
        if (ServerCommandInvoker.STATUS_EXCEPTION.equals(r.status())) {
            throw new CpException(
                ErrorCodes.EXEC_FAILED,
                "命令在服务端线程抛出异常: " + r.error(),
                Json.object("command", r.command(), "sub", parsed.sub, "exception", r.error()),
                null);
        }
        return result;
    }

    // ------------------------------------------------------------ 拒绝

    /**
     * 白名单外的显式拒绝：错误码 + 原因 + 可行替代（失败显式：拒绝必须给出路）。
     *
     * <p>
     * 四类拒绝各有专属原因文案与替代建议，且<b>全部落事件流水</b>（拒绝也是调用，契约 §2 第 7 条：
     * 「每一次动作调用（含拒绝）追加一条事件流水记录」）。
     */
    private CpException reject(ActionContext ctx, String raw, Parsed parsed, SdeCommandWhitelist.Decision decision,
        long timeoutMs) {
        String reason;
        JsonObject context = Json
            .object("command", parsed.normalized, "root", parsed.root, "sub", parsed.sub, "decision", decision.name());
        switch (decision) {
            case EXCLUDED: {
                reason = "子命令 " + parsed.sub + " 在排除清单内：" + SdeCommandWhitelist.exclusionReason(parsed.sub);
                context.addProperty("excluded", true);
                context.addProperty("exclusionReason", SdeCommandWhitelist.exclusionReason(parsed.sub));
                break;
            }
            case NOT_WHITELISTED: {
                reason = "/sde 子命令 " + parsed.sub + " 不在白名单内（白名单是显式枚举，新增子命令必须显式登记；未登记即拒绝，不做默认放行）";
                context.addProperty("whitelist", String.join(", ", SdeCommandWhitelist.allowedSubcommands()));
                break;
            }
            case NOT_SDE:
            default: {
                reason = "非 /sde 命令（根命令 " + parsed.root
                    + "）：本通道只服务 /sde 家族的白名单子命令。通用命令执行会把控制面变成任意 MC 状态的写入口，"
                    + "与 L0 原语面的边界重合且更弱（无参数校验、无判据可引用），故不开放。";
                context.addProperty("whitelist", String.join(", ", SdeCommandWhitelist.allowedSubcommands()));
                break;
            }
        }
        JsonArray alt = alternativesFor(parsed, decision);
        context.add("alternatives", alt);
        context.addProperty("alternativeHint", alt.size() == 0 ? "无等价替代" : "见 context.alternatives[*].action / .how");

        JsonObject data = auditData(raw, parsed, false, null, timeoutMs);
        data.addProperty("decision", decision.name());
        data.addProperty("reason", reason);
        data.add("alternatives", alt);
        ctx.emit(EventStream.LEVEL_WARN, KIND_CMD_EXEC, "命令通道拒绝: " + parsed.normalized, data);
        CpLog.warn("cmd.exec 拒绝 %s：%s", parsed.normalized, reason);

        // 错误码：白名单外一律 CP-VALID-002（参数非法），context.fields 逐字段说明（契约 §6）。
        JsonObject fields = new JsonObject();
        JsonArray arr = new JsonArray();
        JsonObject f = new JsonObject();
        f.addProperty("field", "command");
        f.addProperty("reason", reason);
        arr.add(f);
        fields.add("fields", arr);
        context.add("fields", arr);
        return new CpException(ErrorCodes.VALID_PARAM, "命令不在白名单内", context);
    }

    /**
     * 「可行替代」表（失败显式：拒绝必须给出路）。
     *
     * <p>
     * 三类替代：①本通道内的合法写法（如 {@code web} → 无等价，需人工）；②cp 已注册的**动作**入口
     * （如 {@code hajimi} → {@code setname}+{@code record}+{@code export}，或直接 {@code export.session}
     * 自查状态）；③明确宣告「无等价替代」而不是含糊其辞——含糊的替代建议等于没有建议。
     */
    private static JsonArray alternativesFor(Parsed parsed, SdeCommandWhitelist.Decision decision) {
        JsonArray out = new JsonArray();
        String sub = parsed.sub == null ? "" : parsed.sub;
        switch (sub) {
            case "web":
            case "webstop":
                add(out, "manual", "/sde " + sub, "在游戏内聊天框手动执行（控制面不代理内置工作区 HTTP 服务的启停）");
                add(out, "note", "无 API 等价替代", "内置工作区服务与控制面是两套独立鉴权域（contract.md §14），控制面刻意不暴露它的启停口");
                break;
            case "hajimi":
            case "hjm":
                add(out, "cmd.exec", "sub=setname", "cmd.exec {command:\"/sde setname <名字>\"} 设置输出名");
                add(out, "cmd.exec", "sub=record", "cmd.exec {command:\"/sde record\"} 把当前选区扫入活动帧");
                add(out, "cmd.exec", "sub=export", "cmd.exec {command:\"/sde export\"} 写出场景文件");
                add(
                    out,
                    ALT_ACTION_EXPORT_SESSION,
                    "export.session",
                    "设完状态后用 export.session 自查单例态（会话/选区/活动帧/已录帧），不必靠截图或猜");
                break;
            default:
                add(
                    out,
                    ALT_ACTION_EXPORT_SESSION,
                    "export.session",
                    "若目的是「读回 ExportSession 单例态」（会话/选区/活动帧/已录帧），用只读动作 export.session");
                add(out, ALT_ACTION_WORLD_INFO, "world.info", "若目的是「看世界状态」，用只读动作 world.info");
                if (SdeCommandWhitelist.Decision.NOT_WHITELISTED == decision && !sub.isEmpty()) {
                    add(
                        out,
                        "whitelist",
                        String.join(", ", SdeCommandWhitelist.allowedSubcommands()),
                        "白名单内的可通过子命令：cmd.exec {command:\"/sde <sub>\"}（见 choices）");
                }
                break;
        }
        return out;
    }

    /** {@code export.session} 的动作名。 */
    public static final String ALT_ACTION_EXPORT_SESSION = SdeCommandWhitelist.ALT_SESSION;

    /** {@code world.info} 的动作名。 */
    public static final String ALT_ACTION_WORLD_INFO = "world.info";

    private static void add(JsonArray arr, String kind, String action, String how) {
        JsonObject o = new JsonObject();
        o.addProperty("kind", kind);
        o.addProperty("action", action);
        o.addProperty("how", how);
        arr.add(o);
    }

    // ------------------------------------------------------------ 权限与审计

    /** 运行期按内容升格检查：调用方 token 必须覆盖该子命令登记的权限级。 */
    private static void requireTier(ActionContext ctx, SdeCommandWhitelist.Entry entry) {
        if (entry == null || entry.tier() == null || ctx.job() == null) {
            return;
        }
        com.lightning.mod.client.controlplane.core.Tier required = entry.tier();
        com.lightning.mod.client.controlplane.core.Tier actual = ctx.job()
            .tier();
        if (!actual.covers(required)) {
            throw CpException.insufficientTier(required, actual);
        }
    }

    /** 审计用的事件 data 骨架（拒绝与执行共用，字段名一致便于检索）。 */
    private static JsonObject auditData(String raw, Parsed parsed, boolean allowed, SdeCommandWhitelist.Entry entry,
        long timeoutMs) {
        JsonObject data = Json.object(
            "commandText",
            raw,
            "command",
            parsed.normalized,
            "root",
            parsed.root,
            "sub",
            parsed.sub,
            "allowed",
            Boolean.valueOf(allowed),
            "timeoutMs",
            Long.valueOf(timeoutMs),
            "whitelistVersion",
            WHITELIST_VERSION);
        if (entry != null) {
            data.addProperty(
                "tier",
                entry.tier()
                    .id());
        }
        return data;
    }

    /** 白名单表版本：表内容变更时递增，使历史事件的「按哪一版白名单判定」可追溯。 */
    public static final String WHITELIST_VERSION = "1";

    /**
     * 声明本次命令会/已产生哪些文件产物，并把它们<b>排进 run 清单的延迟登记队列</b>（单一归属）。
     *
     * <h2>从「声明」升级为「登记」（本次的改动点）</h2>
     *
     * 原先的口径是「如实声明 {@code {role,path,exists,note}}，但不假造 run 清单条目」——因为产物
     * 落在 CWD 相对的 {@code structure_exports/} 下，与 cp run 无关。D2 要两侧都有哈希可比，
     * 因此本次把它升级为：<b>把实际产出的文件写进 {@code cmd.exec} 自己 run 的 {@code cmd-exec/}
     * 子目录并登记 sha256</b>（复制而不是引用：run 目录必须自洽可下载，
     * {@code GET /cp/v1/artifacts/{runId}/{path}} 只服务 run 目录内的路径）。
     *
     * <h2>为什么是「延迟」而不是「立刻复制」（第一版实测踩的坑）</h2>
     *
     * 命令通道的两类产物在命令返回时<b>都还不是终态</b>：
     *
     * <ul>
     * <li><b>{@code export}</b>：服务端线程先写一份 {@code geometryPhase=scan} 中间态并投网络包，
     * 客户端在<b>下一个 tick</b> 才用 enrich 覆盖写同名文件。命令返回时复制 = 复制到<b>半成品</b>
     * （实测：登记下来的产物 {@code geometryPhase=scan}、带 {@code cellTypes}/{@code worldGrid}，
     * 与 cp 通道的 baked 产物语义不同 ⇒ D2 必然判红，且红得没有意义）。</li>
     * <li><b>{@code dump}</b>：三份注册表由<b>客户端 tick</b>写出，命令返回时还不存在。</li>
     * </ul>
     *
     * <p>
     * 而 {@code cmd.exec} 跑在<b>客户端 tick 线程</b>——那正是唯一能推进上面两件事的线程。
     * 在动作里等（sleep/自旋）＝ 掐死推进者 ⇒ <b>构造性死锁</b>（第一版正是这么写的，
     * 实测表现为「等待客户端写出注册表超时」）。因此改为：<b>排进
     * {@link CommandArtifactRegistrar} 队列并立即返回</b>，由 {@code ControlPlaneTickHandler}
     * 每 tick 推进一步，直到文件已是终态（或超过截止时刻，那时如实登记当时的字节 + phase 说明）。
     *
     * <p>
     * 结果里因此如实写 {@code registered:false, deferred:true, deadlineTicks:N}——
     * <b>不假装登记已完成</b>；登记实际发生后，清单与 {@code cp-export} 事件里能看到带 sha256 的条目。
     *
     * <p>
     * <b>拿不到字节的子命令</b>（{@code multiblock}）如实给 {@code registered:false} + 原因
     * ——它是异步长跑（客户端 tick 在主菜单后执行），且落点是配置项决定的目录，不在本动作的登记面内。
     * 要它进清单请用 {@code export.multiblock}（长跑 + 逐份登记）。
     */
    private static JsonArray artifactsFor(String sub, ServerCommandInvoker.Result r, ActionContext ctx,
        com.lightning.mod.client.controlplane.core.ArtifactStore.Run run) {
        JsonArray arr = new JsonArray();
        if ("export".equals(sub)) {
            // 产物路径要等命令跑完才知道（outputName 可被 setname 改过）：从回报里读回权威路径。
            String path = firstMatch(r.replyText(), "已写出场景文件: ");
            if (path == null) {
                addArtifact(
                    arr,
                    "scene-file",
                    "<cwd>/structure_exports/<outputName>.json",
                    false,
                    null,
                    null,
                    "命令回报里没有「已写出场景文件: 」行——命令语义失败（无选区/无帧），本次无产物");
                return arr;
            }
            File src = new File(path);
            String rel = "cmd-exec/" + src.getName();
            if (run == null) {
                addArtifact(arr, "scene-file", path, src.isFile(), null, null, "未开 run（无可登记目标），只声明路径");
                return arr;
            }
            // 延迟登记：等客户端 enrich 把它覆盖成 Envelope（或显式 Plain/Raw）后再复制。
            CommandArtifactRegistrar.enqueue(
                new CommandArtifactRegistrar.SceneFile(
                    src,
                    run.runId(),
                    rel,
                    CommandArtifactRegistrar.DEFAULT_DEADLINE_TICKS));
            addArtifact(
                arr,
                "scene-file",
                rel,
                src.isFile(),
                null,
                null,
                "已排入延迟登记（deferred）：服务端先写 scan 中间态，客户端下一个 tick 用 enrich 覆盖为 baked+Envelope；"
                    + "等它成为终态后复制进 run 并登记 sha256（见 cp-export 事件与 run 清单）");
            return arr;
        }
        if ("dump".equals(sub)) {
            String root = firstMatch(r.replyText(), "全量 block_registry.json / material_registry.json: ");
            if (run == null) {
                addArtifact(
                    arr,
                    "registry-dump-request",
                    root != null ? root : "<cwd>/structure_exports",
                    root != null,
                    null,
                    null,
                    "未开 run（无可登记目标），只声明 pending_dump.json 落点");
                return arr;
            }
            // 把投递单落点改到本 run（run 由发起方持有）。
            // 注意：服务端线程刚写的 pending_dump.json 仍在老路径（CWD 相对）——它是命令通道的既有行为；
            // 这里追加一条**内存投递单**，客户端优先消费它（内存单槽优先），于是注册表落进本 run。
            File dumpDir = run.resolve("cmd-exec")
                .toFile();
            if (!dumpDir.isDirectory() && !dumpDir.mkdirs()) {
                addArtifact(
                    arr,
                    "registry-dump-request",
                    root,
                    root != null,
                    null,
                    null,
                    "无法创建 run 内 dump 目录: " + dumpDir);
                return arr;
            }
            com.lightning.mod.core.export.RegistryDumpDelivery.Request req = com.lightning.mod.core.export.RegistryDumpDelivery
                .request(run.runId(), dumpDir, "cmd-exec");
            if (req == null) {
                addArtifact(arr, "registry-dump-request", root, root != null, null, null, "已有待消费的注册表投递单，本次未登记");
                return arr;
            }
            CommandArtifactRegistrar.enqueue(
                new CommandArtifactRegistrar.RegistryFiles(
                    req,
                    dumpDir,
                    new String[] { "block_registry.json", "material_registry.json", "model_registry.json" },
                    run.runId(),
                    "cmd-exec",
                    CommandArtifactRegistrar.DEFAULT_DEADLINE_TICKS));
            addArtifact(
                arr,
                "registry-dump-request",
                "cmd-exec/",
                false,
                null,
                null,
                "已排入延迟登记（deferred）：三份注册表由客户端 tick 消费投递单后写出，写成后逐份登记 sha256" + "（见 cp-export 事件与 run 清单）");
            return arr;
        }
        if ("multiblock".equals(sub)) {
            addArtifact(
                arr,
                "multiblock-dataset",
                "<cwd>/<config:outputDirName>/",
                false,
                null,
                null,
                "多方块数据集由客户端 tick 异步执行（主菜单后），且落点由配置项 outputDirName 决定 ⇒"
                    + "不在本动作的登记面内；要产物进 run 清单请用 export.multiblock（长跑 + 逐份登记）");
            return arr;
        }
        return arr;
    }

    /** 会产出文件的子命令（只有这些才开 run）。 */
    private static final java.util.Set<String> PRODUCING_SUBS = new java.util.HashSet<String>(
        java.util.Arrays.asList("export", "dump", "multiblock"));

    private static void addArtifact(JsonArray arr, String role, String path, boolean exists, String sha256, Long bytes,
        String note) {
        JsonObject o = new JsonObject();
        o.addProperty("role", role);
        o.addProperty("path", path);
        o.addProperty("exists", exists);
        if (sha256 != null) {
            o.addProperty("sha256", sha256);
        }
        if (bytes != null) {
            o.addProperty("bytes", bytes.longValue());
        }
        o.addProperty("registered", sha256 != null && exists);
        if (note != null) {
            o.addProperty("note", note);
        }
        if (sha256 == null && note != null && note.contains("延迟登记")) {
            // 显式区分「声明了但还没登记」与「登记失败」：调用方据此决定是等还是查错误
            o.addProperty("deferred", true);
            o.addProperty("deadlineTicks", CommandArtifactRegistrar.DEFAULT_DEADLINE_TICKS);
        }
        arr.add(o);
    }

    /** 从回报全文里取某个前缀之后的第一个非空行（取不到返回 null）。 */
    private static String firstMatch(String replyText, String prefix) {
        if (replyText == null || replyText.isEmpty()) {
            return null;
        }
        for (String line : replyText.split("\n")) {
            String t = line.trim();
            int i = t.indexOf(prefix);
            if (i >= 0) {
                String v = t.substring(i + prefix.length())
                    .trim();
                if (!v.isEmpty()) {
                    return v;
                }
            }
        }
        return null;
    }

    // ------------------------------------------------------------ 命令文本解析

    /**
     * 命令文本 → 根命令 / 子命令（**只解析到能判白名单为止**，不做任何参数级理解）。
     *
     * <p>
     * 刻意保守：不处理引号、不处理 {@code $()}、不处理 {@code @p} 选择器——因为本通道<b>只</b>判定
     * 根命令与首个子命令，判定之外的一切原样交给服务端的真实命令处理器。「命令不扭曲行为」要求「命令不得额外
     * 追加、跳过或改写任何一步」，所以这里的解析越少越好：它只影响「放不放行」，不影响「怎么执行」。
     *
     * <p>
     * 唯一做的归一化是：去前导 {@code /}、折叠空白切分、子命令小写（与 {@code CommandSde} 的
     * {@code args[0].toLowerCase()} 同口径）。命令<b>执行</b>时用的是 {@link #normalized}（原样，仅折叠空白），
     * 因此大小写与参数书写对命令而言完全保真。
     */
    static final class Parsed {

        /** 归一化后的完整命令文本（带前导 '/'）。 */
        final String normalized;
        /** 根命令（小写）。 */
        final String root;
        /** 首个子命令（小写）；无子命令时为空串。 */
        final String sub;

        private Parsed(String normalized, String root, String sub) {
            this.normalized = normalized;
            this.root = root;
            this.sub = sub;
        }

        static Parsed of(String raw) {
            String text = ServerCommandInvoker.normalize(raw);
            String body = text.startsWith("/") ? text.substring(1) : text;
            String[] parts = body.split("\\s+");
            String root = parts.length > 0 ? parts[0].toLowerCase(java.util.Locale.ROOT) : "";
            String sub = parts.length > 1 ? parts[1].toLowerCase(java.util.Locale.ROOT) : "";
            return new Parsed(text, root, sub);
        }

        /** 白名单全表（供拒绝时的 choices 字段）。 */
        List<String> choices() {
            return SdeCommandWhitelist.allowedSubcommands();
        }
    }
}
