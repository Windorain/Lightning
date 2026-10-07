package com.lightning.mod.client.controlplane.mc.input;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonNull;
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
 * {@code input.mouse}：鼠标移动/定位、世界视角增量、按钮按下抬起、点击与滚轮（契约 §2.3–§2.7）。
 *
 * <h2>逐 op 的适用面是**硬**判据</h2>
 * 每个 op 有自己的必填/禁用表（契约 §2.3）；传了禁用参数即 {@code CP-VALID-002} 并逐字段给出理由——
 * 「不适用字段静默忽略」是本仓已定的失效模式，不能靠默认值兜。
 *
 * <h2>为什么是步进动作</h2>
 * <ul>
 * <li>{@code move} 的**成功定义**是回读等于请求值（±1，§2.4 第 4 条）。注入点在 tick END ⇒
 * 事件只能在**下一个 runTick** 被消费，因此读回必须等一个 tick：本动作 tick T 投递、tick T+1 回读；</li>
 * <li>{@code click} 的 {@code holdTicks} ≥ 2 要跨 tick（{@code holdTicks:1} 是同一次调用内 down+up）；</li>
 * <li>{@code down} 产生的按钮持有靠 {@code input.release} / 本作业收尾 / 1200 tick 到期自动抬起。</li>
 * </ul>
 *
 * <h2>两个必须写在自述里的既成事实</h2>
 * <ol>
 * <li><b>不先 {@code move} 就点，点到的是上一次的位置</b>：注入点击的坐标来源是
 * {@code Mouse.getEventX/getEventY}，而这两个值由 {@code addMoveEvent} 维护；</li>
 * <li><b>位置与按下必须跨帧</b>：GUI 命中集每帧重建（MUI2 ≥2 帧、MUI1 ≥1 tick），
 * {@code move} 后须等 ≥{@value InputCapabilities#MIN_SETTLE_TICKS} tick 再 {@code down}
 * （{@code input.state.hitSet.minSettleTicks}）；{@code click} **不做隐式 move**。</li>
 * </ol>
 *
 * <h2>相对位移的消费门（不承诺生效）</h2>
 * {@code relative} 走世界链，其消费门是 {@code mc.inGameHasFocus && Display.isActive()} ⇒
 * **失焦时不承诺生效**，而无人值守的常态正是失焦。返回值如实给出 {@code consumer.displayActive}；
 * 需要「确定性转视角」请用既有的 {@code player.look}，**不得**靠本 op，也**禁止**去改
 * {@code displayFocused} 绕过（§2.3 第 2 条 / §8.4 第 3 条）。
 */
public final class InputMouseAction extends SteppingActionBase {

    /** 动作名。 */
    public static final String NAME = "input.mouse";

    /** {@code since}/{@code means} 口径同 {@link InputKeyAction#descriptor()}（本批 #165 写入 1.8）。 */
    public static ActionDescriptor descriptor() {
        return ActionDescriptor.builder(NAME, Tier.SCENE)
            .description(
                "把鼠标事件投进游戏的输入队列（不抓取光标、不搬动用户桌面鼠标）。op=move|x|relative|down|up|click|wheel；"
                    + "move 收 GUI 缩放坐标（与 GuiScreen.mouseClicked 同口径），由设施换算成投递口径并回读自校准；"
                    + "click 不做隐式 move：不先 move 就点，点到的是上一次的位置；move 后须等 ≥2 tick 再 down（命中集每帧重建）。"
                    + "relative 的消费门是 inGameHasFocus && Display.isActive() ⇒ 失焦时不承诺生效（无人值守常态）。"
                    + "滚轮只收非零整数档（|amount|≤8），方向口径=原版 getEventDWheel（正档=向后）。"
                    + "投递成功≠业务成功：事件在下一个 runTick 被消费。")
            .required("op", "string", "move | relative | down | up | click | wheel")
            .optional("x", "number", "仅 op=move：目标 GUI 缩放 X（原点左上；不接受 framebuffer/窗口坐标）")
            .optional("y", "number", "仅 op=move：目标 GUI 缩放 Y")
            .optional("dx", "number", "仅 op=relative：世界视角增量 X")
            .optional("dy", "number", "仅 op=relative：世界视角增量 Y")
            .optional("button", "int", "down/up/click：LWJGL 编号 0/1/2 = 左/右/中")
            .optional("amount", "int", "仅 op=wheel：非零整数档，|amount|≤" + InputCapabilities.WHEEL_AMOUNT_MAX)
            .optional(
                "holdTicks",
                "int",
                Integer.valueOf(1),
                "仅 op=click：1..1200；1=同一次调用内 down+up，≥2=第 holdTicks 个 tick 抬起")
            .optional(SteppingActionBase.PARAM_TOTAL_TIMEOUT, "int", "覆盖总超时（毫秒）；缺省 5 分钟。步进动作框架参数")
            .optional(SteppingActionBase.PARAM_STAGE_TIMEOUT, "int", "覆盖单阶段超时（毫秒）；缺省 3 分钟")
            .returns(
                "means/semantics/layer(null)/op/requested{space,x,y|dx,dy}/delivered(int，全族同一类型)/"
                    + "deliveredGeometry{space,x,y,pixelScale,...}(仅 move)/events/deliveredAtTick/queueDepthAfter/"
                    + "readback{mouseX,mouseY,guiX,guiY,withinTolerance}"
                    + "(仅 move)/hitSet{state,minSettleTicks}/held{...}/autoReleased[]/released[]/physicalConcurrent"
                    + "(鼠标侧恒 unobservable)/consumer{...}/consumed{observed:null}")
            .example("{\"confirm\":true,\"op\":\"move\",\"x\":426,\"y\":321}")
            .example("{\"confirm\":true,\"op\":\"wheel\",\"amount\":-1}")
            .example("{\"confirm\":true,\"op\":\"click\",\"button\":0,\"holdTicks\":2}")
            .since("1.8")
            .means(InputCapabilities.MEANS)
            .build();
    }

    private InputRuntimeImpl rt;
    private String op;
    private String jobId;

    private double x;
    private double y;
    private double dx;
    private double dy;
    private int button;
    private int amount;
    private int holdTicks;

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
    private JsonObject readback;

    /** 按钮持有点的标识（与运行时的持键表 id 同源：按钮号字符串）。 */
    private String buttonId() {
        return String.valueOf(button);
    }

    /** 解析后的鼠标动作计划（纯数据；参数校验的唯一实现处，单测直接覆盖 {@link #parse}）。 */
    static final class Plan {

        final String op;
        final double x;
        final double y;
        final double dx;
        final double dy;
        final int button;
        final int amount;
        final int holdTicks;

        Plan(String op, double x, double y, double dx, double dy, int button, int amount, int holdTicks) {
            this.op = op;
            this.x = x;
            this.y = y;
            this.dx = dx;
            this.dy = dy;
            this.button = button;
            this.amount = amount;
            this.holdTicks = holdTicks;
        }
    }

    /**
     * 参数校验（纯函数，可单测）：逐 op 的必填/禁用表 + 取值域 + 严格整数，非法即 {@code CP-VALID-002}。
     */
    static Plan parse(JsonObject p) {
        String op = InputSupport.requireString(p, "op");
        double x = 0.0D;
        double y = 0.0D;
        double dx = 0.0D;
        double dy = 0.0D;
        int button = 0;
        int amount = 0;
        int holdTicks = 1;
        if (!InputCapabilities.MOUSE_OPS.contains(op)) {
            throw InputSupport.param(
                "op 取值域外: " + op,
                InputSupport.field("op", "取值域外", op, "string", "move|relative|down|up|click|wheel"));
        }
        checkApplicability(op, p);

        if ("move".equals(op)) {
            x = InputSupport.requireNumber(p, "x");
            y = InputSupport.requireNumber(p, "y");
        } else if ("relative".equals(op)) {
            dx = InputSupport.requireNumber(p, "dx");
            dy = InputSupport.requireNumber(p, "dy");
        } else if ("wheel".equals(op)) {
            amount = InputSupport.requireInt(p, "amount");
            if (amount == 0) {
                throw InputSupport.param(
                    "amount=0 是零档，无意义",
                    InputSupport.field(
                        "amount",
                        "零档不许当 no-op 绿（契约 §2.7 第 1 条）",
                        "0",
                        "int",
                        "非零整数，|amount| ≤ " + InputCapabilities.WHEEL_AMOUNT_MAX));
            }
            if (Math.abs(amount) > InputCapabilities.WHEEL_AMOUNT_MAX) {
                throw InputSupport.param(
                    "amount 越界: " + amount,
                    InputSupport.field(
                        "amount",
                        "越界（防一次请求灌爆界面滚动）",
                        String.valueOf(amount),
                        "int",
                        "|amount| ≤ " + InputCapabilities.WHEEL_AMOUNT_MAX));
            }
        } else {
            button = InputSupport.requireInt(p, "button");
            if (button < 0 || button > 2) {
                throw InputSupport.param(
                    "button 取值域外: " + button,
                    InputSupport.field(
                        "button",
                        "LWJGL 按钮编号只有 0/1/2（左/右/中）；不是 SDL 的 1/2/3",
                        String.valueOf(button),
                        "int",
                        "0|1|2"));
            }
            if ("click".equals(op)) {
                holdTicks = InputSupport.optInt(p, "holdTicks", 1);
                if (holdTicks < 1 || holdTicks > InputCapabilities.HOLD_TICKS_MAX) {
                    throw InputSupport.param(
                        "holdTicks 越界: " + holdTicks,
                        InputSupport.field(
                            "holdTicks",
                            "越界（持有上限 " + InputCapabilities.HOLD_TICKS_MAX + " tick）",
                            String.valueOf(holdTicks),
                            "int",
                            "1.." + InputCapabilities.HOLD_TICKS_MAX));
                }
            }
        }
        return new Plan(op, x, y, dx, dy, button, amount, holdTicks);
    }

    @Override
    protected void onBegin(ActionContext ctx) throws Exception {
        rt = InputSupport.runtime();
        jobId = InputSupport.jobId(ctx);
        Plan plan = parse(ctx.params());
        op = plan.op;
        x = plan.x;
        y = plan.y;
        dx = plan.dx;
        dy = plan.dy;
        button = plan.button;
        amount = plan.amount;
        holdTicks = plan.holdTicks;
        enterStage("input-mouse");
    }

    /** 逐 op 的必填/禁用表（§2.3）。禁用参数传了即拒，逐字段说明。 */
    private static void checkApplicability(String op, JsonObject p) {
        JsonArray fields = new JsonArray();
        if ("move".equals(op)) {
            required(fields, p, "x");
            required(fields, p, "y");
            forbidden(fields, p, "dx");
            forbidden(fields, p, "dy");
            forbidden(fields, p, "button");
            forbidden(fields, p, "amount");
            forbidden(fields, p, "holdTicks");
        } else if ("relative".equals(op)) {
            required(fields, p, "dx");
            required(fields, p, "dy");
            forbidden(fields, p, "x");
            forbidden(fields, p, "y");
            forbidden(fields, p, "button");
            forbidden(fields, p, "amount");
            forbidden(fields, p, "holdTicks");
        } else if ("down".equals(op) || "up".equals(op)) {
            required(fields, p, "button");
            forbidden(fields, p, "x");
            forbidden(fields, p, "y");
            forbidden(fields, p, "dx");
            forbidden(fields, p, "dy");
            forbidden(fields, p, "amount");
            forbidden(fields, p, "holdTicks");
        } else if ("click".equals(op)) {
            required(fields, p, "button");
            forbidden(fields, p, "x");
            forbidden(fields, p, "y");
            forbidden(fields, p, "dx");
            forbidden(fields, p, "dy");
            forbidden(fields, p, "amount");
        } else if ("wheel".equals(op)) {
            required(fields, p, "amount");
            forbidden(fields, p, "x");
            forbidden(fields, p, "y");
            forbidden(fields, p, "dx");
            forbidden(fields, p, "dy");
            forbidden(fields, p, "button");
            forbidden(fields, p, "holdTicks");
        }
        if (fields.size() > 0) {
            JsonObject first = fields.get(0)
                .getAsJsonObject();
            String name = first.get("field")
                .getAsString();
            boolean missing = "必填".equals(
                first.get("reason")
                    .getAsString());
            throw InputSupport.paramArray((missing ? "参数缺失: " : "参数不适用: ") + name + "（op=" + op + "）", fields);
        }
    }

    private static void required(JsonArray fields, JsonObject p, String name) {
        if (!InputSupport.has(p, name)) {
            fields.add(InputSupport.field(name, "必填", null, "missing", "op 的必填参数，见契约 §2.3 的逐 op 表"));
        }
    }

    private static void forbidden(JsonArray fields, JsonObject p, String name) {
        if (InputSupport.has(p, name)) {
            JsonElement e = Json.get(p, name);
            fields.add(
                InputSupport.field(
                    name,
                    "op 的禁用参数（传了即拒；不适用字段静默忽略是本仓已定的失效模式，契约 §2.3）",
                    e == null ? null : e.toString(),
                    Json.typeName(e),
                    "该字段不出现在本 op 的请求里"));
        }
    }

    @Override
    protected JsonObject advance(ActionContext ctx) throws Exception {
        advanceRuntimeTick();

        if ("move".equals(op)) {
            if (phase == 0) {
                phase = 1;
                deliver(InputEvent.move(x, y));
                return null;
            }
            // 下一个 runTick 已消费该事件 ⇒ 此刻的回读才是**投递结果**，不是旧位置
            readback = readback(x, y);
            return result();
        }
        if ("relative".equals(op)) {
            InputEvent e = new InputEvent();
            e.kind = InputEvent.KIND_MOVE;
            e.dx = Double.valueOf(dx);
            e.dy = Double.valueOf(dy);
            deliver(e);
            return result();
        }
        if ("wheel".equals(op)) {
            deliver(InputEvent.wheel(amount));
            return result();
        }
        if ("down".equals(op)) {
            deliver(InputEvent.button(button, true));
            keepHeld = true;
            return result();
        }
        if ("up".equals(op)) {
            deliver(InputEvent.button(button, false));
            return result();
        }
        // click
        if (phase == 0) {
            phase = 1;
            deliver(InputEvent.button(button, true));
            if (holdTicks <= 1) {
                deliver(InputEvent.button(button, false));
                return result();
            }
            rt.planExpiry(jobId, InputRuntimeImpl.HOLD_BUTTON, buttonId(), holdTicks);
            return null;
        }
        if (!rt.isHeld(InputRuntimeImpl.HOLD_BUTTON, buttonId())) {
            return result();
        }
        return null;
    }

    @Override
    protected void onFinish(ActionContext ctx) {
        if (rt == null) {
            return;
        }
        // 清理路径 1/2/3：只清本作业持键；down 刻意保留持有（keepHeld）
        if (!keepHeld) {
            rt.releaseJob(jobId);
            released = new ArrayList<ReleasedDetail>(rt.lastReleased());
        }
    }

    // ------------------------------------------------------------------ 投递与结果

    /**
     * 推进一个客户端 tick，并把**到期自动抬起**如实并入本次结果。
     *
     * <p>
     * {@code click} 的抬起由运行时的到期机制投递（不由本动作调用 {@code deliver}），必须在这里计入
     * {@code delivered}/{@code events}——否则 {@code delivered} 会少算一条（§4.4 第 1 条）。
     */
    private void advanceRuntimeTick() {
        List<AutoRelease> due = rt.tick();
        if (due.isEmpty()) {
            return;
        }
        autoReleased.addAll(due);
        released.addAll(rt.lastReleased());
        for (AutoRelease ar : due) {
            if (phase >= 1 && InputRuntimeImpl.HOLD_BUTTON.equals(ar.kind) && buttonId().equals(ar.id)) {
                events.add(InputEvent.button(button, false));
                deliveredTotal++;
            }
        }
    }

    private void deliver(InputEvent e) {
        DeliverResult r = rt.deliver(Collections.singletonList(e), jobId);
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
        if (r.hasRejections()) {
            throw InputSupport.fromRejections(r, NAME);
        }
    }

    /**
     * 回读自校准（§2.4 第 3/4 条）：把 {@code Mouse.getX/getY} 实读值经换算逆推回 GUI 口径，
     * 与请求值比较（容许 ±1 的整数量化）。**这是 {@code move} 唯一的成功判据**——
     * 「GUI 控件被命中」是另一个边界，不算 {@code move} 的成功。
     */
    private JsonObject readback(double reqX, double reqY) {
        InputCoordinates c = rt.coordinates();
        JsonObject o = new JsonObject();
        o.addProperty("space", "gui-scaled-observed");
        o.addProperty("requestedX", reqX);
        o.addProperty("requestedY", reqY);
        o.addProperty("tolerancePx", 1);
        if (!rt.host()
            .mouseReadable()) {
            o.add("mouseX", JsonNull.INSTANCE);
            o.add("mouseY", JsonNull.INSTANCE);
            o.add("guiX", JsonNull.INSTANCE);
            o.add("guiY", JsonNull.INSTANCE);
            o.addProperty("withinTolerance", Boolean.FALSE);
            o.addProperty("note", "Mouse.getX/getY 不可读：本动作不做自校准声明（不假装成功）");
            rt.recordCalibration(false);
            return o;
        }
        int rawX = rt.host()
            .mouseX();
        int rawY = rt.host()
            .mouseY();
        double guiX = c.guiXFromMouse(rawX);
        double guiY = c.guiYFromMouse(rawY);
        boolean ok = InputCoordinates.withinOnePixel(guiX, reqX) && InputCoordinates.withinOnePixel(guiY, reqY);
        o.addProperty("mouseX", rawX);
        o.addProperty("mouseY", rawY);
        o.addProperty("guiX", guiX);
        o.addProperty("guiY", guiY);
        o.addProperty("withinTolerance", ok);
        o.addProperty("pixelScaleApplied", c.pixelScale() != 1.0D);
        rt.recordCalibration(ok);
        return o;
    }

    private JsonObject result() {
        InputHost host = rt.host();
        JsonObject o = InputSupport.base("mouse");
        o.addProperty("op", op);
        if ("move".equals(op)) {
            InputCoordinates c = rt.coordinates();
            o.add("requested", InputCoordinates.requestedJson(x, y));
            // Lead 裁决（#163 裁决登记 E-3）：`delivered` **全族恒为整数计数**（§4.1 第 1 条是它的定义处）。
            // §6.2 的 move 示例把 delivered 写成坐标对象，属契约自身的不一致，已作为勘误修正：
            // 坐标回显改放 `deliveredGeometry`，机器消费者只需按一种类型解析 delivered。
            o.addProperty("delivered", deliveredTotal);
            o.add("deliveredGeometry", c.deliveredJson(x, y));
            o.add("readback", readback == null ? new JsonObject() : readback);
            JsonObject hit = new JsonObject();
            hit.addProperty("state", "stale");
            hit.addProperty("minSettleTicks", InputCapabilities.MIN_SETTLE_TICKS);
            hit.addProperty(
                "note",
                "本动作只保证坐标已投递；GUI 命中集每帧重建（MUI2 ≥2 帧、MUI1 ≥1 tick），≥" + InputCapabilities.MIN_SETTLE_TICKS
                    + " tick 后才可能命中");
            o.add("hitSet", hit);
            o.addProperty("selfCalibrated", rt.selfCalibrated());
        } else if ("relative".equals(op)) {
            JsonObject req = new JsonObject();
            req.addProperty("space", "world-look-delta");
            req.addProperty("dx", dx);
            req.addProperty("dy", dy);
            o.add("requested", req);
            o.addProperty("delivered", deliveredTotal);
            o.addProperty(
                "focusGate",
                "消费门 = mc.inGameHasFocus && Display.isActive() ⇒ 失焦时不承诺生效；本族不重路由、不改 displayFocused（§2.3 第 2 条）");
        } else {
            o.addProperty("delivered", deliveredTotal);
            if ("wheel".equals(op)) {
                o.addProperty("amount", amount);
                o.addProperty("sign", InputCapabilities.WHEEL_SIGN);
            } else {
                o.addProperty("button", button);
            }
            if ("click".equals(op)) {
                o.addProperty("holdTicks", holdTicks);
            }
        }
        o.add("events", InputSupport.eventsJson(events));
        o.addProperty("deliveredAtTick", deliveredAtTick);
        // 鼠标侧无公开深度探针 ⇒ 这里给的是**设施记账**，且必须标注不可独立复核（§4.1 / §3.6 第 3 条）
        int accounting = rt.mouseAccounting();
        o.addProperty("queueDepthAfter", accounting > 0 ? accounting : queueDepthAfter);
        o.addProperty("queueDepthAfterNote", "鼠标侧无公开队列深度探针：queueDepthAfter 是设施记账，不可独立复核（键盘侧才是实读）");
        o.addProperty("alreadyHeld", alreadyHeld);
        o.addProperty("wasHeld", wasHeld);
        o.add("held", rt.heldJson());
        o.add("autoReleased", InputRuntimeImpl.autoReleasedJson(autoReleased));
        o.add("released", InputRuntimeImpl.releasedJson(released));
        o.add("physicalConcurrent", InputSupport.physicalJson(rt, true));
        o.add(
            "coordinates",
            rt.coordinates()
                .toJson(rt.selfCalibrated()));
        o.add("consumer", InputSupport.consumer(host));
        o.add("consumed", InputSupport.consumed());
        return o;
    }
}
