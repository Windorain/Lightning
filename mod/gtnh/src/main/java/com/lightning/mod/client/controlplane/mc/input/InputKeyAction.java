package com.lightning.mod.client.controlplane.mc.input;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

import com.google.gson.JsonObject;
import com.lightning.mod.client.controlplane.core.ActionContext;
import com.lightning.mod.client.controlplane.core.ActionDescriptor;
import com.lightning.mod.client.controlplane.core.Json;
import com.lightning.mod.client.controlplane.core.Tier;
import com.lightning.mod.client.controlplane.mc.SteppingActionBase;
import com.lightning.mod.client.controlplane.mc.input.InputRuntimeImpl.AutoRelease;
import com.lightning.mod.client.controlplane.mc.input.InputRuntimeImpl.Outcome;
import com.lightning.mod.client.controlplane.mc.input.InputRuntimeImpl.ReleasedDetail;
import com.lightning.mod.client.controlplane.mc.input.api.DeliverResult;
import com.lightning.mod.client.controlplane.mc.input.api.InputEvent;

/**
 * {@code input.key}：把一个**键事件**投进游戏自己的事件队列（契约 §2.2）。
 *
 * <h2>为什么是步进动作（工厂注册）</h2>
 * {@code action:"tap"} 的 {@code holdTicks} **天然跨 tick**：按下落在 tick T，抬起落在
 * tick T+holdTicks（{@code holdTicks:1} 是同一次调用内的 down+up，§3.3 的显式边界），
 * 期间必须每个 tick 被推进一次。因此本类注册时必须走
 * {@code ActionRegistry.registerStepping(descriptor, InputKeyAction::new)}（**工厂**：一个实例只服务一个作业）。
 *
 * <h2>投递语义（逐条对应契约）</h2>
 * <ul>
 * <li>{@code down}：投递按下，进持键表，**立即完成**且刻意保留持有（否则 {@code down} 就没有意义）；
 * 释放靠显式 {@code input.release}、本作业收尾，或 1200 tick 的设施上限到期自动抬起（D-4）；</li>
 * <li>{@code up}：投递抬起；不在持键表中也照投（真实按键抬起是无害的），返回 {@code wasHeld:false}（§3.3）；</li>
 * <li>{@code tap}：投递 down + 按 {@code holdTicks} 收口；{@code down} 一个已在持键表中的键是
 * **幂等成功**（{@code alreadyHeld:true}，不重投——重投会让「按下」变成两次边沿）；</li>
 * <li>到期抬起由**运行时**统一投递（{@code autoReleased}，{@code reason:"expired"}），因此动作异常/
 * 超时也不会留下永久按下的键。</li>
 * </ul>
 *
 * <h2>轮到谁去消费（不干预）</h2>
 * 事件进的是**同一条队列**，往 GUI 链还是世界链走由游戏按 {@code currentScreen} 与
 * {@code allowUserInput} 自己决定（§2.10）；设施只如实报告 {@code consumer}。
 * <b>轮询面不受影响</b>：{@code Keyboard.isKeyDown} 读的是 SDL 物理数组，队列注入不改变它 ⇒
 * 依赖轮询的修饰键判定（Shift/Ctrl/Alt 组合、Shift 点击、NEI 快捷键、SyncedKeybind）不承诺。
 */
public final class InputKeyAction extends SteppingActionBase {

    /** 动作名。 */
    public static final String NAME = "input.key";

    /**
     * 自描述。
     *
     * <p>
     * {@code since} **故意不写**：契约 §1.4 冻结「本族动作的 since 只能写『实现合并时前进（候选 1.8）』」，
     * 在 {@code contractVersion} 同步前进之前写入具体版本号的动作不许合并。T3 注册本动作时必须
     * 显式 {@code .since("1.8")} 并与 {@code contractVersion}/动作计数同 PR 前进。
     */
    public static ActionDescriptor descriptor() {
        return ActionDescriptor.builder(NAME, Tier.SCENE)
            .description(
                "把键事件投进游戏的输入队列（不抢焦点、不动用户桌面鼠标）。key=键位描述名或 LWJGL 键码；"
                    + "action=down|up|tap；tap 的 holdTicks∈[1,1200]（1=同一次调用内 down+up，≥2=第 holdTicks 个 tick 抬起）。"
                    + "投递成功≠业务成功：事件在下一个 runTick 被消费，返回值只声称已投递。"
                    + "组合键只保证事件序：依赖 Keyboard.isKeyDown 轮询的修饰键判定不承诺（轮询面不覆盖）。"
                    + "down 产生的持键按作业归属，靠 input.release / 本作业收尾 / 1200 tick 到期自动抬起（D-4）。")
            .required("key", "string|int", "键位描述名（运行期键位注册表，如 key.forward）或 LWJGL 键码（0..255）")
            .required("action", "string", "down | up | tap（取值域外一律 CP-VALID-002）")
            .optional("holdTicks", "int", Integer.valueOf(1), "仅 action=tap 允许，1..1200；其他 action 传了即拒（不适用字段绝不静默忽略）")
            .optional("codepoint", "int", Integer.valueOf(0), "本事件自带的已提交字符码点，0..65535；0=不携带")
            .optional(SteppingActionBase.PARAM_TOTAL_TIMEOUT, "int", "覆盖总超时（毫秒）；缺省 5 分钟。步进动作框架参数")
            .optional(SteppingActionBase.PARAM_STAGE_TIMEOUT, "int", "覆盖单阶段超时（毫秒）；缺省 3 分钟")
            .returns(
                "means/semantics/layer(null)/key/keyCode/action/holdTicks/heldTicks/delivered/events/deliveredAtTick/"
                    + "queueDepthAfter/alreadyHeld/wasHeld/held{count,items[gameBindingPressed]}/autoReleased[]/released[]/"
                    + "physicalConcurrent/consumer{chain,currentScreen,allowUserInput,displayActive,inGameHasFocus}/consumed{observed:null}")
            .example("{\"confirm\":true,\"key\":\"key.forward\",\"action\":\"down\"}")
            .example("{\"confirm\":true,\"key\":\"key.forward\",\"action\":\"tap\",\"holdTicks\":20}")
            .example("{\"confirm\":true,\"key\":17,\"action\":\"up\"}")
            .build();
    }

    // ------------------------------------------------------------------ 作业级状态

    private InputRuntimeImpl rt;
    private InputSupport.KeyRef keyRef;
    private String action;
    private int holdTicks;
    private int codepoint;
    private String jobId;

    private int phase;
    private boolean keepHeld;
    private boolean alreadyHeld;
    private boolean wasHeld;
    private int deliveredTotal;
    private long deliveredAtTick = -1L;
    private int queueDepthAfter;
    private List<AutoRelease> autoReleased = new ArrayList<AutoRelease>();
    private List<ReleasedDetail> released = new ArrayList<ReleasedDetail>();
    private List<InputEvent> events = new ArrayList<InputEvent>();

    /** 解析后的键动作计划（纯数据；参数校验的**唯一**实现处，单测直接覆盖 {@link #parse}）。 */
    static final class Plan {

        final InputSupport.KeyRef key;
        final String action;
        final int holdTicks;
        final int codepoint;

        Plan(InputSupport.KeyRef key, String action, int holdTicks, int codepoint) {
            this.key = key;
            this.action = action;
            this.holdTicks = holdTicks;
            this.codepoint = codepoint;
        }
    }

    /**
     * 参数校验（纯函数：只读参数与键位目录，不碰运行时/MC 状态）。
     *
     * <p>
     * 非法参数**逐条**拒绝：类型不符（严格取整）、取值域外、不适用字段、越界——全部
     * {@code CP-VALID-002} 并带 {@code context.fields}（§2.2）。
     */
    static Plan parse(JsonObject p, InputHost host) {
        InputSupport.KeyRef keyRef = InputSupport.resolveKey(p, host);
        String action = InputSupport.requireString(p, "action");
        if (!InputCapabilities.KEY_ACTIONS.contains(action)) {
            throw InputSupport
                .param("action 取值域外: " + action, InputSupport.field("action", "取值域外", action, "string", "down|up|tap"));
        }
        if (InputSupport.has(p, "holdTicks") && !"tap".equals(action)) {
            // §2.2 第 6 条：不适用字段必须显式拒绝，不许静默忽略
            throw InputSupport.param(
                "参数不适用: holdTicks 只对 action=tap 有效",
                InputSupport.field(
                    "holdTicks",
                    "action=" + action + " 时不适用；不适用字段一律显式拒绝，不许静默忽略",
                    Json.toJson(Json.get(p, "holdTicks")),
                    Json.typeName(Json.get(p, "holdTicks")),
                    "仅在 action=tap 时出现，取值 1.." + InputCapabilities.HOLD_TICKS_MAX));
        }
        int holdTicks = 1;
        if ("tap".equals(action)) {
            holdTicks = InputSupport.optInt(p, "holdTicks", 1);
            if (holdTicks < 1 || holdTicks > InputCapabilities.HOLD_TICKS_MAX) {
                throw InputSupport.param(
                    "holdTicks 越界: " + holdTicks,
                    InputSupport.field(
                        "holdTicks",
                        "越界（持有上限 " + InputCapabilities.HOLD_TICKS_MAX + " tick，与 player.dig 的 MAX_HOLD_TICKS 同口径）",
                        String.valueOf(holdTicks),
                        "int",
                        "1.." + InputCapabilities.HOLD_TICKS_MAX));
            }
        }
        int codepoint = InputSupport.optInt(p, "codepoint", 0);
        if (codepoint < 0 || codepoint > 0xFFFF) {
            throw InputSupport.param(
                "codepoint 越界: " + codepoint,
                InputSupport.field("codepoint", "越界", String.valueOf(codepoint), "int", "0..65535"));
        }
        return new Plan(keyRef, action, holdTicks, codepoint);
    }

    @Override
    protected void onBegin(ActionContext ctx) throws Exception {
        rt = InputSupport.runtime();
        jobId = InputSupport.jobId(ctx);
        Plan plan = parse(ctx.params(), rt.host());
        keyRef = plan.key;
        action = plan.action;
        holdTicks = plan.holdTicks;
        codepoint = plan.codepoint;
        enterStage("input-key");
    }

    @Override
    protected JsonObject advance(ActionContext ctx) throws Exception {
        advanceRuntimeTick();

        if ("down".equals(action)) {
            deliverDown();
            keepHeld = true;
            return result();
        }
        if ("up".equals(action)) {
            deliverUp();
            return result();
        }

        // tap
        if (phase == 0) {
            phase = 1;
            deliverDown();
            if (holdTicks <= 1) {
                // §3.3 的显式边界：holdTicks:1 的两条事件同 tick 投递，消费序 = 投递序
                deliverUp();
                return result();
            }
            // 收窄到期时刻 ⇒ 抬起由到期机制统一投递（动作异常/超时也不会留下永久按下的键）
            rt.planExpiry(jobId, InputRuntimeImpl.HOLD_KEY, heldId(), holdTicks);
            return null;
        }
        if (!rt.isHeld(InputRuntimeImpl.HOLD_KEY, heldId())) {
            return result();
        }
        return null;
    }

    @Override
    protected void onFinish(ActionContext ctx) {
        if (rt == null) {
            return;
        }
        // 清理路径 1/2/3（正常完成/动作异常/步进超时）：只清**本作业**的持键。
        // down 刻意保留持有（keepHeld），不在这里释放——否则 down 就没有意义。
        if (!keepHeld) {
            rt.releaseJob(jobId);
            released = new ArrayList<ReleasedDetail>(rt.lastReleased());
        }
    }

    // ------------------------------------------------------------------ 结果

    /**
     * 推进一个客户端 tick，并把**到期自动抬起**如实并入本次结果。
     *
     * <p>
     * {@code tap} 的抬起是由运行时的到期机制投递的（不由本动作调用 {@code deliver}），因此必须在这里
     * 把它算进 {@code delivered}/{@code events}——否则「{@code delivered} = 请求的事件数」（§4.4 第 1 条）
     * 会少算一条，调用方会以为只投递了按下。
     */
    private void advanceRuntimeTick() {
        List<AutoRelease> due = rt.tick();
        if (due.isEmpty()) {
            return;
        }
        autoReleased.addAll(due);
        released.addAll(rt.lastReleased());
        for (AutoRelease ar : due) {
            if (phase >= 1 && InputRuntimeImpl.HOLD_KEY.equals(ar.kind) && heldId().equals(ar.id)) {
                events.add(InputEvent.key(keyRef.name, keyRef.code, false, Integer.valueOf(0)));
                deliveredTotal++;
            }
        }
    }

    private String heldId() {
        return keyRef.name != null ? keyRef.name : "code:" + keyRef.code;
    }

    private void deliverDown() {
        InputEvent e = InputEvent.key(keyRef.name, keyRef.code, true, Integer.valueOf(codepoint));
        DeliverResult r = rt.deliver(Collections.singletonList(e), jobId);
        record(r, e);
        if (r.hasRejections()) {
            throw InputSupport.fromRejections(r, NAME);
        }
    }

    private void deliverUp() {
        InputEvent e = InputEvent.key(keyRef.name, keyRef.code, false, Integer.valueOf(0));
        DeliverResult r = rt.deliver(Collections.singletonList(e), jobId);
        record(r, e);
        if (r.hasRejections()) {
            throw InputSupport.fromRejections(r, NAME);
        }
    }

    private void record(DeliverResult r, InputEvent e) {
        events.add(e);
        deliveredTotal += r.delivered;
        if (deliveredAtTick < 0L) {
            deliveredAtTick = r.deliveredAtTick;
        }
        queueDepthAfter = r.queueDepthAfter;
        for (Outcome o : rt.lastOutcomes()) {
            if (o.alreadyHeld) {
                alreadyHeld = true;
            }
            if (o.wasHeld) {
                wasHeld = true;
            }
        }
    }

    private JsonObject result() {
        InputHost host = rt.host();
        JsonObject o = InputSupport.base("key");
        o.addProperty("key", keyRef.name);
        o.addProperty("keyCode", keyRef.code);
        o.addProperty("action", action);
        if ("tap".equals(action)) {
            o.addProperty("holdTicks", holdTicks);
        }
        o.addProperty("delivered", deliveredTotal);
        o.add("events", InputSupport.eventsJson(events));
        o.addProperty("deliveredAtTick", deliveredAtTick);
        // 队列深度用**当前实读**（它已经包含到期抬起那一条）；探针不可读时退回投递时的读数
        int depthNow = rt.keyboardDepth();
        o.addProperty("queueDepthAfter", depthNow >= 0 ? depthNow : queueDepthAfter);
        o.addProperty("alreadyHeld", alreadyHeld);
        o.addProperty("wasHeld", wasHeld);
        o.add("held", rt.heldJson());
        o.add("autoReleased", InputRuntimeImpl.autoReleasedJson(autoReleased));
        o.add("released", InputRuntimeImpl.releasedJson(released));
        o.addProperty("holdTicksMax", InputCapabilities.HOLD_TICKS_MAX);
        o.add("physicalConcurrent", InputSupport.physicalJson(rt, false));
        o.add("consumer", InputSupport.consumer(host));
        o.add("consumed", InputSupport.consumed());
        return o;
    }
}
