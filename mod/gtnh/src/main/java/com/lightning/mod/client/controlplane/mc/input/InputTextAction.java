package com.lightning.mod.client.controlplane.mc.input;

import java.util.ArrayList;
import java.util.List;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.lightning.mod.client.controlplane.core.ActionContext;
import com.lightning.mod.client.controlplane.core.ActionDescriptor;
import com.lightning.mod.client.controlplane.core.ControlAction;
import com.lightning.mod.client.controlplane.core.CpException;
import com.lightning.mod.client.controlplane.core.ErrorCodes;
import com.lightning.mod.client.controlplane.core.Tier;
import com.lightning.mod.client.controlplane.mc.input.api.DeliverResult;
import com.lightning.mod.client.controlplane.mc.input.api.InputEvent;

/**
 * {@code input.text}：逐字符投递普通文本（契约 §2.9）。
 *
 * <h2>本单的真相：能力未就绪 ⇒ 任何非空请求一律 {@code CP-STATE-001}</h2>
 * P0 实机实测：{@code GuiChat.fieldText} 可读且为空，{@code addCharEvent} 与「键事件自带 codepoint」
 * 两条路都没到达任何一条消费链。因此 {@code input.state.text} 声明
 * {@code supported:false}、{@code ranges:[]}、{@code route:{world:false,gui:false}}，而本动作在
 * 路由未就绪时**必须显式失败**，<b>不得</b>返回 {@code delivered:N} 的绿（§2.9 第 6 条 +
 * 「恒绿假成功」是本仓明确要防的失效模式）。
 *
 * <h2>范围校验仍是冻结行为（只是当前到不了）</h2>
 * 一旦路由就绪，行为是：请求中出现声明范围外的字符 ⇒ **整条** {@code CP-VALID-002}，
 * {@code context.fields} **逐字符**给出 {@code {index,char,codepoint,reason}}；
 * <b>禁止</b>静默丢弃该字符后继续投递其余字符，也禁止替换成 {@code ?}/空格/占位符（§2.9 第 3 条）。
 * 本类把这段判定写成纯函数 {@link #outOfRange(String)}，单测直接覆盖（不必等路由打通）。
 *
 * <h2>文本不直接改控件值</h2>
 * 【禁令】不得走「直接 {@code setText} / 直接写文本框字段 / 直接调控件回调」这条捷径（§8.2）：
 * 它绕过 {@code keyTyped}/{@code handleKeyboardInput} 与控件自己的 filter/光标逻辑，
 * 让「输入手段」与「API 直设」的结论不可区分。
 */
public final class InputTextAction implements ControlAction {

    /** 动作名。 */
    public static final String NAME = "input.text";

    /** {@code since} 说明同 {@link InputKeyAction#descriptor()}（契约 §1.4：T3 注册时写 1.8）。 */
    public static ActionDescriptor descriptor() {
        return ActionDescriptor.builder(NAME, Tier.SCENE)
            .description(
                "逐字符投递普通文本（UTF-16 码元，每字符一条事件，顺序即字符串顺序）。"
                    + "能力未就绪时（route.world==false && route.gui==false，本单即此形态）任何非空请求一律 CP-STATE-001，"
                    + "绝不返回 delivered:N 的假绿。范围外字符⇒整条 CP-VALID-002 并逐字符说明；不静默丢弃、不替换字符。"
                    + "空串⇒CP-VALID-002。绝不直接改控件值（不 setText、不写文本框字段）。"
                    + "投递成功≠业务成功：字符是否被控件接收必须由独立读面判定。")
            .required("text", "string", "要投递的文本；逐字符投递，空串被拒")
            .returns(
                "means/semantics/layer(null)/text/delivered/events[{kind:char,char,codepoint}]/deliveredAtTick/"
                    + "consumer{...}/consumed{observed:null}；能力未就绪时无成功形态（CP-STATE-001）")
            .example("{\"confirm\":true,\"text\":\"hi\"}")
            .build();
    }

    @Override
    public JsonObject execute(ActionContext ctx) {
        JsonObject p = ctx.params();
        String text = InputSupport.requireString(p, "text");
        if (text.isEmpty()) {
            throw InputSupport.param(
                "text 为空串",
                InputSupport.field("text", "空请求是无效的，不许静默成功（恒绿假成功是明确要防的失效模式，契约 §2.9 第 4 条）", "", "string", "至少一个字符"));
        }

        InputRuntimeImpl rt = InputSupport.runtime();

        // 1) 能力门（§2.9 第 6 条）：路由两路皆未打通 ⇒ 显式失败，不得假装成功
        if (!textRouteReady()) {
            JsonObject textState = new JsonObject();
            textState.addProperty("supported", InputCapabilities.TEXT_SUPPORTED);
            textState.add("ranges", InputCapabilities.textRangesJson());
            JsonObject routes = new JsonObject();
            routes.addProperty("world", InputCapabilities.TEXT_ROUTE_WORLD);
            routes.addProperty("gui", InputCapabilities.TEXT_ROUTE_GUI);
            textState.add("routes", routes);
            JsonObject c = new JsonObject();
            c.add("text", textState);
            c.addProperty("delivery", InputCapabilities.TEXT_DELIVERY);
            c.addProperty("unsupportedBehavior", InputCapabilities.TEXT_UNSUPPORTED_BEHAVIOR);
            c.addProperty(
                "hint",
                "P0 实测：GuiChat.fieldText 可读且为空；addCharEvent 与「键事件自带 codepoint」两条都未到达 ⇒ "
                    + "声明为空（契约 §11.2 第 4/5 条）。本请求未投递任何字符。");
            throw new CpException(ErrorCodes.STATE, "文本投递路由未就绪（world/gui 两路均未打通）", c);
        }

        // 2) 字符范围（逐字符判定；范围表为空时任何字符都算范围外）
        JsonArray bad = outOfRange(text);
        if (bad.size() > 0) {
            JsonObject c = new JsonObject();
            c.addProperty("delivered", Integer.valueOf(0));
            c.add("fields", bad);
            c.add("ranges", InputCapabilities.textRangesJson());
            c.addProperty("unsupportedBehavior", InputCapabilities.TEXT_UNSUPPORTED_BEHAVIOR);
            c.addProperty("hint", "本族不静默丢弃、不替换字符（契约 §2.9 第 3 条）");
            throw new CpException(ErrorCodes.VALID_PARAM, "文本包含不受支持的字符（已整条拒绝，未投递任何字符）", c);
        }

        // 3) 逐字符投递
        List<InputEvent> events = new ArrayList<InputEvent>();
        JsonArray echo = new JsonArray();
        for (int i = 0; i < text.length(); i++) {
            char ch = text.charAt(i);
            InputEvent e = new InputEvent();
            e.kind = InputEvent.KIND_CHAR;
            e.codepoint = Integer.valueOf(ch);
            events.add(e);
            JsonObject o = new JsonObject();
            o.addProperty("kind", InputEvent.KIND_CHAR);
            o.addProperty("char", String.valueOf(ch));
            o.addProperty("codepoint", (int) ch);
            echo.add(o);
        }
        DeliverResult r = rt.deliver(events, InputSupport.jobId(ctx));
        if (r.hasRejections()) {
            throw InputSupport.fromRejections(r, NAME);
        }
        JsonObject o = InputSupport.base("text");
        o.addProperty("text", text);
        o.addProperty("delivered", r.delivered);
        o.add("events", echo);
        o.addProperty("deliveredAtTick", r.deliveredAtTick);
        o.addProperty("queueDepthAfter", r.queueDepthAfter);
        o.add("consumer", InputSupport.consumer(rt.host()));
        o.add("consumed", InputSupport.consumed());
        return o;
    }

    /**
     * 文本路由是否就绪（**当前恒 false**）。
     *
     * <p>
     * 写成方法而不是常量表达式，是为了让「未就绪」这条当前真值显式落在运行期判定上——
     * 它同时是 {@code input.state.text.route} 的真值源。
     */
    static boolean textRouteReady() {
        return InputCapabilities.TEXT_SUPPORTED
            && (InputCapabilities.TEXT_ROUTE_WORLD || InputCapabilities.TEXT_ROUTE_GUI);
    }

    /**
     * 逐字符范围检查（纯函数，可单测）。
     *
     * @return 范围外字符的逐条说明（空数组 = 全部在声明范围内）
     */
    static JsonArray outOfRange(String text) {
        JsonArray bad = new JsonArray();
        if (text == null) {
            return bad;
        }
        for (int i = 0; i < text.length(); i++) {
            char ch = text.charAt(i);
            int cp = ch;
            if (!InputCapabilities.inDeclaredTextRange(cp)) {
                JsonObject f = new JsonObject();
                f.addProperty("index", Integer.valueOf(i));
                f.addProperty("char", String.valueOf(ch));
                f.addProperty("codepoint", Integer.valueOf(cp));
                f.addProperty("reason", InputCapabilities.TEXT_RANGES.isEmpty() ? "声明范围为空（本运行期未验证任何字符段可达）" : "不在声明范围内");
                bad.add(f);
            }
        }
        return bad;
    }
}
