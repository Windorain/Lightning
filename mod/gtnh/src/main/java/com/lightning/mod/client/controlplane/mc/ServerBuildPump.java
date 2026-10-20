package com.lightning.mod.client.controlplane.mc;

import java.io.PrintWriter;
import java.io.StringWriter;

import net.minecraft.server.MinecraftServer;
import net.minecraft.world.WorldServer;

import com.google.gson.JsonObject;
import com.lightning.mod.client.controlplane.core.BuildJobMailbox;
import com.lightning.mod.client.controlplane.core.CpException;
import com.lightning.mod.client.controlplane.core.ErrorCodes;
import com.lightning.mod.client.controlplane.core.Json;

import cpw.mods.fml.common.eventhandler.SubscribeEvent;
import cpw.mods.fml.common.gameevent.TickEvent;

/**
 * 场景构建泵：把 {@link SceneBuilder} 的逐 tick 推进从<b>客户端 tick 线程</b>搬到
 * <b>服务端 tick 线程</b>——这是 #89 的根治（评论 1689），即把场景构建放回<b>本义线程</b>。
 *
 * <h2>缺陷与机理（措辞从严）</h2>
 *
 * <p>
 * 原实现里 {@code SceneBuilder.tick(world)} 由客户端 tick 线程直接调用，逐点探针坐实
 * {@code thread=Client thread}；ctm 基线下时序竞态表现为 {@code setBlock} 的写入没有持久化。
 * 机理解释是「写进了将被丢弃的 chunk 对象」——这是<b>最合理解释，而非定论</b>：本类不声称已证明
 * 该机理，它做的是把写入放回权威线程，让「谁在写」这件事不再有争议。
 *
 * <h2>装配</h2>
 *
 * <p>
 * 由 {@link ControlPlaneBootstrap#start(net.minecraft.client.Minecraft)} 与客户端 tick 排空器一起
 * 注册到 {@code FMLCommonHandler.instance().bus()}；服务端每个 tick 的 {@link TickEvent.Phase#END}
 * 驱动一次 {@link #onServerTick(TickEvent.ServerTickEvent)}。<b>只处理集成服存在的场合</b>：
 * {@code MinecraftServer.getServer()} 与其 {@code worldServers} 都判空（见
 * {@link WorldRuntime#server()}），空即中止在途作业（响亮，见下）。
 *
 * <h2>分工与边界（残存约定，记录不扩面）</h2>
 *
 * <ul>
 * <li><b>写世界</b>（{@code clear}/{@code block}/{@code te}/渲染范围刷新/静置）= 服务端线程，
 * 走本泵；</li>
 * <li><b>读世界</b>（{@link SceneManifest} 生成、{@link ObservationCollector}、{@link WorldDescriber}
 * 等）<b>仍走客户端 tick 线程</b>——这是本次根治<b>未</b>触及的残存约定：本类只搬「构建写入」，
 * 不动读取路径，也不因此扩面到其它动作。读取是否同样需要回到服务端线程，另行立项判据；</li>
 * <li>构建进度（{@code stepCount()/doneSteps()}）由客户端线程读、服务端线程写，靠
 * {@link SceneBuilder} 的 {@code volatile} 进度字段兜可见性（跨线程读，见该类注释）。</li>
 * </ul>
 *
 * <h2>世界实例绑定（跨重建串写防护）</h2>
 *
 * <p>
 * 认领作业的<b>首 tick</b>记下当时的服务端世界实例；之后每个 tick 若「首个非空 world」换了实例，
 * 说明构建期间发生了世界重建/卸载，此时继续写等于往新世界串写旧场景——立即
 * {@link BuildJobMailbox#abort(String)}，原因里带两侧的 {@code identityHashCode}。
 * {@code server}/{@code world} 变 null 同样是中止（不是静默等待），首 tick 就不可用也一样。
 *
 * <h2>异常与结局回传</h2>
 *
 * <ul>
 * <li>{@link SceneBuilder#tick} 抛 {@link CpException} → 原码、原消息、原栈文本经
 * {@link BuildJobMailbox#fail} 回传；{@link #poll()} 用同一码+消息重建 {@code CpException}
 * （{@code getMessage()} 与原始逐字相同），服务端栈文本落在
 * {@code context.remoteStack}（Java 异常对象不跨线程复活，栈以文本保真）；</li>
 * <li>抛其它 {@code Throwable} → 包成 {@link ErrorCodes#EXEC_FAILED} 回传并
 * {@link CpLog#warn}（原栈经 {@link CpLog#error} 落在服务端线程，便于与客户端侧日志对照）；</li>
 * <li>{@code tick} 返回非 null → 作业完成，清单对象经 {@code complete} 回传；</li>
 * <li>中止 → {@link #poll()} 抛 {@code CP-STATE-001}，消息里带中止原因。</li>
 * </ul>
 *
 * <h2>槽位僵死的安全阀</h2>
 *
 * <p>
 * 调用方可能在结局就绪前就退出（阶段超时 CP-EXEC-002、动作异常、进程收尾），槽位于是停在
 * 「结局无人领取」。服务端不做超时裁决（那是动作层的职责，见
 * {@link SteppingActionBase#DEFAULT_STAGE_TIMEOUT_MS}），因此 {@link #submit} 在受理新作业前先
 * {@link BuildJobMailbox#discardUnclaimedOutcome()} 并打 WARN——客户端只有一个 tick 线程，
 * {@code poll} 与 {@code submit} 不并发，这个判定是确定的，不会误杀在途作业。
 */
public final class ServerBuildPump {

    /** 作业标签（诊断用；core 槽位不解析它）。 */
    public static final String TAG = "scene-build";

    /** 失败结局回传服务端栈文本的 context 字段名（见 {@link #poll()}）。 */
    public static final String CTX_REMOTE_STACK = "remoteStack";

    /** 失败/中止结论的来源标记（读 events.jsonl 时一眼看出栈不是调用方那一份）。 */
    public static final String ORIGIN = "server-tick";

    private static final ServerBuildPump INSTANCE = new ServerBuildPump();

    /** 唯一的跨线程通道（见 {@link BuildJobMailbox}）。 */
    private final BuildJobMailbox mailbox = new BuildJobMailbox();

    /** 在途构建器（<b>服务端线程独属</b>；null = 无在途作业）。 */
    private SceneBuilder active;

    /**
     * 是否已从槽位认领到作业（<b>服务端线程独属</b>）。
     *
     * <p>
     * 它必须与 {@link #active} 分开记：认领（{@code take()}）与「构建器落地」之间还有几步（世界判空、
     * 载荷类型校验），这几步里若出事，槽位已经是 RUNNING 而 {@code active} 仍是 null——只看
     * {@code active} 就会漏掉中止，作业永久占住槽位（后续构建全部 CP-BUSY-001）。
     */
    private boolean claimed;

    /** 首 tick 记下的世界实例（<b>服务端线程独属</b>；null = 未绑定）。 */
    private WorldServer boundWorld;

    private ServerBuildPump() {}

    /** 单例句柄（两个入口与 bootstrap 必须共用同一个泵，否则会出现两条互不相识的槽位）。 */
    public static ServerBuildPump instance() {
        return INSTANCE;
    }

    /**
     * 提交一件场景构建（<b>客户端 tick 线程</b>调用）。
     *
     * <p>
     * 提交即返回：真正的推进在服务端线程的下一个 tick 开始，调用方逐 tick 用 {@link #poll()} 轮询。
     *
     * @param builder 场景构建器（已解析、已归一化的构建段）；不得为 null
     * @throws CpException {@code CP-VALID-002} 构建器为 null；{@code CP-BUSY-001} 槽位非空闲
     *                     （上一件作业仍在服务端推进）
     */
    public void submit(SceneBuilder builder) {
        if (builder == null) {
            throw new CpException(ErrorCodes.VALID_PARAM, "场景构建器不能为空");
        }
        if (mailbox.discardUnclaimedOutcome()) {
            CpLog.warn("丢弃上一次场景构建无人领取的结局（调用方已超时/异常退出，槽位复位）：tag=%s，否则后续构建会永久撞 CP-BUSY-001", TAG);
        }
        if (!mailbox.trySubmit(builder, TAG)) {
            throw new CpException(
                ErrorCodes.BUSY,
                "场景构建泵忙：槽位非空闲（state=" + mailbox.state() + "），本次提交被拒",
                Json.object("state", String.valueOf(mailbox.state()), "tag", TAG));
        }
        CpLog.info(
            "场景构建已提交到服务端线程：tag=%s，%d 步，静置见清单（#89 评论 1689：构建写世界回到本义线程）",
            TAG,
            Integer.valueOf(builder.stepCount()));
    }

    /**
     * 轮询结局（<b>客户端 tick 线程</b>调用）。
     *
     * @return 场景清单（{@link SceneBuilder#tick} 的完成产物）；未完成返回 null
     * @throws CpException 失败时原码原消息重抛（服务端栈文本在 {@code context.remoteStack}）；
     *                     中止时为 {@code CP-STATE-001}（消息含中止原因）；结局载荷类型非法时为
     *                     {@code CP-EXEC-001}
     */
    public JsonObject poll() {
        BuildJobMailbox.Completion c = mailbox.poll();
        if (c == null) {
            return null;
        }
        if (c.isAborted()) {
            throw new CpException(
                ErrorCodes.STATE,
                "场景构建被中止（服务端线程）：" + c.abortReason(),
                Json.object("reason", c.abortReason(), "origin", ORIGIN));
        }
        if (c.isFailed()) {
            JsonObject ctx = Json.object("origin", ORIGIN);
            if (c.errorStack() != null) {
                ctx.addProperty(CTX_REMOTE_STACK, c.errorStack());
            }
            // 原码原消息重抛：错误码与消息逐字来自服务端那一份（getMessage() 与原始一致），
            // 服务端栈以文本落在 context.remoteStack —— 异常对象不跨线程复活，栈保真靠文本。
            throw new CpException(c.errorCode(), c.errorMessage(), ctx);
        }
        Object result = c.result();
        if (!(result instanceof JsonObject)) {
            throw new CpException(
                ErrorCodes.EXEC_FAILED,
                "场景构建结局载荷类型非法：期望场景清单 " + JsonObject.class.getName()
                    + "，实际 "
                    + (result == null ? "null"
                        : result.getClass()
                            .getName()));
        }
        return (JsonObject) result;
    }

    /**
     * 服务端 tick 驱动（{@link TickEvent.Phase#END}；{@link MinecraftServer} 的线程）。
     *
     * <p>
     * 本方法绝不把异常抛回 FML 事件总线：控制面出错不许影响服务端 tick（与
     * {@link ControlPlaneTickHandler#onClientTick} 同一条纪律），内部异常一律中止在途作业并落 ERROR。
     */
    @SubscribeEvent
    public void onServerTick(TickEvent.ServerTickEvent e) {
        if (e == null || e.phase != TickEvent.Phase.END) {
            return;
        }
        try {
            pumpOnce();
        } catch (Throwable t) {
            CpLog.error(t, "场景构建泵 tick 异常（已吞掉，不影响服务端 tick）");
            try {
                // 兜底：任何未捕获异常都不能把作业永久留在槽位里（否则后续构建全部 CP-BUSY-001）
                abortRunning("泵内部异常（服务端 tick）：" + t);
            } catch (Throwable t2) {
                CpLog.error(t2, "场景构建泵中止在途作业失败（槽位可能僵死，后续提交会撞 CP-BUSY-001）");
            }
        }
    }

    // ------------------------------------------------------------ 服务端侧

    /** 一次推进：无在途作业则先认领 + 绑定世界，随后推进一步。 */
    private void pumpOnce() {
        if (!claimed) {
            BuildJobMailbox.Job job = mailbox.take();
            if (job == null) {
                return; // 空闲 / 已在推进 / 结局待客户端领取
            }
            // 认领即 RUNNING：先立起「有在途作业」这块牌子，之后任何失败/中止路径都能解掉槽位。
            claimed = true;
            Object payload = job.payload();
            if (!(payload instanceof SceneBuilder)) {
                mailbox.fail(
                    ErrorCodes.EXEC_FAILED,
                    "构建作业载荷类型非法：期望 " + SceneBuilder.class.getName()
                        + "，实际 "
                        + (payload == null ? "null"
                            : payload.getClass()
                                .getName()),
                    null);
                claimed = false;
                return;
            }
            active = (SceneBuilder) payload;
            // 先确认「本义线程」真的在：服务端或世界不在位就当场中止，
            // 绝不留一件作业在槽里空转（响亮失败，不静默等待）。
            MinecraftServer server = WorldRuntime.server();
            WorldServer world = firstWorld(server);
            if (world == null) {
                abortRunning(
                    server == null ? "服务端实例不可用（MinecraftServer.getServer() == null）：提交后世界已停服或集成服未起"
                        : "服务端世界不可用（server.worldServers 无实例）：提交后世界已卸载");
                return;
            }
            boundWorld = world;
            CpLog.info(
                "场景构建泵认领作业并在服务端线程推进：tag=%s，绑定世界 identityHashCode=%d，%d 步",
                job.tag(),
                Integer.valueOf(System.identityHashCode(world)),
                Integer.valueOf(active.stepCount()));
        }

        MinecraftServer server = WorldRuntime.server();
        WorldServer world = firstWorld(server);
        if (world == null) {
            abortRunning("构建期间服务端世界不可用（server/world 变 null）：世界已卸载或集成服正在关停");
            return;
        }
        if (world != boundWorld) {
            abortRunning(
                "构建期间世界实例更换（跨重建串写防护）bound=" + System.identityHashCode(boundWorld)
                    + " current="
                    + System.identityHashCode(world));
            return;
        }

        JsonObject result;
        try {
            result = active.tick(world);
        } catch (CpException ce) {
            CpLog.error(ce, "场景构建失败（服务端线程）：%s [%s]", ce.detail(), ce.code());
            failRunning(ce.code(), ce.detail(), stackText(ce));
            return;
        } catch (Throwable t) {
            CpLog.warn("场景构建异常（服务端线程）：%s；已包成 %s 回传调用方", String.valueOf(t), ErrorCodes.EXEC_FAILED);
            CpLog.error(t, "场景构建异常栈（服务端线程）");
            failRunning(ErrorCodes.EXEC_FAILED, "场景构建异常（服务端线程）: " + t, stackText(t));
            return;
        }
        if (result == null) {
            return; // 未完成：下一个服务端 tick 继续
        }
        SceneBuilder done = active;
        // 先落结局、再解绑：万一落结局抛出，claimed 仍为 true，外层兜底还能 abort 一次
        // （宁可落一条「槽位可能僵死」的 ERROR，也不静默僵死）
        mailbox.complete(result);
        claimed = false;
        active = null;
        boundWorld = null;
        CpLog.info(
            "场景构建完成（服务端线程）：%d 步，清单 sha256=%s",
            Integer.valueOf(done.stepCount()),
            Json.optString(result, "sha256", null));
    }

    /** 落失败结局并解绑（服务端线程）。 */
    private void failRunning(String code, String message, String stack) {
        if (!claimed) {
            return; // 不可达：failRunning 只在已认领时调用
        }
        mailbox.fail(code, message, stack);
        claimed = false;
        active = null;
        boundWorld = null;
    }

    /** 中止在途作业并解绑（服务端线程）；无在途作业时是空操作（异常日志已由调用方落过）。 */
    private void abortRunning(String reason) {
        if (!claimed) {
            return;
        }
        CpLog.warn("场景构建中止（服务端线程）：%s", reason);
        mailbox.abort(reason);
        claimed = false;
        active = null;
        boundWorld = null;
    }

    /** 首个非空服务端世界（与 {@link WorldRuntime#serverWorld()} 同一取法；这里需要实例本身，故就地取）。 */
    private static WorldServer firstWorld(MinecraftServer server) {
        if (server == null) {
            return null;
        }
        WorldServer[] worlds = server.worldServers;
        if (worlds == null) {
            return null;
        }
        for (WorldServer w : worlds) {
            if (w != null) {
                return w;
            }
        }
        return null;
    }

    /** 完整栈文本（跨线程保真的唯一形态：异常对象本身不跨线程复活）。 */
    private static String stackText(Throwable t) {
        if (t == null) {
            return null;
        }
        StringWriter sw = new StringWriter();
        PrintWriter pw = new PrintWriter(sw);
        try {
            t.printStackTrace(pw);
        } finally {
            pw.flush();
        }
        return sw.toString();
    }
}
