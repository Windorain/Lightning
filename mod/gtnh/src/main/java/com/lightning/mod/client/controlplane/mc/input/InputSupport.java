package com.lightning.mod.client.controlplane.mc.input;

import java.util.List;
import java.util.Map;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonNull;
import com.google.gson.JsonObject;
import com.google.gson.JsonPrimitive;
import com.lightning.mod.client.controlplane.core.ActionContext;
import com.lightning.mod.client.controlplane.core.CaptureSession;
import com.lightning.mod.client.controlplane.core.CpException;
import com.lightning.mod.client.controlplane.core.ErrorCodes;
import com.lightning.mod.client.controlplane.core.Fields;
import com.lightning.mod.client.controlplane.core.Json;
import com.lightning.mod.client.controlplane.mc.input.api.DeliverResult;
import com.lightning.mod.client.controlplane.mc.input.api.InputEvent;

/**
 * 四个输入动作共用的薄工具层：结果形状（§5/§6/§10）、参数严格读取（§2）、错误上下文（§6）。
 *
 * <p>
 * 这些函数全是**纯函数**（不碰 MC 状态、不碰运行时），因此可以在无客户端的单测里逐条锁死
 * 参数口径——「非法参数逐条拒绝」这条交付物靠的就是它们。
 */
final class InputSupport {

    /** 事件数组里逐条事件的自证形态（字段名与 {@link InputEvent} 的契约字段同名）。 */
    static JsonArray eventsJson(List<InputEvent> events) {
        JsonArray a = new JsonArray();
        if (events == null) {
            return a;
        }
        for (InputEvent e : events) {
            JsonObject o = new JsonObject();
            o.addProperty("kind", e.kind);
            if (e.key != null) {
                o.addProperty("key", e.key);
            }
            if (e.keyCode != null) {
                o.addProperty("keyCode", e.keyCode);
            }
            if (e.state != null) {
                o.addProperty("state", e.state);
            }
            if (e.codepoint != null) {
                o.addProperty("codepoint", e.codepoint);
            }
            if (e.button != null) {
                o.addProperty("button", e.button);
            }
            if (e.x != null) {
                o.addProperty("x", e.x);
            }
            if (e.y != null) {
                o.addProperty("y", e.y);
            }
            if (e.dx != null) {
                o.addProperty("dx", e.dx);
            }
            if (e.dy != null) {
                o.addProperty("dy", e.dy);
            }
            if (e.amount != null) {
                o.addProperty("amount", e.amount);
            }
            a.add(o);
        }
        return a;
    }

    /**
     * 结果对象的公共前缀（§10.3 / D-1）。
     *
     * <p>
     * {@code layer} **显式**写 {@code null}：本族返回值不携带能力面归因（输入手段与 L0/L1/L2 正交），
     * 填一个不对应的 {@code L} 值比留 {@code null} 更容易误导判据（D-1 裁决）。
     */
    static JsonObject base(String semantics) {
        JsonObject o = new JsonObject();
        o.addProperty("means", InputCapabilities.MEANS);
        o.addProperty("semantics", semantics);
        o.add("layer", JsonNull.INSTANCE);
        return o;
    }

    /** 消费链观察（§5.2 {@code consumer}；只报告不干预，§2.10）。 */
    static JsonObject consumer(InputHost host) {
        JsonObject c = new JsonObject();
        c.addProperty("chain", host.consumerChain());
        String screen = host.currentScreenName();
        c.add("currentScreen", screen == null ? JsonNull.INSTANCE : new JsonPrimitive(screen));
        c.addProperty("allowUserInput", host.allowUserInput());
        c.addProperty("displayActive", host.displayActive());
        c.addProperty("inGameHasFocus", host.inGameHasFocus());
        // 只增字段：界面允许时 GUI 链与世界链**同时**消费，一个 chain 值描述不了这种双活形态
        c.addProperty("worldChainActive", host.worldChainActive());
        // 【#166 DR-12】D-2 的补偿措施要求**如实报告**取证会话是否布防（布防期间不拒输入，
        // 由调用方据本字段自行决定要不要注入）。该量在四个可写动作的返回体里此前**读不到**
        // ⇒「补偿措施」对绝大多数调用方落空。取值与 input.state 同一实现点（CaptureSession）。
        c.addProperty("captureArmed", CaptureSession.isArmedSafely());
        return c;
    }

    /**
     * 「已投递」占位（§4.1 第 3 条）。
     *
     * <p>
     * {@code observed} **只能**是 {@code null} + 说明：设施观测得到的最后一步是「写进队列」，
     * 「被消费者处理」必须由独立读面取得。返回值里禁止出现 {@code observed:true}/{@code success} 这类业务断言。
     */
    static JsonObject consumed() {
        JsonObject o = new JsonObject();
        o.add("observed", JsonNull.INSTANCE);
        o.addProperty("note", "事件在下一个 runTick 被消费（注入点 = tick END，§4.2）；本返回值不声称已处理");
        return o;
    }

    /**
     * 物理并发口径（§3.6 第 3 条）。
     *
     * <p>
     * 键盘侧可判（队列深度探针）；鼠标侧无公开探针 ⇒ 只能 {@code "unobservable"}，
     * <b>禁止</b>编造 {@code false} 冒充「没有冲突」。
     */
    static Object physicalConcurrent(InputRuntimeImpl rt, boolean mouseInvolved) {
        return rt == null ? InputCapabilities.MOUSE_QUEUE_DEPTH : rt.physicalConcurrentFor(mouseInvolved);
    }

    /** {@link #physicalConcurrent} 的 JSON 形态（布尔或字符串 {@code "unobservable"}）。 */
    static JsonElement physicalJson(InputRuntimeImpl rt, boolean mouseInvolved) {
        Object v = physicalConcurrent(rt, mouseInvolved);
        if (v instanceof Boolean) {
            return new JsonPrimitive((Boolean) v);
        }
        return new JsonPrimitive(String.valueOf(v));
    }

    /** 输入运行时的装配体（动作层统一入口；未装配时抛 {@code CP-STATE-001}）。 */
    static InputRuntimeImpl runtime() {
        InputRuntimeImpl rt = InputRuntimeImpl.shared();
        if (rt == null || rt.sink() == null) {
            throw new CpException(ErrorCodes.STATE, "输入运行时未装配");
        }
        return rt;
    }

    /** 作业 id（驱动兜底用；持键归属必须有 id，null 会让「按作业释放」无从判定）。 */
    static String jobId(ActionContext ctx) {
        String id = ctx == null || ctx.job() == null ? null
            : ctx.job()
                .jobId();
        return id == null || id.isEmpty() ? "inline" : id;
    }

    // ------------------------------------------------------------------ 参数严格读取

    /** 是否提供了该参数（非 JSON null）。 */
    static boolean has(JsonObject params, String name) {
        return Json.get(params, name) != null;
    }

    /** 必填字符串；缺失/类型不符抛 {@code CP-VALID-002}（带 received/receivedType/expected）。 */
    static String requireString(JsonObject params, String name) {
        JsonElement e = Json.get(params, name);
        if (e == null) {
            throw param("缺少必填参数: " + name, field(name, "必填", null, "missing", "string"));
        }
        if (!e.isJsonPrimitive() || !e.getAsJsonPrimitive()
            .isString()) {
            throw param(
                "参数类型不符: " + name + " 期望 string",
                field(name, "类型不符", e.toString(), Json.typeName(e), "string"));
        }
        return e.getAsString();
    }

    /** 必填整数（严格：小数/字符串/布尔一律拒，见 Gitea #131 口径）。 */
    static int requireInt(JsonObject params, String name) {
        JsonElement e = Json.get(params, name);
        if (e == null) {
            throw param("缺少必填参数: " + name, field(name, "必填", null, "missing", "int"));
        }
        return Json.strictIntElement(e, name);
    }

    /** 可选整数（严格）。 */
    static int optInt(JsonObject params, String name, int def) {
        return Json.strictInt(params, name, def);
    }

    /** 必填数值（{@code number}）；整数与小数都接受，但字符串/布尔拒。 */
    static double requireNumber(JsonObject params, String name) {
        JsonElement e = Json.get(params, name);
        if (e == null) {
            throw param("缺少必填参数: " + name, field(name, "必填", null, "missing", "number"));
        }
        if (!e.isJsonPrimitive() || !e.getAsJsonPrimitive()
            .isNumber()) {
            throw param(
                "参数类型不符: " + name + " 期望 number",
                field(name, "类型不符", e.toString(), Json.typeName(e), "number"));
        }
        return e.getAsDouble();
    }

    /** 记一条不适用字段（§2.3 的禁用表：传了禁用参数即拒，**不许静默忽略**）。 */
    static void forbidden(Fields fields, JsonObject params, String name, String op) {
        if (has(params, name)) {
            fields.add(name, "op=" + op + " 的禁用参数（传了即拒；不适用字段静默忽略是本仓已定的失效模式，契约 §2.3）");
        }
    }

    /** 记一条必填缺失。 */
    static void required(Fields fields, JsonObject params, String name, String op, String expected) {
        if (!has(params, name)) {
            fields.add(name, "op=" + op + " 的必填参数（" + expected + "）");
        }
    }

    /** 抛「参数非法」（{@code CP-VALID-002}，context.fields 逐字段）。 */
    static CpException param(String message, JsonObject... fieldList) {
        JsonArray arr = new JsonArray();
        for (JsonObject f : fieldList) {
            arr.add(f);
        }
        return paramArray(message, arr);
    }

    /** 抛「参数非法」，字段清单已构造成数组（逐 op 适用面校验用）。 */
    static CpException paramArray(String message, JsonArray fields) {
        JsonObject ctx = new JsonObject();
        ctx.add("fields", fields);
        return new CpException(ErrorCodes.VALID_PARAM, message, ctx);
    }

    /** 一条逐字段说明：{field, reason, received, receivedType, expected}。 */
    static JsonObject field(String name, String reason, String received, String receivedType, String expected) {
        JsonObject f = new JsonObject();
        f.addProperty("field", name);
        f.addProperty("reason", reason);
        f.add("received", received == null ? JsonNull.INSTANCE : new JsonPrimitive(received));
        f.addProperty("receivedType", receivedType);
        f.addProperty("expected", expected);
        return f;
    }

    /** 抛「参数非法」并附上下文（如键位目录）。 */
    static CpException paramWithContext(String message, JsonObject context, JsonObject... fieldList) {
        JsonObject ctx = context == null ? new JsonObject() : context;
        JsonArray arr = new JsonArray();
        for (JsonObject f : fieldList) {
            arr.add(f);
        }
        ctx.add("fields", arr);
        return new CpException(ErrorCodes.VALID_PARAM, message, ctx);
    }

    // ------------------------------------------------------------------ 投递结果 → 错误

    /**
     * 把投递拒绝翻译成契约错误（§6：复用既有四个码，不新增）。
     *
     * <p>
     * 整条请求失败 ⇒ 动作必须抛，而不是「部分成功还报绿」（§4.4 第 1 条）。
     */
    static CpException fromRejections(DeliverResult r, String action) {
        List<DeliverResult.Rejected> rej = r.rejections();
        String code = rej.isEmpty() ? ErrorCodes.STATE : rej.get(0).code;
        JsonArray fields = new JsonArray();
        for (DeliverResult.Rejected x : rej) {
            JsonObject f = new JsonObject();
            f.addProperty("index", Integer.valueOf(x.index));
            f.addProperty("code", x.code);
            f.addProperty("reason", x.reason);
            fields.add(f);
        }
        JsonObject ctx = new JsonObject();
        ctx.addProperty("action", action);
        ctx.add("fields", fields);
        ctx.addProperty("delivered", Integer.valueOf(r.delivered));
        ctx.addProperty("queueDepthAfter", Integer.valueOf(r.queueDepthAfter));
        if (r.constraintHint != null) {
            ctx.addProperty("hint", r.constraintHint);
        }
        String first = rej.isEmpty() ? "投递被拒" : rej.get(0).reason;
        return new CpException(code, "输入投递失败（" + action + "）：" + first, ctx);
    }

    /** 键位标识解析结果。 */
    static final class KeyRef {

        /** 键位描述名（int 形态且目录里没有该键码时为 null）。 */
        final String name;
        /** LWJGL 键码。 */
        final int code;
        /** 是否来自运行期键位目录。 */
        final boolean fromCatalog;

        KeyRef(String name, int code, boolean fromCatalog) {
            this.name = name;
            this.code = code;
            this.fromCatalog = fromCatalog;
        }
    }

    /**
     * 解析 {@code key} 参数（§2.2）。
     *
     * <p>
     * 两种形态**分离**建模：{@code string} = 运行期键位注册表的描述名（如 {@code key.forward}），
     * {@code int} = LWJGL 键码（**不是** SDL scancode）。未知描述名/键码越域一律
     * {@code CP-VALID-002}，且必须给出完整键位目录（不得只报「未知」）。
     */
    static KeyRef resolveKey(JsonObject params, InputHost host) {
        JsonElement e = Json.get(params, "key");
        if (e == null) {
            throw param("缺少必填参数: key", field("key", "必填", null, "missing", "string|int"));
        }
        Map<String, Integer> catalog = host == null ? java.util.Collections.<String, Integer>emptyMap()
            : host.keyCatalog();
        if (e.isJsonPrimitive() && e.getAsJsonPrimitive()
            .isString()) {
            String name = e.getAsString();
            Integer code = catalog.get(name);
            if (code == null) {
                JsonObject ctx = new JsonObject();
                ctx.addProperty("hint", "键位标识的权威来源是运行期键位注册表；目录见 input.state 的 keyCatalog");
                ctx.add("registered", catalogNames(catalog));
                ctx.add("keyCodeRange", rangeJson());
                throw paramWithContext(
                    "键位标识未注册: " + name,
                    ctx,
                    field(
                        "key",
                        "既不是已注册的键位描述，也不是合法 LWJGL 键码",
                        name,
                        "string",
                        "key.<描述名> 或 " + InputCapabilities.KEY_CODE_MIN
                            + ".."
                            + InputCapabilities.KEY_CODE_MAX
                            + " 的 LWJGL 键码"));
            }
            return new KeyRef(name, code.intValue(), true);
        }
        if (e.isJsonPrimitive() && e.getAsJsonPrimitive()
            .isNumber()) {
            int code = Json.strictIntElement(e, "key");
            if (code < InputCapabilities.KEY_CODE_MIN || code > InputCapabilities.KEY_CODE_MAX) {
                JsonObject ctx = new JsonObject();
                ctx.add("keyCodeRange", rangeJson());
                throw paramWithContext(
                    "键码越域: " + code,
                    ctx,
                    field(
                        "key",
                        "LWJGL 键码越域",
                        String.valueOf(code),
                        "int",
                        InputCapabilities.KEY_CODE_MIN + ".." + InputCapabilities.KEY_CODE_MAX));
            }
            String name = nameOf(catalog, code);
            return new KeyRef(name, code, name != null);
        }
        throw param("参数类型不符: key 期望 string|int", field("key", "类型不符", e.toString(), Json.typeName(e), "string|int"));
    }

    /** 目录里某个键码对应的描述名（多个绑定时取第一个；没有则 null）。 */
    static String nameOf(Map<String, Integer> catalog, int code) {
        if (catalog == null) {
            return null;
        }
        for (Map.Entry<String, Integer> en : catalog.entrySet()) {
            if (en.getValue() != null && en.getValue()
                .intValue() == code) {
                return en.getKey();
            }
        }
        return null;
    }

    /** 键位目录名（有序）。 */
    static JsonArray catalogNames(Map<String, Integer> catalog) {
        JsonArray a = new JsonArray();
        if (catalog != null) {
            for (String name : catalog.keySet()) {
                Json.add(a, name);
            }
        }
        return a;
    }

    /** 键码闭区间。 */
    static JsonArray rangeJson() {
        JsonArray a = new JsonArray();
        Json.add(a, Integer.valueOf(InputCapabilities.KEY_CODE_MIN));
        Json.add(a, Integer.valueOf(InputCapabilities.KEY_CODE_MAX));
        return a;
    }

    private InputSupport() {}
}
