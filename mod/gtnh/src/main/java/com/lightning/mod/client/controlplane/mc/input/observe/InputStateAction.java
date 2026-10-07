package com.lightning.mod.client.controlplane.mc.input.observe;

import net.minecraft.client.Minecraft;

import com.google.gson.JsonObject;
import com.lightning.mod.client.controlplane.core.ActionContext;
import com.lightning.mod.client.controlplane.core.ActionDescriptor;
import com.lightning.mod.client.controlplane.core.ControlAction;
import com.lightning.mod.client.controlplane.core.CpException;
import com.lightning.mod.client.controlplane.core.ErrorCodes;
import com.lightning.mod.client.controlplane.core.Json;
import com.lightning.mod.client.controlplane.core.Tier;
import com.lightning.mod.client.controlplane.mc.input.InputCapabilities;
import com.lightning.mod.client.controlplane.mc.input.InputExpiryPump;
import com.lightning.mod.client.controlplane.mc.input.InputRuntimeImpl;
import com.lightning.mod.client.controlplane.mc.input.api.InputStateProvider;

/**
 * {@code input.state}：输入手段族的**唯一能力声明口**（Gitea #162 §5 / #165 注册）。
 *
 * <h2>为什么它是 {@code observe} 级同步动作</h2>
 * 纯只读快照：无世界写、无 confirm 门、不建 run 目录。它是同步动作而非步进动作——一次调用内读完返回
 * （跨 tick 的读面会读到两个世界状态，「调用前后世界不变」就无从判定，与 {@code read.*} 同口径）。
 *
 * <h2>为什么装配体放这里（而不是 {@code mc.input} 包）</h2>
 * 依赖方向：{@code observe} 依赖 {@code input}（观察面依赖被观察者），反向依赖是层倒置。
 * 本类要碰 {@link InputStateProviderImpl} 与 {@link InputRuntimeProbe}，因此它必须住在观察面这一侧；
 * {@code mc.input} 包对本包**零依赖**。
 *
 * <h2>它不做判断，只做边界适配</h2>
 * 字段怎么组装、哪些值读不到该写成什么，全部归 {@link InputStateProviderImpl}（T2-B）。
 * 本类只负责两件事：装配生产实现、把「协议级错误」送进**真正的错误通道**（见下）。
 *
 * <h2>为什么要把 {@code {ok:false,error}} 转成异常（显式裁决，不是补丁）</h2>
 * {@link InputStateProviderImpl#state()} 在非 tick 线程上被误用时返回的是
 * {@code {ok:false, error:{code,message,context}}} 这一**协议级错误信封**（契约 §6.2 的冻结形态）。
 * 但动作的返回值会被 {@code Envelope.ok(data)} 包成 {@code {ok:true, data:<返回值>}}——
 * 若原样透传，调用方会收到 <b>HTTP 200 + {@code ok:true}</b>，而错误只藏在 {@code data} 里，
 * 等于把一次失败报成成功（本仓明令要防的「静默红」）。
 *
 * <p>
 * 因此这里把该形态**转成 {@link CpException}**，由 core 层的统一错误信封输出契约 §6.2 的
 * 那个 JSON（含正确 HTTP 状态码）。这是**边界适配**，不是掩盖：错误信息（code/message/context）
 * 逐字来自提供方，一个字段都没改写。
 *
 * <p>
 * <b>登记的遗留（不在本批改）</b>：提供方在自己的 data 侧 API 里返回协议信封这件事本身是形态错配，
 * 更干净的形态是「{@code state()} 只返回 data，线程失败直接抛」。该改动要同时改
 * {@code InputStateProviderImpl} 与其单测，故登记为后续清理项，不由本类永久兜着。
 */
public final class InputStateAction implements ControlAction {

    /** 动作名（真值在 {@code api} 面，见 {@link InputStateProvider#ACTION_NAME}）。 */
    public static final String NAME = InputStateProvider.ACTION_NAME;

    /**
     * 自描述。
     *
     * <p>
     * {@code since} = {@code 1.8}，与 {@code contractVersion} 前进和两处动作计数断言同批写入
     * （{@code input-contract.md} §1.4 的硬要求）。{@code means:"input"}：本动作是输入族的自我描述面。
     * <b>不</b>写 {@code layer}：输入手段与 L0/L1/L2 是两个维度（{@code input-contract.md} §10.1），
     * 本动作的返回体里 {@code layer} 以 {@code null} 显式表达这一点（§10.3 的裁定）。
     */
    public static ActionDescriptor descriptor() {
        return ActionDescriptor.builder(NAME, Tier.OBSERVE)
            .description(
                "输入手段族的唯一能力声明口：只读快照（observe 级、同步、不需 confirm）。" + "任何「本族能不能做 X」的问题，答案只能来自本端点字段，不得来自散文文档（§5.1 第 4 条）。"
                    + "implemented:false 时 actions 为空、keyCatalog 为空、held.count 为 0、notImplemented 非空——"
                    + "未实现必须在每一个能力字段上自洽，不许用默认值把未知伪装成「已具备但当前为 0」。"
                    + "鼠标侧队列深度无公开探针 ⇒ mouseDepth 恒为 \"unobservable\"（如实的真值，不是占位）；"
                    + "文本路由 P0 实测未打通 ⇒ text.supported=false 且 input.text 任何非空请求 CP-STATE-001。"
                    + "快照必须在客户端 tick 线程取得；非 tick 线程误用返回 CP-STATE-001（不是 ok:true 里套错误）。"
                    + "means:\"input\"，layer 为 null（输入手段与 L0/L1/L2 正交，见 input-contract.md §10）")
            .returns(
                "implemented/family/means/runtime{mc,forge,lwjgl3ify,backend,injectors[]}/actions[]/"
                    + "keyCatalog{name→keyCode}/keyCodeRange[?,?]/pollSurface/text{supported,ranges[],delivery,"
                    + "unsupportedBehavior,route{world,gui}}/coordinates{space,scaledWidth,scaledHeight,displayWidth,"
                    + "displayHeight,pixelScale,yFlip,selfCalibrated}/wheel{unit,integerOnly,sign,amountMax}/"
                    + "consumer{chain,currentScreen,allowUserInput,displayActive,inGameHasFocus,worldChainActive}/"
                    + "hitSet{minSettleTicks,note}/queues{keyboardDepth,keyboardSeedBaseline,keyboardCapacity,"
                    + "mouseDepth,deliveredThisJob,deliveredThisSession}/held{count,items[{kind,id,jobId,heldTicks,"
                    + "expiresInTicks,gameBindingPressed}]}/physical{concurrent}/lifecycle{cleanupPaths[],crash,"
                    + "worldUnload,cancel}/limits{holdTicksMax,wheelAmountMax,minSettleTicks}/capabilities{...}/"
                    + "thread{name,verified}/errors[]/notImplemented[]/warnings[]?。"
                    + "失败时抛 CP-STATE-001（非 tick 线程误用，context 含 thread/requiredThread/hint）")
            .example("{}")
            .since("1.8")
            .means(InputCapabilities.MEANS)
            .build();
    }

    /** 注入的提供方（单测用）；生产路径为 {@code null} 并按 {@link #provider()} 懒装配。 */
    private final InputStateProvider injected;

    /** 生产装配体（只在客户端 tick 线程上首次构造；探针要拿 {@code Minecraft} 实例）。 */
    private volatile InputStateProviderImpl production;

    /** 生产构造（注册表用）。 */
    public InputStateAction() {
        this.injected = null;
    }

    /** 测试构造（注入提供方，避免触碰 MC 状态）。 */
    public InputStateAction(InputStateProvider provider) {
        this.injected = provider;
    }

    @Override
    public JsonObject execute(ActionContext ctx) {
        return unwrapProtocolError(resolveProvider().state());
    }

    // ------------------------------------------------------------------ 装配

    private InputStateProvider resolveProvider() {
        if (injected != null) {
            return injected;
        }
        InputStateProviderImpl p = production;
        if (p == null) {
            synchronized (this) {
                p = production;
                if (p == null) {
                    p = buildProduction();
                    production = p;
                }
            }
        }
        return p;
    }

    /**
     * 生产装配：共享运行时 + 真实探针 + 线程判定。
     *
     * <p>
     * 刻意用 {@link InputRuntimeImpl#shared()} 而<b>不</b>用 {@code InputSupport.runtime()}：
     * 后者在注入面不可用时会抛 {@code CP-STATE-001}，而本端点恰恰是**用来报告「注入面到底可不可用」**的
     * ——它必须在注入面缺失时仍然能给出答案（如实报 {@code runtime.injectors[].available:false}），
     * 否则能力发现面在最需要它的时候消失。
     */
    private static InputStateProviderImpl buildProduction() {
        InputRuntimeImpl rt = InputRuntimeImpl.shared();
        InputRuntimeProbe probe = new InputRuntimeProbe(Minecraft.getMinecraft());
        return new InputStateProviderImpl(rt, probe, new OwnerThreadCheck());
    }

    /**
     * 线程判定：两条证据按优先级取用，都没有时如实回 {@code null}（= **无法判定**）。
     *
     * <ol>
     * <li><b>运行时的 owner 线程</b>（权威）：{@link InputRuntimeImpl#onOwnerThread()} 在未绑定时返回
     * {@code true}（它的语义是「没有别的线程占着」），直接拿来当「确实在 tick 线程上」会把「未验证」
     * 冒充成「已验证为真」，故先看 {@code ownerThreadName() == null} 决定这条路是否可用；
     * 绑定发生在步进输入动作的 {@code rt.tick()}。</li>
     * <li><b>结算泵捕获的 tick 线程</b>（补充证据）：泵只由 {@code ControlPlaneTickHandler} 的
     * {@code ClientTickEvent} 调用，因此它首次调用时的线程**按构造**就是 tick 线程。
     * 实机 L-4 暴露过缺口：没有任何输入动作跑过时 owner 线程还没绑定，只看第 1 条会让
     * {@code input.state} 明明在 {@code Client thread} 上却报 {@code thread.verified:false}。</li>
     * </ol>
     *
     * <p>
     * 两条都没有（泵从未被调用、运行时从未绑定）⇒ 回 {@code null}，让组装侧把
     * {@code thread.verified=false} 与「未判定」的理由如实写进结果——**不**猜。
     */
    static final class OwnerThreadCheck implements InputStateProviderImpl.TickThreadCheck {

        @Override
        public Boolean isTickThread() {
            InputRuntimeImpl rt = InputRuntimeImpl.shared();
            if (rt != null && rt.ownerThreadName() != null) {
                return Boolean.valueOf(rt.onOwnerThread());
            }
            return InputExpiryPump.sameThread(InputExpiryPump.capturedTickThread(), Thread.currentThread());
        }
    }

    // ------------------------------------------------------------------ 边界适配

    /**
     * 把提供方可能返回的**协议级错误信封**转成 {@link CpException}（见类注释）。
     *
     * <p>
     * 识别条件刻意收紧到「{@code ok} 是布尔假 <b>且</b> 有 {@code error} 对象」——
     * 正常 data 里不会出现这个组合，因此不会把合法的快照误判成错误。
     */
    static JsonObject unwrapProtocolError(JsonObject out) {
        if (out == null) {
            throw new CpException(ErrorCodes.STATE, "input.state 未产生响应体（实现缺陷：提供方返回 null）");
        }
        if (!isFailedEnvelope(out)) {
            return out;
        }
        JsonObject err = out.getAsJsonObject("error");
        String code = Json.optString(err, "code", ErrorCodes.STATE);
        String message = Json.optString(err, "message", "输入状态快照失败");
        JsonObject context = Json.optObject(err, "context");
        throw new CpException(code, message, context);
    }

    private static boolean isFailedEnvelope(JsonObject out) {
        if (!out.has("ok") || !out.has("error")) {
            return false;
        }
        if (!out.get("ok")
            .isJsonPrimitive()) {
            return false;
        }
        if (out.get("ok")
            .getAsBoolean()) {
            return false;
        }
        return out.get("error")
            .isJsonObject();
    }
}
