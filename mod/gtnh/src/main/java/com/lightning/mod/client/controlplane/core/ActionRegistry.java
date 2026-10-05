package com.lightning.mod.client.controlplane.core;

import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;

/**
 * 动作注册表：名称 → （自描述 + 实现）。
 *
 * <p>
 * {@code GET /cp/v1/actions} 的 {@code describeAll()}、{@code POST /cp/v1/actions/{name}} 的
 * 查表、以及 {@link Router} 判定「需要哪一级权限、是否需要 confirm」都走这里。
 * 注册名重复视为装配错误，直接抛异常（避免静默覆盖）。
 */
public final class ActionRegistry {

    /** 一条注册项。 */
    public static final class Entry {

        private final ActionDescriptor descriptor;
        private final ControlAction action;
        private final SteppingAction steppingAction;

        Entry(ActionDescriptor descriptor, ControlAction action, SteppingAction steppingAction) {
            this.descriptor = descriptor;
            this.action = action;
            this.steppingAction = steppingAction;
        }

        /** 自描述。 */
        public ActionDescriptor descriptor() {
            return descriptor;
        }

        /** 同步实现；步进注册项返回 null。 */
        public ControlAction action() {
            return action;
        }

        /** 步进实现；同步注册项返回 null。 */
        public SteppingAction steppingAction() {
            return steppingAction;
        }

        /** 是否步进动作（跨 tick 执行）。 */
        public boolean isStepping() {
            return steppingAction != null;
        }
    }

    private final Map<String, Entry> entries = new LinkedHashMap<String, Entry>();
    private final String contractVersion;

    /** 默认契约版本为 {@link Contract#VERSION}。 */
    public ActionRegistry() {
        this(Contract.VERSION);
    }

    /** 指定契约版本。 */
    public ActionRegistry(String contractVersion) {
        this.contractVersion = contractVersion == null ? Contract.VERSION : contractVersion;
    }

    /**
     * 注册动作。
     *
     * @throws IllegalStateException 名称重复或参数为 null
     */
    public void register(ActionDescriptor descriptor, ControlAction action) {
        if (descriptor == null || action == null) {
            throw new IllegalStateException("动作描述与实现都不能为 null");
        }
        String name = descriptor.name();
        if (entries.containsKey(name)) {
            throw new IllegalStateException("动作重复注册: " + name);
        }
        entries.put(name, new Entry(descriptor, action, null));
    }

    /**
     * 注册步进动作（跨 tick 执行；世界加载、静置、用例执行等）。
     *
     * @throws IllegalStateException 名称重复或参数为 null
     */
    public void registerStepping(ActionDescriptor descriptor, SteppingAction action) {
        if (descriptor == null || action == null) {
            throw new IllegalStateException("动作描述与实现都不能为 null");
        }
        String name = descriptor.name();
        if (entries.containsKey(name)) {
            throw new IllegalStateException("动作重复注册: " + name);
        }
        entries.put(name, new Entry(descriptor, null, action));
    }

    /** 查注册项；未注册返回 null。 */
    public Entry lookup(String name) {
        return name == null ? null : entries.get(name);
    }

    /** 取自描述；未注册返回 null。 */
    public ActionDescriptor descriptor(String name) {
        Entry e = lookup(name);
        return e == null ? null : e.descriptor();
    }

    /** 取实现；未注册返回 null。 */
    public ControlAction action(String name) {
        Entry e = lookup(name);
        return e == null ? null : e.action();
    }

    /** 是否已注册。 */
    public boolean contains(String name) {
        return name != null && entries.containsKey(name);
    }

    /** 已注册动作数。 */
    public int size() {
        return entries.size();
    }

    /** 全部动作名（按注册顺序）。 */
    public List<String> names() {
        return new ArrayList<String>(entries.keySet());
    }

    /** 全部自描述（按名称排序，便于人读与 diff）。 */
    public List<ActionDescriptor> descriptors() {
        List<ActionDescriptor> list = new ArrayList<ActionDescriptor>();
        for (Entry e : entries.values()) {
            list.add(e.descriptor);
        }
        Collections.sort(
            list,
            (a, b) -> a.name()
                .compareTo(b.name()));
        return list;
    }

    /** {@code GET /cp/v1/actions} 的 data：契约版本 + 动作目录 + 计数。 */
    public JsonObject describeAll() {
        JsonArray arr = new JsonArray();
        for (ActionDescriptor d : descriptors()) {
            arr.add(d.toJson());
        }
        JsonObject o = new JsonObject();
        o.addProperty("contractVersion", contractVersion);
        o.addProperty("count", arr.size());
        o.add("actions", arr);
        return o;
    }

    /** 契约版本。 */
    public String contractVersion() {
        return contractVersion;
    }
}
