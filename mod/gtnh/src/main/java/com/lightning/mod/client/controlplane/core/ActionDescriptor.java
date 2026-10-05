package com.lightning.mod.client.controlplane.core;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonPrimitive;
import com.google.gson.JsonSyntaxException;

/**
 * 动作自描述（contract.md §2 的 {@code GET /cp/v1/actions} 数据源）。
 *
 * <p>
 * 一次动作调用所需的全部信息都在本对象里：名称、权限级、参数（名称/类型/必填/默认/说明）、
 * 返回结构说明、调用示例、引入版本 {@code since}。目标是「无先验知识的调用方仅凭自描述即可完成调用」，
 * 因此实现新动作时描述必须与行为同步更新。
 */
public final class ActionDescriptor {

    /** 参数类型：字符串。 */
    public static final String TYPE_STRING = "string";
    /** 参数类型：整数。 */
    public static final String TYPE_INT = "int";
    /** 参数类型：浮点。 */
    public static final String TYPE_NUMBER = "number";
    /** 参数类型：布尔。 */
    public static final String TYPE_BOOL = "boolean";
    /** 参数类型：对象。 */
    public static final String TYPE_OBJECT = "object";
    /** 参数类型：数组。 */
    public static final String TYPE_ARRAY = "array";
    /** 参数类型：文件路径（run 目录内相对路径或宿主机绝对路径，由动作自行约定）。 */
    public static final String TYPE_PATH = "path";

    /** 单个参数的自描述。 */
    public static final class Param {

        private final String name;
        private final String type;
        private final boolean required;
        private final JsonElement defaultValue;
        private final String description;

        private Param(String name, String type, boolean required, JsonElement defaultValue, String description) {
            this.name = name;
            this.type = type;
            this.required = required;
            this.defaultValue = defaultValue;
            this.description = description;
        }

        /** 必填参数。 */
        public static Param required(String name, String type, String description) {
            return new Param(name, type, true, null, description);
        }

        /** 可选参数（无默认值，语义为「不传即用动作内部默认」）。 */
        public static Param optional(String name, String type, String description) {
            return new Param(name, type, false, null, description);
        }

        /** 可选参数（带默认值）。 */
        public static Param optional(String name, String type, Object defaultValue, String description) {
            return new Param(name, type, false, toElement(defaultValue), description);
        }

        /** 全参构造。 */
        public static Param of(String name, String type, boolean required, Object defaultValue, String description) {
            return new Param(name, type, required, toElement(defaultValue), description);
        }

        /** 参数名。 */
        public String name() {
            return name;
        }

        /** 参数类型，见本类 TYPE_* 常量。 */
        public String type() {
            return type;
        }

        /** 是否必填。 */
        public boolean required() {
            return required;
        }

        /** 默认值（可为 null）。 */
        public JsonElement defaultValue() {
            return defaultValue;
        }

        /** 说明。 */
        public String description() {
            return description;
        }

        /** {@code {name, type, required, default?, description}}。 */
        public JsonObject toJson() {
            JsonObject o = new JsonObject();
            o.addProperty("name", name);
            o.addProperty("type", type);
            o.addProperty("required", required);
            if (defaultValue != null) {
                o.add("default", defaultValue);
            }
            if (description != null) {
                o.addProperty("description", description);
            }
            return o;
        }
    }

    private final String name;
    private final Tier tier;
    private final String description;
    private final List<Param> params;
    private final String returns;
    private final JsonArray examples;
    private final String since;

    private ActionDescriptor(Builder b) {
        this.name = b.name;
        this.tier = b.tier;
        this.description = b.description;
        this.params = Collections.unmodifiableList(new ArrayList<Param>(b.params));
        this.returns = b.returns;
        this.examples = b.examples;
        this.since = b.since;
    }

    /** 新建构造器。 */
    public static Builder builder(String name, Tier tier) {
        return new Builder(name, tier);
    }

    /** 动作名（调用方用于 {@code POST /cp/v1/actions/{name}}）。 */
    public String name() {
        return name;
    }

    /** 权限级。 */
    public Tier tier() {
        return tier;
    }

    /** 说明。 */
    public String description() {
        return description;
    }

    /** 参数表。 */
    public List<Param> params() {
        return params;
    }

    /** 返回结构说明。 */
    public String returns() {
        return returns;
    }

    /** 调用示例。 */
    public JsonArray examples() {
        return examples;
    }

    /** 引入的契约小版本，如 {@code 1.0}。 */
    public String since() {
        return since;
    }

    /** 是否可写级（scene 及以上）：决定调用体必须带 {@code "confirm": true}。 */
    public boolean writable() {
        return tier != null && tier.isWritable();
    }

    /** 自描述 JSON（{@code GET /cp/v1/actions} 的单个元素）。 */
    public JsonObject toJson() {
        JsonObject o = new JsonObject();
        o.addProperty("name", name);
        o.addProperty("tier", tier == null ? null : tier.id());
        o.addProperty("writable", writable());
        o.addProperty("confirmRequired", writable());
        o.addProperty("description", description);
        JsonArray ps = new JsonArray();
        for (Param p : params) {
            ps.add(p.toJson());
        }
        o.add("params", ps);
        o.addProperty("returns", returns == null ? "" : returns);
        o.add("examples", examples == null ? new JsonArray() : examples);
        o.addProperty("since", since == null ? Contract.VERSION : since);
        return o;
    }

    private static JsonElement toElement(Object v) {
        if (v == null) {
            return null;
        }
        if (v instanceof JsonElement) {
            return (JsonElement) v;
        }
        if (v instanceof String) {
            return new JsonPrimitive((String) v);
        }
        if (v instanceof Boolean) {
            return new JsonPrimitive((Boolean) v);
        }
        if (v instanceof Number) {
            return new JsonPrimitive((Number) v);
        }
        return new JsonPrimitive(String.valueOf(v));
    }

    /** {@link ActionDescriptor} 构造器（流式）。 */
    public static final class Builder {

        private final String name;
        private final Tier tier;
        private String description = "";
        private final List<Param> params = new ArrayList<Param>();
        private String returns = "";
        private JsonArray examples = new JsonArray();
        private String since = Contract.VERSION;

        private Builder(String name, Tier tier) {
            this.name = name;
            this.tier = tier;
        }

        /** 动作说明（一句话）。 */
        public Builder description(String d) {
            this.description = d == null ? "" : d;
            return this;
        }

        /** 追加一个参数。 */
        public Builder param(Param p) {
            if (p != null) {
                params.add(p);
            }
            return this;
        }

        /** 追加一个必填参数。 */
        public Builder required(String name, String type, String description) {
            return param(Param.required(name, type, description));
        }

        /** 追加一个可选参数。 */
        public Builder optional(String name, String type, String description) {
            return param(Param.optional(name, type, description));
        }

        /** 追加一个带默认值的可选参数。 */
        public Builder optional(String name, String type, Object defaultValue, String description) {
            return param(Param.optional(name, type, defaultValue, description));
        }

        /** 返回结构说明。 */
        public Builder returns(String r) {
            this.returns = r == null ? "" : r;
            return this;
        }

        /** 追加调用示例（JSON 文本，严格解析；解析失败则按字符串存入并保留原文）。 */
        public Builder example(String jsonText) {
            if (jsonText == null) {
                return this;
            }
            try {
                examples.add(Json.parseStrict(jsonText));
            } catch (JsonSyntaxException e) {
                examples.add(new JsonPrimitive(jsonText));
            }
            return this;
        }

        /** 追加调用示例（结构化）。 */
        public Builder example(JsonElement example) {
            if (example != null) {
                examples.add(example);
            }
            return this;
        }

        /** 引入的契约小版本。 */
        public Builder since(String v) {
            this.since = v == null ? Contract.VERSION : v;
            return this;
        }

        /** 构造。 */
        public ActionDescriptor build() {
            if (name == null || name.isEmpty()) {
                throw new IllegalArgumentException("动作名不能为空");
            }
            if (tier == null) {
                throw new IllegalArgumentException("动作权限级不能为空: " + name);
            }
            return new ActionDescriptor(this);
        }
    }
}
