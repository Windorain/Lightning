package com.lightning.mod.client.controlplane.mc.player;

import java.util.ArrayList;
import java.util.List;

import net.minecraft.client.Minecraft;
import net.minecraft.client.entity.EntityClientPlayerMP;
import net.minecraft.client.multiplayer.PlayerControllerMP;
import net.minecraft.client.network.NetHandlerPlayClient;
import net.minecraft.entity.Entity;
import net.minecraft.entity.player.EntityPlayerMP;
import net.minecraft.item.ItemStack;
import net.minecraft.util.AxisAlignedBB;
import net.minecraft.util.MathHelper;
import net.minecraft.util.MovingObjectPosition;
import net.minecraft.util.Vec3;
import net.minecraft.world.WorldServer;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.lightning.mod.client.controlplane.core.ActionContext;
import com.lightning.mod.client.controlplane.core.CpException;
import com.lightning.mod.client.controlplane.core.ErrorCodes;
import com.lightning.mod.client.controlplane.core.Json;
import com.lightning.mod.client.controlplane.mc.CpLog;
import com.lightning.mod.client.controlplane.mc.WorldRuntime;
import com.lightning.mod.client.controlplane.mc.capture.CaptureControl;

/**
 * L1 玩家操作（{@code client/controlplane/mc/player/}）的公共前置与共用原语。
 *
 * <h2>层归属（两义按层标注）</h2>
 * <b>L1 玩家操作</b>＝<b>经由玩家路径执行</b>：移动、朝向、使用物品、右键、左键、放置、拾取、
 * 容器与背包收放、开关界面。与 <b>L0 原语</b>（{@code scene.*}）的区别不是「谁写的代码」，
 * 而是<b>请求从哪条路进入世界</b>：
 * <ul>
 * <li><b>L0</b>（{@code scene.*}）：直接设定服务端权威世界的状态（{@code world.setBlock}、
 * 直接写 {@code InventoryPlayer}、{@code setPositionAndUpdate}）；快、稳、少变量，用于<b>布景与构造输入</b>。</li>
 * <li><b>L1</b>（{@code player.*}，本包）：把请求做成<b>原版客户端会发出的那个包</b>
 * （{@code PlayerControllerMP} 的 C02/C07/C08/C09/C0E 等），经集成服的
 * {@code NetHandlerPlayServer} 原样处理——距离校验、保护校验、Forge 事件、游戏模式分支、
 * 服务端 {@code ItemInWorldManager} 与 {@code Container.slotClick} 全部照常发生。
 * 用于验证「<b>玩家行为引发的行为</b>」与教程重建。</li>
 * </ul>
 * 两层的结论<b>不互替</b>：{@code scene.player.pose} 的位移不是「走过去了」的证据，
 * {@code scene.inventory.write} 的写入不是「捡起来了」的证据。
 *
 * <h2>为什么走真实客户端对象而不是自己抄一份服务端逻辑</h2>
 * 自造一条「看起来一样」的服务端路径会立刻违反两条纪律：①它必然与真客户端行为分叉
 * （今天是距离校验，明天是 Forge 事件），而分叉恰恰是 L1 存在的意义所在；②它就是「无隐藏通道」
 * 禁止的<b>第二条能力路径</b>。因此本包<b>只</b>调用原版对象自己的方法：
 * {@link PlayerControllerMP#clickBlock}/{@link PlayerControllerMP#onPlayerRightClick}/
 * {@link PlayerControllerMP#sendUseItem}/{@link PlayerControllerMP#attackEntity}/
 * {@link PlayerControllerMP#windowClick}/{@link EntityClientPlayerMP#sendMotionUpdates}——
 * 客户端本地预测与服务端权威结果都由原版自己产生。
 *
 * <h2>线程</h2>
 * 全部方法在客户端 tick 线程（{@code TickEvent.ClientTickEvent} Phase.END）执行。
 * 1.7.10 集成服里客户端 {@code EntityClientPlayerMP} 与它持有的 {@code NetHandlerPlayClient}
 * 就是在该线程被 tick 的（{@code Minecraft.runTick} → {@code theWorld.updateEntities()} →
 * {@code EntityClientPlayerMP.onUpdate()}），因此在这里调它们等价于「玩家这一 tick 按了键」。
 *
 * <h2>失败显式（D4）</h2>
 * 本包绝不「静默成功」：任何动作返回结果前都实读回读（{@code readBack}），
 * 并给出 {@code observed} 布尔——<b>没观察到预期变化就是没观察到</b>，由调用方判定；
 * 参数类错误一律 {@code CP-VALID-002} 带 {@code context.fields}，
 * 前置状态类错误一律 {@code CP-STATE-001} 带上「差什么、怎么补」。
 */
public final class PlayerSession {

    /** 1.7.10 玩家交互距离（服务端 {@code ItemInWorldManager.getBlockReachDistance()} 默认 5.0）。 */
    public static final double SERVER_REACH = 5.0D;

    /** 视线与方块求交的采样步长（格）。 */
    private static final double RAY_STEP = 0.02D;

    private PlayerSession() {}

    // ------------------------------------------------------------ 句柄

    /**
     * 公共前置：写入门控 + 客户端玩家 + 客户端世界。
     *
     * <p>
     * L1 与 L0 一样是「改变世界的动作」，因此同样过 {@link CaptureControl#assertWorldWriteAllowed}：
     * 捕获会话期间被别的作业调用即 {@code CP-STATE-001}（契约 §7.3 与 §7.5 第 3 条的既有口径，不是新规则）。
     */
    public static EntityClientPlayerMP requireClientPlayer(ActionContext ctx, String action) {
        CaptureControl.assertWorldWriteAllowed(ctx);
        Minecraft mc = WorldRuntime.mc();
        if (mc == null) {
            throw new CpException(ErrorCodes.STATE, action + "：Minecraft 实例不可用", Json.object("action", action));
        }
        if (mc.theWorld == null) {
            throw new CpException(
                ErrorCodes.STATE,
                action + "：客户端不在世界里（L1 玩家操作需要真实的客户端世界与玩家对象）",
                Json.object(
                    "action",
                    action,
                    "hint",
                    "先进世界：world.rebuild {folder:\"cp_…\",seed:<整数>,void:true,confirm:true}"));
        }
        if (mc.thePlayer == null) {
            throw new CpException(ErrorCodes.STATE, action + "：客户端玩家实体不可用（刚进世界或正在切世界）", Json.object("action", action));
        }
        return mc.thePlayer;
    }

    /** 客户端玩家控制器（发送真实客户端包的那个对象）。 */
    public static PlayerControllerMP requireController(EntityClientPlayerMP player, String action) {
        return requireController(action);
    }

    /**
     * 客户端玩家控制器。
     *
     * <p>
     * 它是 {@code Minecraft.playerController}（不是玩家实体上的字段）——L1 的「玩家路径」定义在这里：
     * 本包只调这个对象的方法，因为只有它会<b>同时</b>发原版客户端包与跑客户端本地预测。
     */
    public static PlayerControllerMP requireController(String action) {
        Minecraft mc = WorldRuntime.mc();
        PlayerControllerMP controller = mc == null ? null : mc.playerController;
        if (controller == null) {
            throw new CpException(
                ErrorCodes.STATE,
                action + "：玩家控制器不可用（Minecraft.playerController 未装配）",
                Json.object("action", action));
        }
        return controller;
    }

    /**
     * 客户端侧发出的包最终落到服务端权威玩家身上的<b>那条链</b>是否在位。
     *
     * <p>
     * 1.7.10 单机用 netty {@code LocalChannel}：客户端 {@code addToSendQueue} 写进 channel，
     * 事件循环线程立刻把它交给服务端 {@code NetHandlerPlayServer}，服务端在自己的 tick 的
     * {@code networkTick()} 里处理。因此「包发出去了」不等于「服务端已经处理了」——
     * 本类提供 {@link #flushClientPackets} 与 {@link #serverPlayer} 让动作能显式等待与回读。
     */
    public static NetHandlerPlayClient requireNetHandler(EntityClientPlayerMP player, String action) {
        NetHandlerPlayClient handler = player.sendQueue;
        if (handler == null) {
            throw new CpException(ErrorCodes.STATE, action + "：客户端网络处理器不可用（未连接到集成服）", Json.object("action", action));
        }
        return handler;
    }

    /** 服务端权威玩家（读回的权威侧）；没有时返回 null（由调用方决定是否报错）。 */
    public static EntityPlayerMP serverPlayer() {
        return WorldRuntime.serverPlayer();
    }

    /** 服务端权威世界；没有时返回 null。 */
    public static WorldServer serverWorld() {
        return WorldRuntime.serverWorld();
    }

    /**
     * 把客户端已排队的出站包推出去。
     *
     * <p>
     * {@code addToSendQueue} 在 channel 就绪时已经直接 writeAndFlush，因此这一步通常是无操作；
     * 但在 channel 尚未就绪（刚进世界）时包会积压在 {@code outboundPacketsQueue} 里，
     * 本调用即那次「补发」。<b>不吞异常</b>：失败说明链路断了，必须让调用方看见。
     */
    public static void flushClientPackets(NetHandlerPlayClient handler) {
        if (handler == null) {
            return;
        }
        try {
            handler.getNetworkManager()
                .processReceivedPackets();
        } catch (Throwable t) {
            CpLog.warn("推送客户端出站包失败（本地链路可能已断）: %s", String.valueOf(t));
        }
    }

    /**
     * 服务端 tick 计数（{@code MinecraftServer.getTickCounter()}）；无服务端时返回 -1。
     *
     * <p>
     * 用它做「等集成服把包处理掉」的判据：1.7.10 单机的集成服<strong>跑在自己的线程</strong>上
     * （{@code MinecraftServer.startServerThread} 起的 "Server thread"），
     * 而 L1 动作在<strong>客户端 tick 线程</strong>执行。「包发出去了」与「服务端处理了」
     * 之间隔着服务端的一次 tick，因此<b>同一次调用里立刻回读会读到处理前的旧值</b>。
     */
    public static int serverTickCounter() {
        net.minecraft.server.MinecraftServer s = WorldRuntime.server();
        if (s == null) {
            return -1;
        }
        try {
            return s.getTickCounter();
        } catch (Throwable t) {
            return -1;
        }
    }

    /** 等待集成服处理已发出的包的默认上限（毫秒）。 */
    public static final long DEFAULT_SERVER_SYNC_TIMEOUT_MS = 500L;

    /** 回读服务端权威状态前默认等待的服务端 tick 数。 */
    public static final int DEFAULT_SERVER_SYNC_TICKS = 2;

    /**
     * 等集成服推进至少 {@code ticks} 个 tick（有界），让本动作刚发出的包被真正处理掉。
     *
     * <h2>为什么必须有这一步（实测踩到的坑）</h2>
     * 首轮实机验证里 {@code player.move} 报了 {@code movedServerBlocks=0, observed=false}，
     * 但紧随其后的 {@code read.player} 却看到服务端玩家确实已经走到了目标位置——
     * 因为集成服在自己的线程上按 50ms 一拍处理 C03，而本动作在<b>包刚发出去</b>时就回读了。
     * 「没观察到」因此是<b>读数过早</b>，不是行为没发生。凡是把 {@code observed} 建在
     * 服务端权威回读上的动作，都必须先把这一拍等过去，否则 {@code observed} 会系统性地假红
     * ——而假红比假绿更坏：调用方会以为玩家路径没生效，转而去怀疑实现。
     *
     * <h2>为什么可以在这里阻塞</h2>
     * 本动作跑在客户端 tick 线程；集成服是另一个线程，{@link Thread#sleep} 正好把它让出来跑。
     * 契约里已有更重的先例（§10 第 12 条：{@code mc.loadWorld(null)} 在 tick 线程内冻结数秒到数十秒）。
     * 上界 {@link #DEFAULT_SERVER_SYNC_TIMEOUT_MS}（默认 500ms ≈ 10 个服务端 tick）保证
     * 即使集成服卡住，本动作也只多花半秒就如实返回，不会把客户端拖死。
     *
     * @param ticks     期望推进的服务端 tick 数（≤0 直接返回）
     * @param timeoutMs 上限（毫秒，≤0 取默认）
     * @return 实际等待的毫秒数；负值表示服务端不可用（未能等到）
     */
    public static long awaitServerTicks(int ticks, long timeoutMs) {
        if (ticks <= 0) {
            return 0L;
        }
        int before = serverTickCounter();
        if (before < 0) {
            return -1L;
        }
        long limit = timeoutMs > 0 ? timeoutMs : DEFAULT_SERVER_SYNC_TIMEOUT_MS;
        long start = System.currentTimeMillis();
        while (serverTickCounter() - before < ticks) {
            if (System.currentTimeMillis() - start > limit) {
                break;
            }
            try {
                Thread.sleep(2L);
            } catch (InterruptedException e) {
                Thread.currentThread()
                    .interrupt();
                break;
            }
        }
        return System.currentTimeMillis() - start;
    }

    /**
     * 回读服务端权威状态前的默认等待。
     *
     * <p>
     * 默认 {@value #DEFAULT_SERVER_SYNC_TICKS} 个服务端 tick：足以覆盖
     * 「一次写入 → 服务端 tick → 权威状态可见」这条链，又短到不拖慢批量驱动。
     * 返回实际等待毫秒数（供动作写进结果，让「等了多久」可见）。
     */
    public static long awaitServerSync() {
        return awaitServerTicks(DEFAULT_SERVER_SYNC_TICKS, DEFAULT_SERVER_SYNC_TIMEOUT_MS);
    }

    /**
     * 收口一次 L1 请求：把客户端出站包推出去，再<b>等集成服把这一拍处理掉</b>，然后才允许回读权威状态。
     *
     * <p>
     * 这是每个 L1 动作回读前的统一收尾：分两步做（{@link #flushClientPackets} +
     * {@link #awaitServerSync}）是有意的——「包发出去了」与「服务端处理了」是两件事，
     * 合并成一个方法是为了让「忘了等」这件事在代码里不可能发生（漏掉会表现为 observed 系统性假红）。
     *
     * @return 实际等待的毫秒数（写进动作结果，让「等了多久」可见）；负值表示服务端不可用
     */
    public static long completeClientRequest(NetHandlerPlayClient handler) {
        flushClientPackets(handler);
        return awaitServerSync();
    }

    // ------------------------------------------------------------ 数值序列化（JSON 合法性）

    /**
     * 把浮点数安全地写进 JSON：非有限值（{@code NaN} / {@code Infinity}）写成 {@code null}。
     *
     * <h2>为什么必须有这一个函数（实测事故）</h2>
     * {@code JsonObject.addProperty(String, Number)} 会把 {@code Float.POSITIVE_INFINITY} 原样写成
     * 字面量 <b>{@code Infinity}</b>，而 <b>JSON 规范没有 Infinity/NaN 字面量</b>——
     * 于是整份响应体变成<b>非法 JSON</b>，任何严格解析的调用方（含本仓的 {@code caller.mjs}、
     * 浏览器的 {@code JSON.parse}）都会当场报错，而服务端 HTTP 状态码仍是 200。
     * 实测触发点：{@code player.dig} 的 {@code relativeHardness} —— 方块已被挖掉后再读硬度，
     * 原版 {@code Block.getPlayerRelativeBlockHardness} 对空气返回 {@code 1.0F/0.0F = Infinity}。
     * 那一次调用在 {@code caller.mjs} 里表现为「HTTP 200 但解析失败」
     * （{@code error.code = "HTTP-200"}），排查方向被彻底带偏（详见证据里的 raw body）。
     *
     * <p>
     * 因此凡是「原版 API 可能返回非有限值」的浮点读数，都走本函数而不是直接
     * {@code addProperty}。{@code null} 是<b>显式可见</b>的「读不出来」，
     * 比一个能毒掉整份响应体的字面量安全得多。
     *
     * @param v 待写数值
     * @return 有限值时返回该 {@link Double}；否则返回 {@code null}
     */
    public static Double finiteOrNull(double v) {
        return Double.isFinite(v) ? Double.valueOf(v) : null;
    }

    /** {@link #finiteOrNull(double)} 的写入形态：{@code PlayerSession.addFinite(o, "k", v)}。 */
    public static void addFinite(JsonObject o, String key, double v) {
        o.addProperty(key, finiteOrNull(v));
    }

    /**
     * 自检：结果对象里不得含非有限浮点（{@code NaN}/{@code Infinity}），否则整份响应体会变成非法 JSON。
     *
     * <h2>为什么放在收尾而不是每处写入点</h2>
     * {@link #finiteOrNull} 处理了<b>已知</b>的危险点（原版 API 明确会返回 Infinity/NaN 的那几处）。
     * 但「已知」会随时间腐化：将来加一个「读某模组字段」的读数，就可能重新引入非有限值，
     * 而它的后果是<b>协议级</b>的（调用方解析失败，而 HTTP 仍是 200），排查成本极高
     * ——实测事故：{@code caller.mjs} 报 {@code error.code = "HTTP-200"}，把方向带偏到鉴权/路由上，
     * 真正的原因是响应体里出现了 {@code "relativeHardness":Infinity}。
     * 因此在每个 L1 动作的唯一收尾出口（{@link #decorated}）放一道机检：
     * 命中即 {@code CP-EXEC-001} 并<b>指名到字段路径</b>——宁可让这次调用显式失败，
     * 也不要把一份解析不了的响应交给调用方（「失败显式」：错误必须可诊断，
     * 不能是「200 但读不懂」）。
     *
     * @param o   待检查的结果对象
     * @param who 动作名（错误信息用）
     * @throws CpException CP-EXEC-001：含非有限浮点，{@code context.badPaths} 给出字段路径与取值
     */
    public static void assertJsonSafe(JsonObject o, String who) {
        JsonArray bad = new JsonArray();
        walkJson(o, "", bad);
        if (bad.size() == 0) {
            return;
        }
        throw new CpException(
            ErrorCodes.EXEC_FAILED,
            who + "：结果里含非有限浮点数（NaN/Infinity）——JSON 没有这两个字面量，"
                + "直接序列化会让整份响应体变成非法 JSON（调用方解析失败而 HTTP 仍 200）。"
                + "请把该读数改为 null（见 PlayerSession.finiteOrNull）",
            Json.object("action", who, "badPaths", bad, "count", Integer.valueOf(bad.size())));
    }

    /** 递归找非有限浮点，把 {@code {path, value}} 收进 {@code out}。 */
    private static void walkJson(com.google.gson.JsonElement e, String path, JsonArray out) {
        if (e == null) {
            return;
        }
        if (e.isJsonObject()) {
            for (java.util.Map.Entry<String, com.google.gson.JsonElement> en : e.getAsJsonObject()
                .entrySet()) {
                walkJson(en.getValue(), path + "/" + en.getKey(), out);
            }
            return;
        }
        if (e.isJsonArray()) {
            JsonArray a = e.getAsJsonArray();
            for (int i = 0; i < a.size(); i++) {
                walkJson(a.get(i), path + "/" + i, out);
            }
            return;
        }
        if (!e.isJsonPrimitive()) {
            return;
        }
        com.google.gson.JsonPrimitive p = e.getAsJsonPrimitive();
        if (!p.isNumber()) {
            return;
        }
        double v;
        try {
            v = p.getAsDouble();
        } catch (RuntimeException ex) {
            return;
        }
        if (!Double.isFinite(v)) {
            out.add(Json.object("path", path, "value", String.valueOf(v)));
        }
    }

    // ------------------------------------------------------------ 移动原语（唯一实现点）

    /**
     * 朝目标点走一小步（原版碰撞推进），并让原版客户端把新位置发给服务端。
     *
     * <h2>为什么必须只有一个实现点</h2>
     * 「逐 tick 走一小步」这件事在本包里有<b>两个</b>调用方：{@code player.move}（走向指定坐标）
     * 与 {@code player.pickup}（走向掉落物）。首轮实现里两者各写了一份循环，
     * 结果 pickup 那份有缺陷（实测：玩家走成了斜线并卡进地板，200 tick 只挪了 3 格就 blocked），
     * 而 move 那份是对的。两份实现 = 两个真相，正是本仓读面已经吃过一次亏的形态
     * （{@code ReadSupport} 的注释：「同一个量在两处读法不同」这种缺陷最难查）。
     * 因此移动原语收敛到本方法，两个动作都调它。
     *
     * @param client 客户端玩家
     * @param toX    目标 X
     * @param toY    目标 Y
     * @param toZ    目标 Z
     * @param step   本步最大长度（格）
     * @return 本步实际位移的格数（0 表示推不动——被方块挡住或目标已到）
     */
    public static double stepToward(EntityClientPlayerMP client, double toX, double toY, double toZ, double step) {
        double dx = toX - client.posX;
        double dy = toY - client.posY;
        double dz = toZ - client.posZ;
        double remaining = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (remaining <= 1.0E-6D) {
            return 0.0D;
        }
        double len = Math.min(step, remaining);
        double beforeX = client.posX;
        double beforeY = client.posY;
        double beforeZ = client.posZ;
        client.moveEntity(dx / remaining * len, dy / remaining * len, dz / remaining * len);
        // 原版客户端的「把当前位置/朝向发给服务端」出口（C03 家族）；不自己拼包
        client.sendMotionUpdates();
        double mx = client.posX - beforeX;
        double my = client.posY - beforeY;
        double mz = client.posZ - beforeZ;
        return Math.sqrt(mx * mx + my * my + mz * mz);
    }

    /**
     * 客户端玩家的 {@code posY} 相对服务端权威 {@code posY} 的偏移（实测 {@code +1.62}）。
     *
     * <h2>这是 1.7.10 的一个真实约定差异，不是 bug 也不是本模组引入的</h2>
     * 服务端 {@code NetHandlerPlayServer.setPlayerLocation} 发 S08 时写的是
     * <b>眼睛高度</b>：{@code new S08PacketPlayerPosLook(x, y + 1.6200000047683716D, z, …)}
     * （源码见 {@code NetHandlerPlayServer.java:450}）；
     * 而客户端 {@code NetHandlerPlayClient.handlePlayerPosLook} 收到后直接
     * {@code setPositionAndRotation(d0, d1, d2, …)}，<b>没有减掉那 1.62</b>
     * （源码见 {@code NetHandlerPlayClient.java:641}）。
     * 于是<b>客户端玩家的 {@code posY} 恒等于服务端 {@code posY} + 1.62</b>。
     *
     * <h2>为什么必须显式建模这件事（实测事故）</h2>
     * 移动原语在客户端玩家身上算步长。若把「服务端空间的 y」直接当客户端目标 y 用，
     * 就凭空多出 −1.62 的<b>向下分量</b>：{@code player.pickup} 的「是否同层」判断
     * （{@code |dy| > 1}）会因此被误判为「不在同层」，于是插入向下走，
     * 玩家斜着走、卡在地板边缘并横向漂出平台（实测：终点 x=62.69，平台是 63..70）。
     * 同一个偏移也让客户端的 {@code arrived} 恒为 false（差 1.62 永远到不了容差），
     * 只能用服务端读数补救——现在两者一起修好了。
     *
     * <p>
     * 用<b>实读差</b>而不是硬编码 1.62：不同版本/模组改了这个约定的情况下，
     * 这里会自动跟着变；取不到任一侧时返回 0（退化为「两端同空间」的朴素假设并如实暴露）。
     *
     * @return {@code client.posY - server.posY}；任一侧不可用时返回 0
     */
    public static double clientYOffset(EntityClientPlayerMP client, EntityPlayerMP server) {
        if (client == null || server == null) {
            return 0.0D;
        }
        return saneYOffset(client.posY - server.posY);
    }

    /**
     * {@link #clientYOffset} 的取值闸门（纯函数，单测覆盖）：不合理就退化为 0。
     *
     * <p>
     * 为什么需要闸门：偏移由两个对象的位置相减而来，而位置可能是 {@code NaN} 或越界
     * （实体刚生成、跨维度传输中）。不拦的话 {@code NaN} 会顺着步长传播进
     * {@code moveEntity}，把一个可诊断的「位置异常」变成一次含义不明的失败；
     * 而「偏移 0」至少等价于「按同空间处理」，是可预期的退化。
     *
     * @param off {@code client.posY - server.posY}
     * @return 有限且 {@code |off| < 8} 时原样返回，否则 0
     */
    static double saneYOffset(double off) {
        return Double.isFinite(off) && Math.abs(off) < 8.0D ? off : 0.0D;
    }

    /**
     * 朝<b>服务端空间</b>的目标点走一小步（自动换算客户端 y 约定）。
     *
     * <p>
     * 所有「目标坐标」都来自服务端权威侧（{@code player.move} 的 {@code to} 参数、
     * 掉落物的 {@code posY}），而移动发生在客户端玩家身上——两者差一个
     * {@link #clientYOffset}。本方法是这个换算的<b>唯一实现点</b>：
     * 两个移动调用方（{@code player.move} / {@code player.pickup}）都用它，
     * 免得各自漏掉换算而演化出不同缺陷。
     *
     * @param toX  服务端空间目标 X
     * @param toY  服务端空间目标 Y
     * @param toZ  服务端空间目标 Z
     * @param step 本步最大长度（格）
     * @return 本步实际位移的格数（0 = 推不动）
     */
    public static double stepTowardServer(EntityClientPlayerMP client, EntityPlayerMP server, double toX, double toY,
        double toZ, double step) {
        return stepToward(client, toX, toY + clientYOffset(client, server), toZ, step);
    }

    // ------------------------------------------------------------ 视线

    /** 一次视线求交的读数。 */
    public static final class Sight {

        /** 命中类型。 */
        public final MovingObjectPosition hit;
        /** 服务端玩家眼睛位置。 */
        public final double[] eye;
        /** 完整视线向量（从眼睛到 pitch/yaw 指的方向，长度 = 交互距离）。 */
        public final double[] look;

        Sight(MovingObjectPosition hit, double[] eye, double[] look) {
            this.hit = hit;
            this.eye = eye;
            this.look = look;
        }

        /** 是否命中方块。 */
        public boolean blockHit() {
            return hit != null && hit.typeOfHit == MovingObjectPosition.MovingObjectType.BLOCK;
        }

        /** 是否命中实体。 */
        public boolean entityHit() {
            return hit != null && hit.typeOfHit == MovingObjectPosition.MovingObjectType.ENTITY;
        }

        /** 命中格坐标；未命中返回 null。 */
        public int[] blockPos() {
            return blockHit() ? new int[] { hit.blockX, hit.blockY, hit.blockZ } : null;
        }

        /** 命中面；未命中返回 -1。 */
        public int side() {
            return hit == null ? -1 : hit.sideHit;
        }
    }

    /**
     * 从服务端权威玩家的眼睛出发，按它的真实 yaw/pitch 发射线，与方块和实体求交。
     *
     * <h2>为什么用服务端玩家而不是客户端玩家</h2>
     * 权威位置与朝向在服务端（{@code EntityPlayerMP}）；客户端 {@code EntityClientPlayerMP} 的
     * 位置会被 S08 覆写、朝向可能还没同步过去。用服务端玩家的姿态算视线，
     * 得到的就是「服务端此刻认为玩家在看哪里」——而服务端在处理 C07/C08 时做的正是同一件事
     * （{@code NetHandlerPlayServer} 的距离校验用的是 {@code this.playerEntity} 的位置与视线无关，
     * 但 {@code processPlayerDigging} 的坐标来自包本身，因此包里的坐标必须落在服务端认可的位置附近）。
     *
     * <p>
     * 求交口径与原版 {@code EntityRenderer.getMouseOver} 一致：先按 pitch/yaw 算单位视线，
     * 走 {@link net.minecraft.world.World#rayTraceBlocks} 拿方块命中；方块没命中或更近时再走实体
     * {@code getEntitiesWithinAABBExcludingEntity} + {@code calculateIntercept}。
     *
     * @param reach 交互距离（格），见 {@link #SERVER_REACH}
     * @return 视线读数（未命中时 {@code hit} 为 null，{@code look} 仍然是完整视线向量）
     */
    public static Sight sight(EntityPlayerMP player, double reach, boolean includeEntities) {
        if (player == null) {
            return null;
        }
        double eyeX = player.posX;
        double eyeY = player.posY + player.getEyeHeight();
        double eyeZ = player.posZ;
        // 1.7.10 的 getLook 口径：d = (-sin(yaw)cos(pitch), -sin(pitch), cos(yaw)cos(pitch))
        float yawRad = (float) Math.toRadians(player.rotationYaw);
        float pitchRad = (float) Math.toRadians(player.rotationPitch);
        double dx = -MathHelper.sin(yawRad) * MathHelper.cos(pitchRad);
        double dy = -MathHelper.sin(pitchRad);
        double dz = MathHelper.cos(yawRad) * MathHelper.cos(pitchRad);
        double ex = eyeX + dx * reach;
        double ey = eyeY + dy * reach;
        double ez = eyeZ + dz * reach;

        MovingObjectPosition best = null;
        double bestDist = Double.MAX_VALUE;
        try {
            MovingObjectPosition blockHit = rayTrace(player, eyeX, eyeY, eyeZ, ex, ey, ez);
            if (blockHit != null) {
                best = blockHit;
                bestDist = squared(
                    eyeX,
                    eyeY,
                    eyeZ,
                    blockHit.hitVec.xCoord,
                    blockHit.hitVec.yCoord,
                    blockHit.hitVec.zCoord);
            }
        } catch (Throwable t) {
            CpLog.warn("方块视线求交失败: %s", String.valueOf(t));
        }
        if (includeEntities) {
            try {
                List<?> candidates = player.worldObj.getEntitiesWithinAABBExcludingEntity(
                    player,
                    player.boundingBox.addCoord(dx * reach, dy * reach, dz * reach)
                        .expand(1.0D, 1.0D, 1.0D));
                if (candidates != null) {
                    for (Object o : candidates) {
                        if (!(o instanceof Entity)) {
                            continue;
                        }
                        Entity entity = (Entity) o;
                        if (!entity.canBeCollidedWith()) {
                            continue;
                        }
                        float pad = entity.getCollisionBorderSize();
                        AxisAlignedBB box = entity.boundingBox.expand(pad, pad, pad);
                        MovingObjectPosition mop = box.calculateIntercept(
                            Vec3.createVectorHelper(eyeX, eyeY, eyeZ),
                            Vec3.createVectorHelper(ex, ey, ez));
                        if (mop == null) {
                            continue;
                        }
                        double d = squared(eyeX, eyeY, eyeZ, mop.hitVec.xCoord, mop.hitVec.yCoord, mop.hitVec.zCoord);
                        if (d < bestDist) {
                            mop.typeOfHit = MovingObjectPosition.MovingObjectType.ENTITY;
                            mop.entityHit = entity;
                            best = mop;
                            bestDist = d;
                        }
                    }
                }
            } catch (Throwable t) {
                CpLog.warn("实体视线求交失败: %s", String.valueOf(t));
            }
        }
        return new Sight(best, new double[] { eyeX, eyeY, eyeZ }, new double[] { dx, dy, dz });
    }

    /** 走原版世界的方块射线；世界不可用时回落手写 DDA（口径与原版一致：只判实心/液体）。 */
    private static MovingObjectPosition rayTrace(EntityPlayerMP player, double x0, double y0, double z0, double x1,
        double y1, double z1) {
        try {
            return player.worldObj
                .rayTraceBlocks(Vec3.createVectorHelper(x0, y0, z0), Vec3.createVectorHelper(x1, y1, z1), false);
        } catch (Throwable t) {
            CpLog.warn("world.rayTraceBlocks 失败，回落逐点采样: %s", String.valueOf(t));
            return sampleRay(player, x0, y0, z0, x1, y1, z1);
        }
    }

    /** 逐点采样求交（仅在原版射线不可用时使用）。 */
    private static MovingObjectPosition sampleRay(EntityPlayerMP player, double x0, double y0, double z0, double x1,
        double y1, double z1) {
        double dx = x1 - x0;
        double dy = y1 - y0;
        double dz = z1 - z0;
        double dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (dist <= 0.0D) {
            return null;
        }
        int steps = (int) Math.ceil(dist / RAY_STEP);
        for (int i = 1; i <= steps; i++) {
            double f = (double) i / (double) steps;
            double px = x0 + dx * f;
            double py = y0 + dy * f;
            double pz = z0 + dz * f;
            int bx = MathHelper.floor_double(px);
            int by = MathHelper.floor_double(py);
            int bz = MathHelper.floor_double(pz);
            try {
                net.minecraft.block.Block block = player.worldObj.getBlock(bx, by, bz);
                if (block == null || block.getMaterial() == net.minecraft.block.material.Material.air) {
                    continue;
                }
                return new MovingObjectPosition(bx, by, bz, 0, Vec3.createVectorHelper(px, py, pz));
            } catch (Throwable t) {
                return null;
            }
        }
        return null;
    }

    private static double squared(double x0, double y0, double z0, double x1, double y1, double z1) {
        double dx = x1 - x0;
        double dy = y1 - y0;
        double dz = z1 - z0;
        return dx * dx + dy * dy + dz * dz;
    }

    /**
     * 命中点相对方块原点的小数偏移（C08 的 {@code hitX/hitY/hitZ}，取值 [0,1)）。
     *
     * <p>
     * 用视线与方块包围盒的真实交点，而不是方块中心——放置方向、{@code Block.onBlockActivated}
     * 的命中面判定都吃这几个值（原版 {@code PlayerControllerMP.onPlayerRightClick} 同样是
     * {@code hitVector - blockPos}）。
     */
    public static float[] hitOffsets(Sight sight) {
        if (sight == null || sight.hit == null || sight.hit.hitVec == null) {
            return new float[] { 0.5F, 0.5F, 0.5F };
        }
        Vec3 hit = sight.hit.hitVec;
        if (sight.blockHit()) {
            return new float[] { (float) (hit.xCoord - sight.hit.blockX), (float) (hit.yCoord - sight.hit.blockY),
                (float) (hit.zCoord - sight.hit.blockZ) };
        }
        // 实体：命中点相对实体位置的偏移（原版对实体交互不做 0..1 归一，直接给原始值）
        Entity e = sight.hit.entityHit;
        return new float[] { (float) (hit.xCoord - e.posX), (float) (hit.yCoord - e.posY),
            (float) (hit.zCoord - e.posZ) };
    }

    /**
     * 「这一格在不在服务端的交互距离内」——把服务端自己会做的判定搬出来做<b>预检</b>。
     *
     * <p>
     * 依据是 {@code NetHandlerPlayServer.processPlayerDigging} 与 {@code processPlayerBlockPlacement}：
     * {@code dist = getBlockReachDistance() + 1}（默认 6.0），
     * 方块距离按 {@code (x+0.5, y+0.5, z+0.5)} 且 y 再加 1.5 算。
     * <b>预检不替代服务端校验</b>——包照发，服务端该拒还是拒；预检只是让「注定被拒」的调用
     * 在返回值里就说明白（错误上下文可读），而不是等调用方看到「什么都没发生」再猜。
     */
    public static double serverReachSquared(EntityPlayerMP player, int x, int y, int z) {
        if (player == null) {
            return -1.0D;
        }
        double d0 = player.posX - ((double) x + 0.5D);
        double d1 = player.posY - ((double) y + 0.5D) + 1.5D;
        double d2 = player.posZ - ((double) z + 0.5D);
        return d0 * d0 + d1 * d1 + d2 * d2;
    }

    /** 服务端交互距离上限的平方（{@code (getBlockReachDistance() + 1)^2}，默认 36）。 */
    public static double serverReachLimitSquared() {
        double reach = SERVER_REACH;
        EntityPlayerMP player = serverPlayer();
        if (player != null && player.theItemInWorldManager != null) {
            try {
                reach = player.theItemInWorldManager.getBlockReachDistance();
            } catch (Throwable ignored) {
                // 保持默认 5.0
            }
        }
        double dist = reach + 1.0D;
        return dist * dist;
    }

    // ------------------------------------------------------------ 回读

    /** 世界一格读数：{@code {pos, blockId, meta, id}}。 */
    public static JsonObject blockRead(WorldServer world, int x, int y, int z) {
        JsonObject o = new JsonObject();
        o.add("pos", posArray(x, y, z));
        if (world == null) {
            o.addProperty("available", false);
            return o;
        }
        try {
            net.minecraft.block.Block b = world.getBlock(x, y, z);
            o.addProperty("blockId", Integer.valueOf(b == null ? 0 : net.minecraft.block.Block.getIdFromBlock(b)));
            o.addProperty("meta", Integer.valueOf(b == null ? 0 : world.getBlockMetadata(x, y, z)));
            o.addProperty(
                "id",
                b == null ? null : String.valueOf(net.minecraft.block.Block.blockRegistry.getNameForObject(b)));
            o.addProperty(
                "te",
                world.getTileEntity(x, y, z) == null ? null
                    : world.getTileEntity(x, y, z)
                        .getClass()
                        .getName());
        } catch (Throwable t) {
            o.addProperty("available", false);
            o.addProperty("error", String.valueOf(t));
        }
        return o;
    }

    /** 玩家位置与朝向的实读快照（服务端权威侧）。 */
    public static JsonObject poseRead(EntityPlayerMP player) {
        JsonObject o = new JsonObject();
        if (player == null) {
            o.addProperty("available", false);
            return o;
        }
        o.add("pos", doubleArray(player.posX, player.posY, player.posZ));
        o.addProperty("yaw", finiteOrNull(player.rotationYaw));
        o.addProperty("pitch", finiteOrNull(player.rotationPitch));
        o.addProperty("onGround", Boolean.valueOf(player.onGround));
        o.addProperty("dimension", Integer.valueOf(player.dimension));
        return o;
    }

    /** 玩家手持与光标物品读数。 */
    public static JsonObject heldRead(EntityPlayerMP player) {
        JsonObject o = new JsonObject();
        if (player == null) {
            o.addProperty("available", false);
            return o;
        }
        o.addProperty("currentItem", Integer.valueOf(player.inventory.currentItem));
        o.add("main", stackRead(player.getHeldItem()));
        o.add("cursor", stackRead(player.inventory.getItemStack()));
        return o;
    }

    /** 物品栈读数：{@code {empty:true}} 或 {@code {empty:false, id, meta, count, displayName, nbtPresent}}。 */
    public static JsonObject stackRead(ItemStack stack) {
        JsonObject o = new JsonObject();
        if (stack == null || stack.getItem() == null) {
            o.addProperty("empty", true);
            return o;
        }
        o.addProperty("empty", false);
        try {
            o.addProperty("id", String.valueOf(net.minecraft.item.Item.itemRegistry.getNameForObject(stack.getItem())));
        } catch (Throwable t) {
            o.addProperty("id", (String) null);
        }
        o.addProperty("meta", Integer.valueOf(stack.getItemDamage()));
        o.addProperty("count", Integer.valueOf(stack.stackSize));
        o.addProperty("maxStackSize", Integer.valueOf(stack.getMaxStackSize()));
        try {
            o.addProperty("displayName", stack.getDisplayName());
        } catch (Throwable t) {
            o.addProperty("displayName", (String) null);
        }
        o.addProperty("nbtPresent", Boolean.valueOf(stack.getTagCompound() != null));
        return o;
    }

    /** 玩家背包逐槽非空读数（用于「拾取/收放过后东西真的在背包里」的观察）。 */
    public static JsonArray inventoryRead(EntityPlayerMP player) {
        JsonArray out = new JsonArray();
        if (player == null) {
            return out;
        }
        try {
            for (int i = 0; i < player.inventory.getSizeInventory(); i++) {
                ItemStack s = player.inventory.getStackInSlot(i);
                if (s == null || s.getItem() == null) {
                    continue;
                }
                JsonObject e = stackRead(s);
                e.addProperty("slot", Integer.valueOf(i));
                out.add(e);
            }
        } catch (Throwable t) {
            CpLog.warn("背包回读失败: %s", String.valueOf(t));
        }
        return out;
    }

    /** 背包里某物品的总数（按 id+meta 匹配；{@code id} 为 null 即全物品种类计数）。 */
    public static int countInInventory(EntityPlayerMP player, String itemId, int meta, boolean matchMeta) {
        if (player == null) {
            return 0;
        }
        int total = 0;
        try {
            for (int i = 0; i < player.inventory.getSizeInventory(); i++) {
                ItemStack s = player.inventory.getStackInSlot(i);
                if (s == null || s.getItem() == null) {
                    continue;
                }
                if (itemId != null) {
                    String id = String.valueOf(net.minecraft.item.Item.itemRegistry.getNameForObject(s.getItem()));
                    if (!itemId.equals(id)) {
                        continue;
                    }
                    if (matchMeta && s.getItemDamage() != meta) {
                        continue;
                    }
                }
                total += s.stackSize;
            }
        } catch (Throwable t) {
            CpLog.warn("背包计数失败: %s", String.valueOf(t));
        }
        return total;
    }

    // ------------------------------------------------------------ 参数

    /**
     * 取一个数值参数（int 与 double 都收）；缺失返回 null，类型不符抛 {@code CP-VALID-002}。
     *
     * <p>
     * 与 L0 的 {@code L0Session.optNumber} 同为「类型错误必须显式失败」的口径：
     * {@code optBool/optInt} 那套的语义是「缺失<b>或</b>类型不符都用默认值」，
     * 会把「把 {@code distance} 写成字符串」这类笔误静默变成默认行为（契约 §7.5 共同口径第 4 条「失败显式」）。
     */
    public static Double optNumberPublic(ActionContext ctx, String name) {
        com.google.gson.JsonElement e = ctx.param(name);
        if (e == null) {
            return null;
        }
        if (!e.isJsonPrimitive() || !e.getAsJsonPrimitive()
            .isNumber()) {
            throw CpException.param("参数类型不符", name, "应为 number（收到 " + e + "）");
        }
        return Double.valueOf(e.getAsDouble());
    }

    // ------------------------------------------------------------ 结果装饰

    /**
     * 结果装饰：补 {@code action}/{@code layer}/{@code semantics} 与 {@code pose}，并做 JSON 合法性自检。
     *
     * <p>
     * 这是每个 L1 动作的<b>唯一收尾出口</b>——所有动作都经它返回结果。因此
     * {@link #assertJsonSafe} 放在这里就覆盖了整组：任何非有限浮点都无法溜进响应体。
     */
    public static JsonObject decorated(String action, String semantics, JsonObject result, EntityPlayerMP player) {
        JsonObject o = result == null ? new JsonObject() : result;
        o.addProperty("action", action);
        o.addProperty("layer", "L1");
        o.addProperty("semantics", semantics);
        if (player != null) {
            o.add("pose", poseRead(player));
        }
        assertJsonSafe(o, action);
        return o;
    }

    /** {@code [x,y,z]} 整数数组。 */
    public static JsonArray posArray(int... pos) {
        JsonArray a = new JsonArray();
        for (int v : pos) {
            Json.add(a, Integer.valueOf(v));
        }
        return a;
    }

    /** {@code [x,y,z]} 浮点数组（保留 6 位，避免读数被浮点噪声灌满）。 */
    public static JsonArray doubleArray(double... v) {
        JsonArray a = new JsonArray();
        for (double d : v) {
            Json.add(a, Double.valueOf(Math.round(d * 1000000.0D) / 1000000.0D));
        }
        return a;
    }

    /** 命中读数（留痕用）。 */
    public static JsonObject sightRead(Sight sight) {
        JsonObject o = new JsonObject();
        if (sight == null) {
            o.addProperty("available", false);
            return o;
        }
        o.add("eye", doubleArray(sight.eye));
        o.add("look", doubleArray(sight.look));
        if (sight.hit == null) {
            o.addProperty("type", "miss");
            return o;
        }
        o.addProperty("type", sight.hit.typeOfHit == null ? null : sight.hit.typeOfHit.name());
        if (sight.blockHit()) {
            o.add("block", posArray(sight.hit.blockX, sight.hit.blockY, sight.hit.blockZ));
            o.addProperty("side", Integer.valueOf(sight.hit.sideHit));
            o.add("hitVec", doubleArray(sight.hit.hitVec.xCoord, sight.hit.hitVec.yCoord, sight.hit.hitVec.zCoord));
            float[] off = hitOffsets(sight);
            JsonArray offsets = new JsonArray();
            for (float f : off) {
                Json.add(offsets, Double.valueOf(Math.round(f * 1000000.0D) / 1000000.0D));
            }
            o.add("hitOffset", offsets);
        } else if (sight.entityHit()) {
            o.addProperty("entityId", Integer.valueOf(sight.hit.entityHit.getEntityId()));
            o.addProperty(
                "entityClass",
                sight.hit.entityHit.getClass()
                    .getName());
        }
        return o;
    }

    /**
     * 取一个「实体条目数组」参数里的全部实体 id（用于回读「实体还在不在」）。
     *
     * <p>
     * 供 {@code player.interact} 之类的动作把「打到了谁」写进结果。
     */
    public static List<Entity> nearbyEntities(EntityPlayerMP player, double radius) {
        List<Entity> out = new ArrayList<Entity>();
        if (player == null) {
            return out;
        }
        try {
            List<?> list = player.worldObj
                .getEntitiesWithinAABBExcludingEntity(player, player.boundingBox.expand(radius, radius, radius));
            if (list != null) {
                for (Object o : list) {
                    if (o instanceof Entity) {
                        out.add((Entity) o);
                    }
                }
            }
        } catch (Throwable t) {
            CpLog.warn("附近实体枚举失败: %s", String.valueOf(t));
        }
        return out;
    }
}
