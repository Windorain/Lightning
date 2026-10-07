package com.lightning.mod.client.controlplane.mc.input.observe;

import java.util.ArrayList;
import java.util.List;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.lightning.mod.client.controlplane.core.Contract;
import com.lightning.mod.client.controlplane.core.Json;
import com.lightning.mod.client.controlplane.core.TimeSource;
import com.lightning.mod.client.controlplane.mc.input.InputCapabilities;
import com.lightning.mod.client.controlplane.mc.input.InputCoordinateMath;
import com.lightning.mod.client.controlplane.mc.input.api.InputRuntime;
import com.lightning.mod.client.controlplane.mc.input.api.InputStateProvider;
import com.lightning.mod.client.controlplane.mc.input.api.InputStateSnapshot;

/**
 * {@code input.state} 的<b>实现</b>（Gitea #162 §9.3：T2-B 拥有字段组装、只读探针、消费链观察、
 * {@code physicalConcurrent} 的键盘侧判定）。
 *
 * <h2>所有权边界（为什么本类只依赖 {@code api/} 与纯数据类）</h2>
 * <ul>
 * <li>运行时实例<b>由构造器注入</b> {@link InputRuntime}（T2-A 的实现类）；本类<b>不</b>依赖它的实现类，
 * 只依赖 {@code mc/input/api/} 的接口——这是 T2-A 与 T2-B 两棵树能并行编译的前提（§9.3）；</li>
 * <li>本类<b>不写队列</b>、不注册动作、不改 {@code ActionRegistrar}/{@code ActionDescriptor}/
 * {@code CaseRunAction}/{@code CaseValidator}（§9.3 的「不得碰」列）；</li>
 * <li>本类<b>不</b>自建 tick 订阅者：{@code state()} 由调用方（T3 注册的 {@code input.state} 动作）
 * 在客户端 tick 线程上调用。</li>
 * </ul>
 *
 * <h2>线程纪律（§5.1 第 3 条 / {@code contract.md} §9）</h2>
 * MC 状态（{@code currentScreen}/{@code Keyboard}/{@code Mouse}/{@code Display}）只在客户端 tick 线程读。
 * 本类的做法是：{@code state()} 先向注入的 {@link TickProbe} 要一份 {@link TickObservation}，
 * 而 {@code TickProbe} 的实现有义务断言自己在 tick 线程上；断言不成立时本类<b>不</b>去读任何 MC 状态，
 * 而是返回 {@code ok:false} 的失败体（契约 §6.2「在非 tick 线程上被误用」的形态）。
 *
 * <h2>没有真值来源的字段（§5.2 的「不许用默认值伪装」）</h2>
 * 契约 §5.2 列出的字段里，下列项<b>没有真值来源</b>，本类因此把它们如实落进
 * {@code notImplemented}（而不是填 0 / {@code []} / {@code false}）：
 * <ol>
 * <li>{@code queues.mouseDepth}：{@code Mouse} 的队列深度<b>没有</b>公开探针（契约 §11.2 第 6 条）。
 * 本类把它落成 {@code "unobservable"}——这一项是<b>如实的真值</b>，不是占位：真值由
 * {@link InputStateSnapshot#mouseDepth()} 给出（{@link InputStateSnapshot#DEPTH_UNOBSERVABLE} =
 * 「不可观测」，**不是** 0）；将来若某后端能给出真实深度，本类直接把它写成数字，无需改判据。</li>
 * </ol>
 * <p>
 * #165 起，原先在这张清单里的 {@code queues.deliveredThisJob}/{@code queues.deliveredThisSession}
 * 与 {@code held[].jobId}/{@code held[].heldTicks}/{@code held[].expiresInTicks} 已由
 * {@link InputStateSnapshot} 的只增方法提供了真值来源，故从清单里<b>删除</b>并如实暴露
 * （实现一项删一处，不留漂移）。
 */
public final class InputStateProviderImpl implements InputStateProvider {

    /** 族名（§5.2 恒为 {@code "input"}）。 */
    public static final String FAMILY = "input";

    /** 手段归因（§10.3：与 {@code layer}/{@code semantics} 并列，取值恒为此）。 */
    public static final String MEANS = "input";

    /** 键盘队列容量；读不到时的契约兜底值（§5.2 的 {@code keyboardSeedBaseline} 同源）。 */
    public static final int CONTRACT_KEYBOARD_CAPACITY = 256;

    /** 键盘队列的静态 seed 哨兵条数（lwjgl3ify {@code Keyboard.java:228} 的静态初始化各一条）。 */
    public static final int KEYBOARD_SEED_BASELINE = 1;

    /**
     * {@code queues.mouseDepth} 的契约字符串形态：{@code Mouse} 无公开队列深度探针。
     *
     * <p>
     * 与 {@code InputStateSnapshot.DEPTH_UNOBSERVABLE}（{@code -1}）是同一件事的两种形态：
     * 接口用 {@code -1}（数字域里「读不到」），响应体用契约 §5.2 冻结的 {@code "unobservable"}。
     * 两者都<b>不</b>是 0。
     */
    public static final String MOUSE_DEPTH_UNOBSERVABLE = "unobservable";

    /** 本族返回的错误码清单（§6.1：<b>不</b>新增码，复用既有四个）。 */
    public static final String[] ERRORS = { "CP-VALID-002", "CP-STATE-001", "CP-EXEC-002", "CP-CONFIRM-001" };

    /** 持有上限（tick；§3.2 与 {@code player.dig} 的 {@code MAX_HOLD_TICKS} 同值）。 */
    public static final int HOLD_TICKS_MAX = 1200;

    /** 滚轮单次上限（档；§2.7 第 3 条）。 */
    public static final int WHEEL_AMOUNT_MAX = 8;

    /** GUI 命中集最小静置 tick（§2.4 第 5 条）。 */
    public static final int MIN_SETTLE_TICKS = 2;

    /**
     * 客户端 tick 线程的只读探测口（由 T3 装配时接上 MC/LWJGL；单测注入桩）。
     *
     * <p>
     * 实现<b>必须</b>在客户端 tick 线程上运行：{@link #probe()} 里读的每一个量都是 MC/LWJGL 状态。
     */
    public interface TickProbe {

        /** 在客户端 tick 线程上实读一次。 */
        TickObservation probe();
    }

    /**
     * 「当前线程是不是客户端 tick 线程」的判定口（可注入，便于单测覆盖失败分支）。
     *
     * <p>
     * 返回 {@code null} = <b>无法判定</b>（HTTP 侧探测本身也可能抛），此时 {@code state()} 仍然
     * 去取快照，但把 {@code thread.verified=false} 如实写进结果——「未验证」与「已验证为真」不许混同。
     */
    public interface TickThreadCheck {

        /** 判定。 */
        Boolean isTickThread();
    }

    private final InputRuntime runtime;
    private final TickProbe probe;
    private final TickThreadCheck threadCheck;

    /**
     * 全参构造。
     *
     * @param runtime     输入运行时（T2-A 实现；{@code null} = 未装配 ⇒ 如实报 {@code implemented:false}）
     * @param probe       客户端 tick 线程只读探针（{@code null} = 无探针 ⇒ 能力字段全部落未实现）
     * @param threadCheck 线程判定口（{@code null} = 不判定）
     */
    public InputStateProviderImpl(InputRuntime runtime, TickProbe probe, TickThreadCheck threadCheck) {
        this.runtime = runtime;
        this.probe = probe;
        this.threadCheck = threadCheck;
    }

    /** 便捷构造：有运行时与探针，不做线程判定。 */
    public InputStateProviderImpl(InputRuntime runtime, TickProbe probe) {
        this(runtime, probe, null);
    }

    @Override
    public JsonObject state() {
        Boolean tickThread = isTickThread();
        if (Boolean.FALSE.equals(tickThread)) {
            return threadFailure();
        }
        TickObservation obs = probe == null ? TickObservation.empty(
            Thread.currentThread()
                .getName())
            : probe.probe();
        if (obs == null) {
            obs = TickObservation.empty(
                Thread.currentThread()
                    .getName());
        }
        return assemble(obs, runtime, tickThread);
    }

    // ------------------------------------------------------------ 组装（可测的纯函数）

    /**
     * 把「运行时快照 + tick 探测」组装成 §5.2 的响应体（纯函数：不读任何 MC 状态）。
     *
     * @param obs        本次 tick 探测读数
     * @param runtime    运行时（可为 null）
     * @param tickThread 线程判定结果（null = 未判定）
     */
    public static JsonObject assemble(TickObservation obs, InputRuntime runtime, Boolean tickThread) {
        TickObservation o = obs == null ? TickObservation.empty(null) : obs;
        boolean implemented = runtime != null;
        List<String> gaps = new ArrayList<String>();

        JsonObject data = new JsonObject();
        data.addProperty("implemented", Boolean.valueOf(implemented));
        data.addProperty("family", FAMILY);
        data.addProperty("means", MEANS);
        data.add("runtime", runtimeJson(o, gaps));
        data.add("actions", actionsJson(implemented));
        data.add("keyCatalog", keyCatalogJson(o, implemented));
        data.add("keyCodeRange", keyCodeRangeJson(o, gaps));
        data.addProperty("pollSurface", pollSurfaceText());
        data.add("text", textJson(o));
        data.add("coordinates", coordinatesJson(o));
        data.add("wheel", wheelJson());
        data.add("consumer", consumerJson(o, runtime));
        data.add("hitSet", hitSetJson());
        data.add("queues", queuesJson(o, runtime, gaps));
        data.add("held", heldJson(runtime, o));
        data.add("physical", physicalJson(o, runtime));
        data.add("lifecycle", lifecycleJson());
        data.add("limits", limitsJson());
        data.add("capabilities", capabilitiesJson());
        data.add("thread", threadJson(o, tickThread));
        data.add("errors", errorsJson());
        gaps.addAll(frozenNotImplemented());
        data.add("notImplemented", strings(gaps));
        if (!o.warnings.isEmpty()) {
            data.add("warnings", strings(o.warnings));
        }
        // 契约 §6.2 的线程失败形态：本方法只在调用方已判定「不是 tick 线程」时不走这里（见 state()）
        return data;
    }

    // ------------------------------------------------------------ 各字段

    /**
     * {@code runtime}：版本与可用的注入入口。
     *
     * <p>
     * 版本取不到时写 {@code "unknown"}（与 {@code VersionInfo.UNKNOWN} 同口径：空串会被误读成
     * 「版本就是空」）。{@code injectors} 只列<b>实读可解析</b>的入口——「契约 §1.2 的五个入口」
     * 是<b>白名单</b>，不是「当前 classpath 上确实存在」的证据，故逐个用 {@code Class.forName}
     * + 方法签名比对探测（§1.2 的编译可见性讨论：{@code org.lwjglx.**} 不在 {@code -api} 制品里）。
     */
    private static JsonObject runtimeJson(TickObservation o, List<String> gaps) {
        JsonObject r = new JsonObject();
        r.addProperty("mc", orUnknown(o.runtimeMc));
        r.addProperty("forge", orUnknown(o.runtimeForge));
        r.addProperty("lwjgl3ify", orUnknown(o.runtimeLwjgl3ify));
        r.addProperty("backend", orUnknown(o.runtimeBackend));
        r.add("injectors", strings(o.injectors));
        if (o.injectors.size() < 5) {
            gaps.add("runtime.injectors 只报实读可解析的入口（本次 " + o.injectors.size() + "/5；契约 §1.2 的五个入口是白名单，不是运行期存在的证据）");
        }
        r.addProperty("contractVersion", Contract.VERSION);
        return r;
    }

    /**
     * {@code actions}：**已注册**的输入动作名（§5.2）。
     *
     * <p>
     * 真值在能力真值表 {@link InputCapabilities}（由注册面与 `InputRegistrationTest` 双向对齐），
     * 本包只**消费**、不自行编造。§5.2 末条的自洽要求：`implemented:false` 时必须是空数组。
     *
     * <p>
     * 【实机缺陷 L-3】此处原先恒返回空数组（理由是「动作名的真值在 ActionRegistry，不属本包」），
     * 结果是 `implemented:true` 与 `actions:[]` 同时出现，且 `notImplemented` 把调用方推去读
     * `/cp/v1/actions` —— 与 §5.1 第 4 条「本动作是本族**唯一**的能力声明口」直接冲突。
     */
    private static JsonArray actionsJson(boolean implemented) {
        // §5.2：`actions` 是「**已注册**的输入动作名」，真值在本族的**能力真值表** {@link InputCapabilities}；
        // 那张表由注册面（T3）与 `InputRegistrationTest` 双向对齐，本包只**消费**、不自行编造。
        //
        // 【缺陷修复（实机 L-3）】这里原先恒返回空数组，并把调用方推去读 `/cp/v1/actions` ——
        // 那与 §5.1 第 4 条「本动作是本族**唯一**的能力声明口」直接冲突：能力面自称
        // `implemented:true` 却报不出任何动作名，等于能力发现面在最需要它的时候说谎。
        // 现在：只有「运行时在场」且「本族已注册」才给清单；否则保持空数组（§5.2 末条的自洽要求）。
        JsonArray arr = new JsonArray();
        if (!implemented || !InputCapabilities.ACTIONS_REGISTERED) {
            return arr;
        }
        return InputCapabilities.registeredActionsJson();
    }

    /**
     * {@code keyCatalog}：运行期 {@code GameSettings} 键位注册表实读（§2.2 第 1 条：目录的权威来源）。
     * 未实现时空对象（§5.2）。
     */
    private static JsonObject keyCatalogJson(TickObservation o, boolean implemented) {
        JsonObject cat = new JsonObject();
        if (!implemented) {
            return cat;
        }
        for (java.util.Map.Entry<String, Integer> e : o.keyCatalog.entrySet()) {
            cat.addProperty(e.getKey(), e.getValue());
        }
        return cat;
    }

    /** {@code keyCodeRange}：由 {@code Keyboard.KEY_*} 常量实读；读不到时落 {@code null} + 未实现说明。 */
    private static JsonArray keyCodeRangeJson(TickObservation o, List<String> gaps) {
        if (o.keyCodeRange == null) {
            gaps.add("keyCodeRange：Keyboard.KEY_* 常量集未能实读（Class.forName 失败），不写猜值");
            return null;
        }
        JsonArray arr = new JsonArray();
        Json.add(arr, Integer.valueOf(o.keyCodeRange[0]));
        Json.add(arr, Integer.valueOf(o.keyCodeRange[1]));
        return arr;
    }

    /** 轮询面声明（§2.0：本族只覆盖事件队列面）。 */
    private static String pollSurfaceText() {
        return "not-covered：Keyboard.isKeyDown / Mouse.isButtonDown 读 SDL 物理数组，队列注入不改变它们；"
            + "依赖轮询面的语义（Shift/Ctrl/Alt 组合、GuiContainer 的 Shift 点击、NEI 快捷键、"
            + "SyncedKeybind、MUI Interactable）不在承诺范围 ⇒ 组合键只保证事件序（契约 §2.0/§2.8）";
    }

    /** {@code text}：字符范围与路由（路由未验证 ⇒ false + 未实现说明，§11.2 第 4/5 条）。 */
    private static JsonObject textJson(TickObservation o) {
        JsonObject t = new JsonObject();
        boolean supported = !o.textRanges.isEmpty();
        t.addProperty("supported", Boolean.valueOf(supported));
        JsonArray ranges = new JsonArray();
        for (int[] r : o.textRanges) {
            JsonObject range = new JsonObject();
            range.addProperty("from", r[0]);
            range.addProperty("to", r[1]);
            ranges.add(range);
        }
        t.add("ranges", ranges);
        t.addProperty("delivery", "per-character");
        t.addProperty("unsupportedBehavior", "explicit-fail");
        JsonObject route = new JsonObject();
        route.addProperty("world", o.textRouteWorld == null ? Boolean.FALSE : o.textRouteWorld);
        route.addProperty("gui", o.textRouteGui == null ? Boolean.FALSE : o.textRouteGui);
        if (o.textRouteWorld == null || o.textRouteGui == null) {
            route.addProperty("verified", Boolean.FALSE);
            route.addProperty("note", "路由可达性未实机验证 ⇒ 两个 false 是「未验证」的如实形态，不是「实测不可达」");
        } else {
            route.addProperty("verified", Boolean.TRUE);
        }
        t.add("route", route);
        return t;
    }

    /**
     * {@code coordinates}：缩放/显示尺寸/像素比/回读口径。
     *
     * <p>
     * 【实测】{@code Mouse.getX/getY} 是 <b>SDL 窗口空间</b>口径（lwjgl3ify 的
     * {@code Mouse.addMoveEvent} 里 {@code latestY = Display.getHeight() - sdlY}），
     * 故本块同时给出<b>实读原值</b>（{@code readbackRaw}）与<b>折回事件队列后的值</b>
     * （{@code readbackEvent}）——只有后者与 {@code input.mouse op:move} 的请求值同空间、可判等。
     * 这条口径若写错，{@code move} 的 {@code readback} 会「投递对了却对不上」（差一次翻转）。
     */
    private static JsonObject coordinatesJson(TickObservation o) {
        InputScaleContext ctx = o.context;
        JsonObject c = ctx == null ? new JsonObject() : ctx.toJson();
        if (ctx == null) {
            c.addProperty("space", "gui-scaled-request / sdl-window-delivered");
            c.addProperty("yFlip", InputCoordinateMath.Y_FLIP);
            c.addProperty("note", "本次未取到坐标上下文（无法实读 Display/ScaledResolution）");
        }
        JsonObject calibration = new JsonObject();
        calibration.addProperty("readbackSource", "Mouse.getX/getY（当前光标态口径；与 getEventX/Y 同值域 = displayHeight - sdlY）");
        calibration.addProperty("tolerance", 1);
        calibration.addProperty("compareSpace", InputCoordinateMath.SPACE_EVENT_QUEUE);
        calibration.addProperty("selfCalibrated", Boolean.FALSE);
        calibration.addProperty("reason", "坐标换算的实机自校准归 input.mouse op:move（T2-A 的 readback）；input.state 只提供换算参数与口径");
        if (o.mouseReadable()) {
            JsonObject raw = new JsonObject();
            raw.addProperty("space", InputCoordinateMath.SPACE_EVENT_QUEUE);
            raw.addProperty("x", o.mouseX);
            raw.addProperty("y", o.mouseY);
            raw.addProperty(
                "derivation",
                "Mouse.getX/getY 的值域即 displayHeight - sdlY（lwjgl3ify Mouse.addMoveEvent 的 latestY）");
            calibration.add("observedNowRaw", raw);
            if (o.guiReadbackReadable()) {
                JsonObject gui = new JsonObject();
                gui.addProperty("space", InputCoordinateMath.SPACE_GUI_SCALED);
                gui.addProperty("x", o.mouseGuiX);
                gui.addProperty("y", o.mouseGuiY);
                gui.addProperty(
                    "derivation",
                    "guiX = mouseX*scaledWidth/displayWidth；guiY = scaledHeight - mouseY*scaledHeight/displayHeight - 1"
                        + "（与 EntityRenderer.java:1077-1078 同式；命中集读的就是这一路）");
                calibration.add("observedNowGui", gui);
            }
        } else {
            calibration.addProperty("observedNowRaw", (String) null);
            calibration.addProperty("observedNowNote", "本次未取到鼠标坐标（探针不可用）⇒ 自校准不可判");
        }
        c.add("selfCalibration", calibration);
        return c;
    }

    /** {@code wheel}：单位/整数/符号/上限（§2.7）。 */
    private static JsonObject wheelJson() {
        JsonObject w = new JsonObject();
        w.addProperty("unit", "notch");
        w.addProperty("integerOnly", Boolean.TRUE);
        w.addProperty("sign", "positive=backward");
        w.addProperty("amountMax", WHEEL_AMOUNT_MAX);
        w.addProperty("signVerified", Boolean.FALSE);
        w.addProperty("signNote", "符号口径尚未由原版 changeCurrentItem 的实机行为校准（契约 §2.7 第 2 条的义务未完成），不得据此下方向判据");
        return w;
    }

    /**
     * {@code consumer}：当前消费链（§2.10 第 3 条、§5.2）。
     *
     * <p>
     * {@code chain} 优先取运行时快照的 {@link InputStateSnapshot#consumerChain()}（那是 T2-A 的义务）；
     * 运行时缺席时<b>不</b>编一个值，而是落 {@code null} 并在结果里标注未实现。
     */
    private static JsonObject consumerJson(TickObservation o, InputRuntime runtime) {
        JsonObject c = new JsonObject();
        InputStateSnapshot snap = safeSnapshot(runtime);
        if (snap == null) {
            c.addProperty("chain", (String) null);
            c.addProperty("chainNote", "运行时未装配 ⇒ 消费链无真值来源（本字段不猜）");
        } else {
            c.addProperty("chain", snap.consumerChain());
        }
        c.addProperty("currentScreen", o.currentScreenClass);
        if (o.currentScreenAllowUserInput == null) {
            c.addProperty("allowUserInput", (Boolean) null);
        } else {
            c.addProperty("allowUserInput", o.currentScreenAllowUserInput);
        }
        addNullable(c, "displayActive", o.displayActive);
        addNullable(c, "inGameHasFocus", o.inGameHasFocus);
        c.addProperty("captureArmed", Boolean.valueOf(isCaptureArmed()));
        return c;
    }

    /** {@code hitSet}：命中集的重建节奏（§2.4 第 5 条）。 */
    private static JsonObject hitSetJson() {
        JsonObject h = new JsonObject();
        h.addProperty("minSettleTicks", MIN_SETTLE_TICKS);
        h.addProperty("note", "GUI 命中集每帧重建（MUI2 ≥2 帧、MUI1 ≥1 tick）；位置来自 Mouse.getX/getY ⇒ move 后须等 ≥2 tick 再 down");
        return h;
    }

    /**
     * {@code queues}：队列深度与投递计数。
     *
     * <p>
     * {@code keyboardDepth} 是<b>队列含 seed 哨兵</b>的口径（lwjgl3ify {@code Keyboard.next()} 的
     * 判据是 {@code size() > 1}），故同时给出 {@code keyboardSeedBaseline}；读不到时落 {@code null}。
     * {@code mouseDepth} 恒为 {@code "unobservable"}（§11.2 第 6 条，是真值不是占位）：真值来自
     * {@link InputStateSnapshot#mouseDepth()}，本类只把
     * {@link InputStateSnapshot#DEPTH_UNOBSERVABLE} 翻译成契约的字符串形态——**不**翻译成 0。
     *
     * <p>
     * 投递计数（§5.2 的 {@code deliveredThisJob}/{@code deliveredThisSession}）与
     * {@code deliveredJobId} 一并给出：计数不给归属作业就无从判读（同一个数换个作业含义完全不同）。
     * 读不到（运行时未装配、快照抛异常、或运行时自己报 {@link InputStateSnapshot#COUNT_UNKNOWN}）时
     * 落 {@code null} + 说明，<b>不</b>写 0 冒充「本会话一条都没投递」。
     */
    private static JsonObject queuesJson(TickObservation o, InputRuntime runtime, List<String> gaps) {
        JsonObject q = new JsonObject();
        if (o.keyboardDepthReadable()) {
            q.addProperty("keyboardDepth", o.keyboardQueueDepth);
        } else {
            q.addProperty("keyboardDepth", (Integer) null);
            q.addProperty("keyboardDepthNote", "Keyboard.getNumKeyboardEvents 未取到（探针不可用）");
        }
        q.addProperty("keyboardSeedBaseline", KEYBOARD_SEED_BASELINE);
        // 容量：契约 §5.2 冻结 **256**。运行期**没有**容量探针——`Keyboard.eventQueue` 在 lwjgl3ify 里
        // 是集合，它的 `size()` 是**当前条数**（= keyboardDepth），不是容量。因此只接受「定长数组 length」
        // 作为实读容量，且容量**必然**大于 seed 基线（否则那个读数不可能是容量）。
        //
        // 【缺陷修复（实机 L-2）】原先判据是 `> 0`，于是集合 size()（实测 1 = seed 哨兵）被当成容量上报，
        // 与契约冻结的 256 冲突。现在不合理的读数一律落契约常量，并把**原始读数**如实留在
        // `keyboardCapacityRawRead` 里（既不冒充，也不隐藏）。
        if (o.keyboardQueueCapacity > KEYBOARD_SEED_BASELINE) {
            q.addProperty("keyboardCapacity", o.keyboardQueueCapacity);
            q.addProperty("keyboardCapacitySource", "运行期实读（定长数组 length）");
        } else {
            q.addProperty("keyboardCapacity", CONTRACT_KEYBOARD_CAPACITY);
            q.addProperty("keyboardCapacitySource", "契约 §5.2 的冻结常量（运行期无容量探针：Keyboard.eventQueue 是集合，size() 是当前条数而非容量）");
            if (o.keyboardQueueCapacity > 0) {
                q.addProperty("keyboardCapacityRawRead", o.keyboardQueueCapacity);
                q.addProperty("keyboardCapacityRawReadNote", "该实测值不是容量口径（疑似当前条数），按契约常量上报并在此留痕");
            }
        }
        // 鼠标队列深度：真值 = 不可观测（无公开探针）。字符串形态是契约冻结值，数字只出现在真读得到时。
        InputStateSnapshot snap = safeSnapshot(runtime);
        int mouseDepth = snap == null ? InputStateSnapshot.DEPTH_UNOBSERVABLE : snap.mouseDepth();
        if (mouseDepth == InputStateSnapshot.DEPTH_UNOBSERVABLE) {
            q.addProperty("mouseDepth", MOUSE_DEPTH_UNOBSERVABLE);
            q.addProperty(
                "mouseDepthNote",
                "Mouse 的队列深度没有公开探针 ⇒ 鼠标侧「已投递」不可独立复核（契约 §4.1/§11.2 第 6 条）；" + "本字段是「不可观测」的真值，**不是** 0");
        } else {
            q.addProperty("mouseDepth", mouseDepth);
            q.addProperty("mouseDepthSource", "InputStateSnapshot.mouseDepth()（该运行时给出了真实探针）");
        }
        addDeliveryCounts(q, snap, gaps);
        return q;
    }

    /** 投递计数：只增字段（§5.2 的 {@code deliveredThisJob}/{@code deliveredThisSession} + 归属作业）。 */
    private static void addDeliveryCounts(JsonObject q, InputStateSnapshot snap, List<String> gaps) {
        String jobId = snap == null ? null : snap.lastJobId();
        if (jobId == null) {
            q.addProperty("deliveredJobId", (String) null);
        } else {
            q.addProperty("deliveredJobId", jobId);
        }
        addCount(q, "deliveredThisJob", snap, true, gaps);
        addCount(q, "deliveredThisSession", snap, false, gaps);
        q.addProperty(
            "deliveredScope",
            "设施写进事件队列的事件数（含到期/释放路径由设施自动投递的抬起事件）；被幂等抑制（重复 down）与整条拒绝的事件不计" + "（契约 §4.1 的「已投递」定义）");
    }

    /** 落一个计数字段：无真值（无运行时 / 快照读不到 / 运行时报 {@code COUNT_UNKNOWN}）时落 {@code null} + 说明。 */
    private static void addCount(JsonObject q, String field, InputStateSnapshot snap, boolean perJob,
        List<String> gaps) {
        if (snap == null) {
            q.addProperty(field, (Long) null);
            q.addProperty(field + "Note", "运行时未装配（或快照读取失败）⇒ 投递计数无真值来源（不写 0 冒充）");
            gaps.add("queues." + field + "：运行时未装配 ⇒ 无真值（本字段落 null，不是 0）");
            return;
        }
        long v = perJob ? snap.deliveredThisJob() : snap.deliveredThisSession();
        if (v == InputStateSnapshot.COUNT_UNKNOWN) {
            q.addProperty(field, (Long) null);
            String note;
            if (!perJob) {
                note = "运行时未提供该计数（COUNT_UNKNOWN）";
            } else if (snap.lastJobId() == null) {
                note = "本会话尚无投递 ⇒ 没有可归属的作业（lastJobId 为 null）：这是「不可归属」，不是「投了 0 条」";
            } else {
                note = "运行时未提供作业 " + snap.lastJobId() + " 的计数（COUNT_UNKNOWN）";
            }
            q.addProperty(field + "Note", note);
            return;
        }
        q.addProperty(field, v);
    }

    /**
     * {@code held}：持键表回读。
     *
     * <p>
     * §3.6 第 4 条要求 {@code gameBindingPressed} <b>回读</b>该键对应 {@code KeyBinding} 的
     * {@code pressed}——本探针把「实际按键的绑定描述名 → pressed」一并读回，本方法按名匹配填字段。
     * <b>不</b>做「检测到不一致就重投」（那是明令禁止的雪崩路径）。
     *
     * <p>
     * 逐条明细（#165 起的只增字段）：{@code jobId}/{@code heldTicks}/{@code expiresInTicks} 的真值
     * 来自 {@link InputStateSnapshot#heldDetails()}（T2-A 的持键表本来是唯一的持有真值来源，
     * {@code jobId} 与 {@code expiresAtTick} 一直在表里）。快照给不出明细时（{@code null}）本类
     * <b>如实标注</b>{@code detailsReadable:false} 并把三个字段落 {@code null}——不写 0。
     */
    private static JsonObject heldJson(InputRuntime runtime, TickObservation o) {
        JsonObject h = new JsonObject();
        JsonArray items = new JsonArray();
        InputStateSnapshot snap = safeSnapshot(runtime);
        if (snap == null) {
            h.addProperty("count", 0);
            h.add("items", items);
            h.addProperty("detailsReadable", Boolean.FALSE);
            h.addProperty("note", "运行时未装配 ⇒ 无持键真值（count=0 是「未知」的诚实空态，非「已确认无持有」）");
            return h;
        }
        List<InputStateSnapshot.HeldDetail> details = snap.heldDetails();
        if (details == null) {
            // 快照给不出逐条明细（旧实现/自建实现）：仍然如实给出「谁被持有」，但 jobId/heldTicks/
            // expiresInTicks 落 **null** 并整块标注不可读——绝不用 0 冒充「刚按下、1200 tick 后到期」。
            appendFlat(snap.heldKeys(), true, items, o);
            appendFlat(snap.heldButtons(), false, items, o);
            h.addProperty("detailsReadable", Boolean.FALSE);
            h.addProperty(
                "detailsNote",
                "本快照未提供逐条持有明细（heldDetails() == null）⇒ jobId/heldTicks/expiresInTicks 不可读，落 null 而不是 0");
        } else {
            for (int i = 0; i < details.size(); i++) {
                InputStateSnapshot.HeldDetail d = details.get(i);
                if (d == null) {
                    continue;
                }
                JsonObject item = new JsonObject();
                item.addProperty("kind", d.kind());
                item.addProperty("id", d.id());
                item.addProperty("jobId", d.jobId());
                item.addProperty("heldTicks", d.heldTicks());
                item.addProperty("expiresInTicks", d.expiresInTicks());
                addBindingReadback(item, d.kind(), d.id(), o);
                items.add(item);
            }
            h.addProperty("detailsReadable", Boolean.TRUE);
        }
        h.addProperty("count", items.size());
        h.add("items", items);
        return h;
    }

    /** 明细不可得时的兜底：由扁平清单给出 {@code kind}/{@code id}，三个明细字段显式落 {@code null}。 */
    private static void appendFlat(List<?> ids, boolean keys, JsonArray items, TickObservation o) {
        for (int i = 0; ids != null && i < ids.size(); i++) {
            Object raw = ids.get(i);
            if (raw == null) {
                continue;
            }
            String id = String.valueOf(raw);
            JsonObject item = new JsonObject();
            item.addProperty(
                "kind",
                keys ? InputStateSnapshot.HeldDetail.KIND_KEY : InputStateSnapshot.HeldDetail.KIND_BUTTON);
            item.addProperty("id", id);
            item.addProperty("jobId", (String) null);
            item.addProperty("heldTicks", (Long) null);
            item.addProperty("expiresInTicks", (Long) null);
            addBindingReadback(
                item,
                keys ? InputStateSnapshot.HeldDetail.KIND_KEY : InputStateSnapshot.HeldDetail.KIND_BUTTON,
                id,
                o);
            items.add(item);
        }
    }

    /**
     * {@code gameBindingPressed}：§3.6 第 4 条要求<b>回读</b>该键对应 {@code KeyBinding} 的
     * {@code pressed}（本探针把「描述名 → pressed」一并读回，本方法按名匹配）。
     * 鼠标按钮没有绑定对应物 ⇒ {@code null} + 说明。<b>不</b>做「检测到不一致就重投」。
     */
    private static void addBindingReadback(JsonObject item, String kind, String id, TickObservation o) {
        if (InputStateSnapshot.HeldDetail.KIND_KEY.equals(kind)) {
            item.addProperty("gameBindingPressed", pressedFor(id, o));
        } else {
            item.addProperty("gameBindingPressed", (Boolean) null);
            item.addProperty("gameBindingPressedNote", "鼠标按钮没有 KeyBinding 对应物（轮询面，本族不覆盖）");
        }
    }

    /**
     * {@code physical}：物理输入并发判定（§3.6 第 3 条）。
     *
     * <p>
     * <b>键盘侧</b>：{@code Keyboard.getNumKeyboardEvents()} 是公开的队列深度探针；扣掉 seed 基线、
     * 再扣掉<b>本设施自己未及被消费的投递</b>，剩下的差值就是非本设施投递的事件数（真实物理输入）。
     * 之所以要扣后者：键盘事件在 tick N 的 END 投递、在 tick N+1 的 {@code runTick} 消费
     * （契约 §4.2 第 2 条），因此「设施刚投递完」时队列里本来就有非 seed 条目。
     * 扣不掉时（运行时未装配、无法给出自身记账）本字段落 {@code "unobservable"}——<b>不</b>编
     * {@code false} 冒充「没有冲突」（§3.6 第 3 条的禁令）。
     *
     * <p>
     * <b>鼠标侧</b>：恒 {@code "unobservable"}（无公开深度探针）。
     */
    private static JsonObject physicalJson(TickObservation o, InputRuntime runtime) {
        JsonObject p = new JsonObject();
        String concurrent;
        String reason;
        if (!o.keyboardDepthReadable()) {
            concurrent = "unobservable";
            reason = "Keyboard.getNumKeyboardEvents 未取到 ⇒ 键盘侧也无真值";
        } else if (runtime == null) {
            concurrent = "unobservable";
            reason = "运行时未装配 ⇒ 无法扣除本设施自身的未消费投递，差值不可解释";
        } else {
            int extra = o.keyboardQueueDepth - KEYBOARD_SEED_BASELINE;
            if (extra <= 0) {
                concurrent = "false";
                reason = "队列深度 == seed 基线(" + KEYBOARD_SEED_BASELINE + ") ⇒ 无任何非 seed 事件";
            } else {
                concurrent = "true";
                reason = "队列深度 " + o.keyboardQueueDepth
                    + " > seed 基线 "
                    + KEYBOARD_SEED_BASELINE
                    + " ⇒ 存在非本设施可解释的事件（真实物理输入，§3.6 第 2 条：不仲裁、不屏蔽、只如实报告）";
            }
        }
        p.addProperty("concurrent", concurrent);
        p.addProperty("keyboardProbe", "Keyboard.getNumKeyboardEvents");
        p.addProperty("keyboardSeedBaseline", KEYBOARD_SEED_BASELINE);
        p.addProperty("reason", reason);
        p.addProperty("mouseConcurrent", "unobservable");
        p.addProperty("mouseNote", "Mouse 无公开队列深度探针 ⇒ 鼠标侧只能 unobservable（契约 §3.6 第 3 条）");
        return p;
    }

    /** {@code lifecycle}：五条承诺路径 + 三条「不承诺」（§3.4 必须机读暴露）。 */
    private static JsonObject lifecycleJson() {
        JsonObject l = new JsonObject();
        JsonArray paths = new JsonArray();
        paths.add(cleanupPath("normal-completion", "promised"));
        paths.add(cleanupPath("action-exception", "promised"));
        paths.add(cleanupPath("step-timeout", "promised"));
        paths.add(cleanupPath("explicit-release", "promised"));
        paths.add(cleanupPath("process-exit", "best-effort"));
        l.add("cleanupPaths", paths);
        l.addProperty("crash", "not-promised");
        l.addProperty("worldUnload", "no-hook");
        l.addProperty("cancel", "unavailable");
        return l;
    }

    private static JsonObject cleanupPath(String id, String strength) {
        JsonObject o = new JsonObject();
        o.addProperty("id", id);
        o.addProperty("strength", strength);
        return o;
    }

    /** {@code limits}：与 {@link #HOLD_TICKS_MAX} 等处同源。 */
    private static JsonObject limitsJson() {
        JsonObject o = new JsonObject();
        o.addProperty("holdTicksMax", HOLD_TICKS_MAX);
        o.addProperty("wheelAmountMax", WHEEL_AMOUNT_MAX);
        o.addProperty("minSettleTicks", MIN_SETTLE_TICKS);
        return o;
    }

    /**
     * {@code capabilities}：<b>本次范围外</b>的契约常量（只读声明，不是运行期读数）。
     *
     * <p>
     * 单独成块是为了不让读者把「契约常量」与「实读值」混在一层：{@code limits} 是契约上限，
     * 本块是契约里冻结、但本类<b>不</b>承担其真值的性质声明。字段只增不改。
     */
    private static JsonObject capabilitiesJson() {
        JsonObject o = new JsonObject();
        o.addProperty("requiresConfirm", Boolean.FALSE);
        o.addProperty("tier", "observe");
        o.addProperty("consumerChainReadOwner", "InputRuntime.snapshot().consumerChain()");
        o.addProperty("hitSetOwner", "MUI/MUI1（本族不操作命中集）");
        o.addProperty("rollback", "none");
        o.addProperty("wheelSignCalibration", "pending-machine-check");
        o.addProperty("pollSurfaceCovered", Boolean.FALSE);
        return o;
    }

    /** {@code thread}：本快照在哪个线程取的、是否已验证（§5.1 第 3 条）。 */
    private static JsonObject threadJson(TickObservation o, Boolean tickThread) {
        JsonObject t = new JsonObject();
        t.addProperty(
            "snapshotThread",
            o.threadName == null ? Thread.currentThread()
                .getName() : o.threadName);
        t.addProperty("requiredThread", "client-tick");
        if (tickThread == null) {
            t.addProperty("verified", Boolean.FALSE);
            t.addProperty("note", "线程判定口未装配或判定失败 ⇒ 只如实报线程名，不声称「已在 tick 线程」");
        } else {
            t.addProperty("verified", Boolean.TRUE);
        }
        return t;
    }

    private static JsonArray errorsJson() {
        JsonArray arr = new JsonArray();
        for (String code : ERRORS) {
            arr.add(new com.google.gson.JsonPrimitive(code));
        }
        return arr;
    }

    /** §11.2 里**属于 T2-B 观察面**的未实现/未验证项（与契约同源，实现一项删一处）。 */
    private static List<String> frozenNotImplemented() {
        List<String> list = new ArrayList<String>();
        list.add("GUI 文本路由未打通（P0 实测：addCharEvent 与「键事件自带 codepoint」两条都未到达）");
        list.add("input.key 的 codepoint 通路未验证（只有键位那一半被实机证过）");
        list.add("read.input 读面不存在（本族唯一输入侧读面就是 input.state）");
        list.add("作业取消能力不存在；离图/断连/关服无钩子；崩溃不承诺清理");
        list.add("坐标换算的实机自校准未做（P0 只在一组 displayHeight/pixelScale 上定案了 Y 翻转）");
        list.add("轮询面不覆盖：Keyboard.isKeyDown / Mouse.isButtonDown 型判定不随队列注入变化");
        return list;
    }

    // ------------------------------------------------------------ 失败与工具

    /** §6.2 的线程失败形态（HTTP 线程误用时返回）。 */
    private JsonObject threadFailure() {
        JsonObject err = new JsonObject();
        err.addProperty("code", "CP-STATE-001");
        err.addProperty("message", "输入状态快照必须在客户端 tick 线程取得");
        JsonObject ctx = new JsonObject();
        ctx.addProperty(
            "thread",
            Thread.currentThread()
                .getName());
        ctx.addProperty("requiredThread", "client-tick");
        ctx.addProperty("hint", "HTTP 线程不得读 MC 状态（contract.md §9）");
        err.add("context", ctx);
        JsonObject o = new JsonObject();
        o.addProperty("ok", Boolean.FALSE);
        o.add("error", err);
        return o;
    }

    /** 线程判定（异常一律当「无法判定」，不把判定失败伪装成「不是 tick 线程」）。 */
    private Boolean isTickThread() {
        if (threadCheck == null) {
            return null;
        }
        try {
            return threadCheck.isTickThread();
        } catch (Throwable t) {
            return null;
        }
    }

    /** 安全取快照：运行时自己的实现可能抛（未装配/已停），此处一律当「无快照」。 */
    private static InputStateSnapshot safeSnapshot(InputRuntime runtime) {
        if (runtime == null) {
            return null;
        }
        try {
            return runtime.snapshot();
        } catch (Throwable t) {
            return null;
        }
    }

    /** {@code held[].gameBindingPressed}：按描述名回读绑定态；名字不在本次探测里时落 null（不猜）。 */
    private static Boolean pressedFor(String description, TickObservation o) {
        if (description == null) {
            return null;
        }
        return o.keyPressedByDescription.get(description);
    }

    /** 采集时刻（结果留痕用；真值来自 {@link TimeSource}）。 */
    public static String generatedAt() {
        return TimeSource.system()
            .isoNow();
    }

    private static void addNullable(JsonObject o, String key, Boolean value) {
        if (value == null) {
            o.addProperty(key, (Boolean) null);
            o.addProperty(key + "Note", "本次未取到（探针不可读），不写猜值");
        } else {
            o.addProperty(key, value);
        }
    }

    private static JsonArray strings(List<String> list) {
        JsonArray arr = new JsonArray();
        for (int i = 0; list != null && i < list.size(); i++) {
            arr.add(new com.google.gson.JsonPrimitive(list.get(i)));
        }
        return arr;
    }

    private static String orUnknown(String v) {
        return v == null || v.isEmpty() ? "unknown" : v;
    }

    /** 捕获会话是否布防（{@code captureArmed}；D-2 裁定：布防期间不拒输入，只如实报告）。 */
    private static boolean isCaptureArmed() {
        try {
            return com.lightning.mod.client.controlplane.core.CaptureSession.isArmed();
        } catch (Throwable t) {
            return false;
        }
    }
}
