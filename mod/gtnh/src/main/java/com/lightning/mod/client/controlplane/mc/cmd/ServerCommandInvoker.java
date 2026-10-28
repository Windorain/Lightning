package com.lightning.mod.client.controlplane.mc.cmd;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Queue;
import java.util.WeakHashMap;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

import net.minecraft.entity.player.EntityPlayerMP;
import net.minecraft.server.MinecraftServer;
import net.minecraft.util.IChatComponent;

import cpw.mods.fml.common.FMLCommonHandler;
import cpw.mods.fml.common.eventhandler.SubscribeEvent;
import cpw.mods.fml.common.gameevent.TickEvent;
import cpw.mods.fml.relauncher.Side;
import cpw.mods.fml.relauncher.SideOnly;

/**
 * 「在<b>服务端线程</b>上执行一条游戏内命令，并把真实回报取回来」的唯一实现。
 *
 * <h2>为什么必须是服务端线程</h2>
 *
 * 已实测：1.7.10 集成服里命令由 {@code NetHandlerPlayServer#processReceivedPackets} →
 * {@code MinecraftServer.tick()} 驱动，跑在名为 {@code "Server thread"} 的独立线程上；而 {@code /sde}
 * 家族（{@link com.lightning.mod.server.command.CommandSde}）里的 {@code record} 会做世界扫描、
 * {@code SdeServerRecordScheduler} 的连录/cycle 更是<b>按服务端 tick 计数</b>推进。因此：
 *
 * <ul>
 * <li>在客户端 tick 线程直接调 {@code processCommand} 会让连录/cycle 永不推进（它们的 tick 源在服务端）；</li>
 * <li>而且 {@code CommandEvent} 会照常发给服务端侧监听器 —— 绕过它等于绕过一个真实的扩展点；</li>
 * <li>cp 契约 §8 第 1 条要求「HTTP 线程绝不触碰 MC 状态」，动作在客户端 tick 线程执行（那是渲染线程）；
 * 于是「把命令送回它本来该跑的线程」是唯一不制造新语义的做法（「命令不扭曲行为」：
 * 同一语义经 API 与经命令执行，行为一致——这里连<b>线程</b>都一致）。</li>
 * </ul>
 *
 * <h2>机制：为什么用服务端 tick 而非反射 {\\@code addScheduledTask}</h2>
 *
 * 方案一（曾考虑）：调用 {@code MinecraftServer.func_152344_a(Runnable)}（"addScheduledTask"）。
 * <b>放弃</b>，原因有二：①该方法是 {@code @SideOnly(SERVER)}——1.7.10 客户端环境下引用它需要反射，
 * 而反射的<b>失败是运行时</b>的（方法名在 1.7.10 各版本间有过改名），失败点会落在「命令被静默丢弃」
 * 这种最难查的形态上；②它没有「任务已跑完」的信号，回包只能靠轮询，反而引入超时语义的分叉。
 *
 * <p>
 * 方案二（采用）：<b>自己挂一个服务端 tick 监听器 + 阻塞等回包</b>。{@code ServerTickEvent} 由 FML 总线
 * 在 {@code FMLCommonHandler#onPreServerTick/onPostServerTick} 派发，监听器体跑在服务端线程内
 * （已由 {@link com.lightning.mod.server.SdeServerRecordTickHandler} 的既有用法证实）。
 * 本类在 {@code Phase.START} 排空队列 ⇒ 命令在服务端 tick 的<b>开头</b>执行，与玩家在聊天框敲命令
 * （{@code NetworkSystem.networkTick()} 在 tick 中段处理入站包）处于同一线程、同一 tick 内语义。
 *
 * <ul>
 * <li><b>零反射</b>：全部走编译期可见的 API，方法名错了是编译错误而不是运行期静默；</li>
 * <li><b>有完成信号</b>：{@link CountDownLatch} 精确等待，不轮询；</li>
 * <li><b>失败显式</b>：服务端没起来 ⇒ 立即 {@link #STATUS_NO_SERVER}；超时 ⇒ {@link #STATUS_TIMEOUT}
 * 且带耗时；命令不存在 ⇒ 由 {@code CommandHandler} 走它<b>本来</b>的路径（把
 * {@code commands.generic.notFound} 塞进发送者），我们如实录下这段回报而不是自造错误文案。</li>
 * </ul>
 *
 * <h2>回报捕获：为什么不用假发送者</h2>
 *
 * 「返回命令的真实回报文本」有两个做法：①自造一个 {@link ICommandSender} 收集 {@code addChatMessage}；
 * ②让命令在<b>真实玩家</b>身上执行，并同时录下它发给玩家的聊天消息。
 *
 * <p>
 * 采用 <b>②</b>，理由：{@code /sde} 的多个子命令（{@code pos1}/{@code hpos1}/{@code record}/{@code export}/
 * {@code multiblock}）都<b>要求发送者是 {@link EntityPlayerMP}</b>——它们要读玩家的坐标、准星、
 * {@code worldObj} 与 OP 权限（{@code SdePermissions.canUseSde}）。用假发送者会一律走到
 * {@code checkPlayer} 的拒绝分支，那就成了「通道可用但什么都干不了」的假通过。
 * 让命令在真实服务端玩家身上跑，才是「与游戏内手动执行同一命令」的严格同语义（A4 对照表的判定基础）。
 *
 * <p>
 * 因此回报 = <b>拦截该玩家在此次执行期间收到的聊天消息</b>（{@link TappedPlayer}），并把它们按顺序拼起来。
 * 这样拿到的是命令<b>真实写给玩家的文本原样</b>（含 {@code §} 颜色码与 {@code SDE: } 前缀），
 * 而不是我们转述的摘要。拦截在服务端线程内、命令返回后立即拆掉，窗口极窄。
 *
 * <h2>注册时机（实机教训）</h2>
 *
 * {@link #ensureRegistered()} 必须在 {@code FMLServerStartingEvent} 里调用（见
 * {@code LightningMod#onServerStarting}）。第一版曾写成「首次执行命令时惰性注册」，
 * 后果是命令入队后<b>永远没有服务端 tick 排空</b>，每次调用都以 {@code CP-EXEC-002} 超时收场——
 * 详见 {@link #ensureRegistered()} 的注释。这是最重要的一条实现教训：
 * <b>「用到时再注册」在事件驱动框架里是不可靠的隐式时机</b>。
 *
 * <h2>@SideOnly(CLIENT) 论证</h2>
 *
 * 本类位于 {@code client.controlplane} 包，只被 cp 装配链引用（cp 本身只在客户端启用，见
 * {@code ClientProxy}）。它引用的 MC 类型（{@code MinecraftServer}/{@code EntityPlayerMP}/
 * {@code ICommandSender}/{@code World}/{@code ChunkCoordinates}/{@code ChatComponentText}）与
 * {@code WorldRuntime} 同族，<b>均非</b> {@code @SideOnly} 标注类；FML 的 {@code ServerTickEvent}
 * 也是双侧事件（{@code TickEvent} 在 {@code cpw.mods.fml.common.gameevent}，双环境可用）。
 * 因此本类不需要 {@code @SideOnly} 标注，也不会有 {@code NoSuchMethodError} 风险。
 */
@SideOnly(Side.CLIENT)
public final class ServerCommandInvoker {

    /** 执行结果状态（稳定字符串，回报与事件流水都用它）。 */
    public static final String STATUS_OK = "ok";
    /** 集成服未运行 / 没有服务端玩家。 */
    public static final String STATUS_NO_SERVER = "no-server";
    /** 排队后未在超时内看到服务端 tick（服务端卡死或暂停）。 */
    public static final String STATUS_TIMEOUT = "timeout";
    /** 命令在服务端抛出未捕获异常（{@code CommandHandler} 会把它转成 commands.generic.exception）。 */
    public static final String STATUS_EXCEPTION = "exception";

    /**
     * 默认等待上限（毫秒）。
     *
     * <p>
     * 取 10 秒：服务端 tick 是 50ms 一次，正常回包在 1-2 tick 内（&lt;200ms）。留 10 秒是给
     * 「服务端正忙于世界重建/大区块加载」这类长 tick 的余量——真等满 10 秒基本等价于服务端已卡死，
     * 此时以 {@link #STATUS_TIMEOUT} 显式失败远好于无限等（「失败显式」）。
     */
    public static final long DEFAULT_TIMEOUT_MS = 10_000L;

    /** 一条待执行命令。 */
    private static final class Pending {

        private final String command;
        private final EntityPlayerMP player;
        private final long seq;
        private final CountDownLatch done = new CountDownLatch(1);

        private volatile Result result;

        Pending(String command, EntityPlayerMP player, long seq) {
            this.command = command;
            this.player = player;
            this.seq = seq;
        }
    }

    /** 一次执行的完整结果（不可变）。 */
    public static final class Result {

        private final String status;
        private final String command;
        private final List<String> replies;
        private final long elapsedMs;
        private final String executedOnThread;
        private final long serverTick;
        private final String error;

        Result(String status, String command, List<String> replies, long elapsedMs, String executedOnThread,
            long serverTick, String error) {
            this.status = status;
            this.command = command;
            this.replies = replies == null ? new ArrayList<String>() : replies;
            this.elapsedMs = elapsedMs;
            this.executedOnThread = executedOnThread;
            this.serverTick = serverTick;
            this.error = error;
        }

        /** 见 {@code STATUS_*} 常量。 */
        public String status() {
            return status;
        }

        /** 实际提交给 {@code CommandHandler} 的命令文本（已带前导 '/'）。 */
        public String command() {
            return command;
        }

        /** 命令写给玩家的聊天文本（原样，按顺序）。 */
        public List<String> replies() {
            return replies;
        }

        /** 全部回报拼成一段（{@code \n} 分隔）；无回报时为空串。 */
        public String replyText() {
            StringBuilder sb = new StringBuilder();
            for (int i = 0; i < replies.size(); i++) {
                if (i > 0) {
                    sb.append('\n');
                }
                sb.append(replies.get(i));
            }
            return sb.toString();
        }

        /** 从排队到拿到结果的墙钟耗时（毫秒）。 */
        public long elapsedMs() {
            return elapsedMs;
        }

        /** 实际执行该命令的线程名（正常为 {@code "Server thread"}）。 */
        public String executedOnThread() {
            return executedOnThread;
        }

        /** 执行时的服务端 tick 计数（0 表示未取到）。 */
        public long serverTick() {
            return serverTick;
        }

        /** 失败摘要（status 非 ok 时非空）。 */
        public String error() {
            return error;
        }

        /** 是否成功执行（不等于命令语义成功——语义成败由回报文本体现）。 */
        public boolean executed() {
            return STATUS_OK.equals(status);
        }
    }

    /** 待执行队列（仅服务端 tick 监听器排空；入队来自客户端 tick 线程）。 */
    private static final Queue<Pending> QUEUE = new ArrayDeque<Pending>();

    /** 队列监视器：入队与排空是不同线程，必须互斥。 */
    private static final Object QUEUE_LOCK = new Object();

    /** 排队序号（诊断用）。 */
    private static long seqCounter;

    private static ServerCommandInvoker INSTANCE;

    private static synchronized ServerCommandInvoker instance() {
        if (INSTANCE == null) {
            INSTANCE = new ServerCommandInvoker();
        }
        return INSTANCE;
    }

    private ServerCommandInvoker() {}

    /**
     * 确保服务端 tick 监听器已注册到 FML 总线（幂等）。
     *
     * <p>
     * <b>必须在服务端启动时调用</b>（{@code LightningMod#onServerStarting}，与
     * {@link com.lightning.mod.server.SdeServerRecordTickHandler} 同一挂点、同一理由）：
     * 1.7.10 集成服下 {@code ServerTickEvent} 只在 {@code FMLServerStartingEvent} 之后才被派发，
     * 而 FML 事件总线只把事件投给<b>已注册</b>的监听器实例。
     *
     * <p>
     * <b>实机教训（本条曾写错，记录在此）</b>：第一版把注册写成「首次执行命令时惰性注册」，
     * 结果命令入队后<b>永远没有服务端 tick 来排空它</b>——每次调用都在 10 秒后以
     * {@code CP-EXEC-002} 超时失败。失败本身是显式的（这正是设计要的：没有静默挂起），
     * 但根因（监听器根本没注册）只能靠「超时 + 无任何执行痕迹」反推。
     * 因此注册点必须是<b>明确的生命周期钩子</b>，不能依赖「用到时再注册」这类隐式时机。
     *
     * <p>
     * 重复调用安全：FML 总线的 {@code register} 对同一实例是幂等的（重复注册同一对象不会再挂一次）。
     */
    public static void ensureRegistered() {
        FMLCommonHandler.instance()
            .bus()
            .register(instance());
    }

    /**
     * 在服务端线程执行一条命令并等待其真实回报（<b>阻塞</b>，调用方为客户端 tick 线程）。
     *
     * <p>
     * 阻塞的是<b>客户端 tick 线程</b>，这是刻意的：cp 动作本身就是「占用一个 tick 槽做完一件事」，
     * 在动作内等待服务端回包与既有的 {@code mc.loadWorld(null)} 阻塞（contract.md §10 第 12 条）同一性质。
     * 服务端线程<b>不</b>等待客户端——队列由服务端 tick 自行排空，方向单一，
     * <b>结构上不可能死锁</b>。
     *
     * @param command   命令文本（可带或不带前导 '/'）
     * @param player    执行者（真实服务端玩家；{@code null} 时按 {@link #STATUS_NO_SERVER} 失败）
     * @param timeoutMs 等待上限（毫秒，&le;0 用 {@link #DEFAULT_TIMEOUT_MS}）
     * @return 执行结果；永不返回 null，永不抛异常（失败一律体现在 status/error 上）
     */
    public static Result execute(String command, EntityPlayerMP player, long timeoutMs) {
        long limit = timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS;
        long startedAt = System.currentTimeMillis();
        String text = normalize(command);
        if (player == null) {
            return new Result(STATUS_NO_SERVER, text, null, 0L, null, 0L, "没有服务端玩家：客户端未进入世界或集成服未启动");
        }

        Pending p = new Pending(text, player, nextSeq());
        synchronized (QUEUE_LOCK) {
            QUEUE.add(p);
        }

        boolean finished;
        try {
            finished = p.done.await(limit, TimeUnit.MILLISECONDS);
        } catch (InterruptedException e) {
            Thread.currentThread()
                .interrupt();
            finished = p.done.getCount() == 0;
        }
        long elapsed = System.currentTimeMillis() - startedAt;

        if (!finished) {
            // 不能从队列里安全摘除（服务端可能正在执行它），只标记结果；服务端跑完时会丢弃迟到的回包。
            return new Result(
                STATUS_TIMEOUT,
                text,
                null,
                elapsed,
                null,
                0L,
                "等待服务端 tick 超时（" + limit + "ms）：服务端未运行或单 tick 耗时过长");
        }
        Result r = p.result;
        if (r == null) {
            return new Result(STATUS_EXCEPTION, text, null, elapsed, null, 0L, "内部错误：结果未回填");
        }
        // 用调用方实测耗时覆盖（服务端侧只测执行段，排队等待也要计入用户感知的耗时）
        return new Result(r.status, r.command, r.replies, elapsed, r.executedOnThread, r.serverTick, r.error);
    }

    /** 当前排队深度（诊断用）。 */
    public static int pendingCount() {
        synchronized (QUEUE_LOCK) {
            return QUEUE.size();
        }
    }

    private static long nextSeq() {
        synchronized (QUEUE_LOCK) {
            return ++seqCounter;
        }
    }

    /** 归一化命令文本：去首尾空白、补一个前导 '/'、折叠连续空格。 */
    static String normalize(String command) {
        String s = command == null ? "" : command.trim();
        if (s.isEmpty()) {
            return "/";
        }
        if (!s.startsWith("/")) {
            s = "/" + s;
        }
        return s;
    }

    /**
     * 服务端 tick 排空器：在服务端线程上执行队首命令。
     *
     * <p>
     * 只排空<b>一条</b>：与 cp 的 {@code JobQueue.drainOne()} 同思路——同一时刻只有一条命令在飞，
     * 语义简单、诊断清晰（队列积压本身就说明客户端侧出了问题，应当显式可见）。
     */
    @SubscribeEvent
    public void onServerTick(TickEvent.ServerTickEvent e) {
        if (e == null || e.side != Side.SERVER || e.phase != TickEvent.Phase.START) {
            return;
        }
        Pending p;
        synchronized (QUEUE_LOCK) {
            p = QUEUE.poll();
        }
        if (p == null) {
            return;
        }
        runOne(p);
    }

    /**
     * 在<b>当前（服务端）线程</b>执行一条命令并把回报回填。
     *
     * <h2>为什么发送者是真实玩家本身，而不是包装对象（实机教训）</h2>
     *
     * 第一版把发送者包成 {@code TappedPlayer implements ICommandSender}（只为录下 {@code addChatMessage}），
     * 实机后果是 {@code pos1}/{@code pos2}/{@code hpos1}/{@code hpos2}/{@code record}/{@code export}/{@code dump}
     * 一律回 <b>「SDE: 该子命令仅玩家可用」</b>——因为 {@code CommandSde#checkPlayer} 判的是
     * {@code sender instanceof EntityPlayerMP}，而包装对象不是玩家，于是命令在**权限/身份检查**这一关就被挡下。
     * 那正是「通道可用但什么都干不了」的假通过，且症状是「命令成功执行(status=ok)但语义全部失败」，
     * 极具迷惑性。
     *
     * <p>
     * 正确做法：把 <b>真实 {@link EntityPlayerMP}</b> 作为发送者交给 {@code CommandHandler}，
     * 另用 {@link ChatTap}（挂在玩家 {@code addChatMessage} 的下游）录制回报。这样：
     *
     * <ul>
     * <li>身份检查（{@code instanceof EntityPlayerMP}）通过——命令拿到的就是它平时拿到的那个玩家；</li>
     * <li>{@code getCommandSenderName}/{@code getEntityWorld}/{@code getPlayerCoordinates}/OP 判定
     * 全部走玩家自己的实现，<b>零转述</b>，因此与手动执行逐字同语义；</li>
     * <li>回报仍是命令真实写给玩家的文本原样。</li>
     * </ul>
     */
    private void runOne(Pending p) {
        List<String> replies = new ArrayList<String>();
        String status = STATUS_OK;
        String error = null;
        long tick = 0L;
        String threadName = Thread.currentThread()
            .getName();
        try {
            MinecraftServer server = MinecraftServer.getServer();
            if (server == null) {
                finish(p, new Result(STATUS_NO_SERVER, p.command, null, 0L, threadName, 0L, "服务端已停止"));
                return;
            }
            tick = server.getTickCounter();
            if (p.player.playerNetServerHandler == null) {
                finish(p, new Result(STATUS_NO_SERVER, p.command, null, 0L, threadName, tick, "服务端玩家已断开（无网络处理器）"));
                return;
            }
            final List<String> capturedLine = replies;
            ChatTap tap = new ChatTap() {

                @Override
                public void onChat(IChatComponent message) {
                    try {
                        String text = message == null ? null : message.getUnformattedText();
                        if (text != null && !text.isEmpty()) {
                            capturedLine.add(text);
                        }
                    } catch (Throwable ignored) {
                        // 录制失败绝不影响命令本身
                    }
                }
            };
            addTap(p.player, tap);
            try {
                server.getCommandManager()
                    .executeCommand(p.player, p.command);
            } finally {
                removeTap(p.player, tap);
            }
        } catch (Throwable t) {
            status = STATUS_EXCEPTION;
            error = t.getClass()
                .getName() + ": "
                + t.getMessage();
        }
        finish(p, new Result(status, p.command, replies, 0L, threadName, tick, error));
    }

    private static void finish(Pending p, Result r) {
        p.result = r;
        p.done.countDown();
    }

    /**
     * 回报录制口：命令写给玩家的聊天消息的**旁听者**（不替换、不吞掉，只转发+记账）。
     *
     * <p>
     * 由 {@link EntityPlayerMP#addChatMessage} 的注入点在消息送达玩家前回调（见
     * {@code MixinEntityPlayerMPChatTap}）。之所以做成接口 + mixin 注入而不是包装发送者：
     * 包装会破坏 {@code sender instanceof EntityPlayerMP} 的身份检查，见 {@link #runOne} 的注释。
     *
     * <p>
     * 全局注册表按玩家实例关联，且只在<b>命令执行窗口内</b>存在（{@code runOne} 的 try/finally 保证移除），
     * 因此窗口外的任何聊天（tick 期间的无关消息）都不会混进回报。
     */
    public interface ChatTap {

        /** 收到一条写给玩家的聊天消息（在玩家实际收到之前调用）。 */
        void onChat(IChatComponent message);
    }

    private static final Map<EntityPlayerMP, List<ChatTap>> TAPS = new WeakHashMap<EntityPlayerMP, List<ChatTap>>();

    /** 注册一个回报录制口（服务端线程调用）。 */
    public static void addTap(EntityPlayerMP player, ChatTap tap) {
        if (player == null || tap == null) {
            return;
        }
        synchronized (TAPS) {
            List<ChatTap> list = TAPS.get(player);
            if (list == null) {
                list = new ArrayList<ChatTap>(2);
                TAPS.put(player, list);
            }
            list.add(tap);
        }
    }

    /** 注销回报录制口（服务端线程调用；必须在 finally 里调用）。 */
    public static void removeTap(EntityPlayerMP player, ChatTap tap) {
        if (player == null || tap == null) {
            return;
        }
        synchronized (TAPS) {
            List<ChatTap> list = TAPS.get(player);
            if (list == null) {
                return;
            }
            list.remove(tap);
            if (list.isEmpty()) {
                TAPS.remove(player);
            }
        }
    }

    /**
     * 由 mixin 在 {@code EntityPlayerMP#addChatMessage} 入口调用：把消息分发给该玩家当前的录制口。
     *
     * <p>
     * <b>纯旁听</b>：不修改消息、不阻断发送、不改变返回值。无录制口时是空循环（零行为变化）。
     */
    public static void dispatchChat(EntityPlayerMP player, IChatComponent message) {
        if (player == null || message == null) {
            return;
        }
        List<ChatTap> list;
        synchronized (TAPS) {
            list = TAPS.get(player);
            if (list == null || list.isEmpty()) {
                return;
            }
            list = new ArrayList<ChatTap>(list);
        }
        for (ChatTap t : list) {
            try {
                t.onChat(message);
            } catch (Throwable ignored) {
                // 录制失败绝不影响命令与游戏
            }
        }
    }
}
