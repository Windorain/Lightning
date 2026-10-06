package com.lightning.mod.client.controlplane.core;

import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.function.Supplier;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;

/**
 * 动作注册表：名称 → （自描述 + 实现）。
 *
 * <p>
 * {@code GET /cp/v1/actions} 的 {@code describeAll()}、{@code POST /cp/v1/actions/{name}} 的
 * 查表、以及 {@link Router} 判定「需要哪一级权限、是否需要 confirm」都走这里。
 * 注册名重复视为装配错误，直接抛异常（避免静默覆盖）。
 *
 * <h2>步进动作按作业取实例（不许复用单例）</h2>
 * 步进动作的实现对象一定带<b>作业级状态</b>（阶段、run 句柄、已收段记录、结论……），而
 * {@link SteppingExecutor} 是按作业逐个 {@code step} 推进的。若注册表只存一个实例，第二个作业
 * 会接着上一个作业的状态跑：首段不再初始化、{@code advance} 立刻认为已完成，于是<b>把上一次的
 * 结果原样再交一次</b>（实测：连续 4 个 {@code case.run} 全部返回第一个作业的段记录与 runId，
 * 且后三个没有自己的 run 目录）。因此步进注册一律走<b>工厂</b>：每个作业一个新实例，
 * {@link ActionSteppingExecutor} 在作业首个 step 取一次并在该作业内复用。
 */
public final class ActionRegistry {

    /** 一条注册项。 */
    public static final class Entry {

        private final ActionDescriptor descriptor;
        private final ControlAction action;
        private final Supplier<SteppingAction> steppingFactory;

        Entry(ActionDescriptor descriptor, ControlAction action, Supplier<SteppingAction> steppingFactory) {
            this.descriptor = descriptor;
            this.action = action;
            this.steppingFactory = steppingFactory;
        }

        /** 自描述。 */
        public ActionDescriptor descriptor() {
            return descriptor;
        }

        /** 同步实现；步进注册项返回 null。 */
        public ControlAction action() {
            return action;
        }

        /**
         * 取一个步进实现实例；同步注册项返回 null。
         *
         * <p>
         * 由 {@link ActionSteppingExecutor} 在<b>每个作业</b>的首个 step 调用一次，并在该作业内
         * 复用（跨 tick 状态就活在这个实例里）。工厂注册（
         * {@link ActionRegistry#registerStepping(ActionDescriptor, Supplier)}）每作业返回新实例；
         * 固定实例注册（{@link ActionRegistry#registerStepping(ActionDescriptor, SteppingAction)}）
         * 每次都返回同一对象——那条入口只适合无作业级状态的动作与单测。
         */
        public SteppingAction newSteppingAction() {
            return steppingFactory == null ? null : steppingFactory.get();
        }

        /** 是否步进动作（跨 tick 执行）。 */
        public boolean isStepping() {
            return steppingFactory != null;
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
     * <p>
     * 传实现对象时注册表把它包成<b>固定实例</b>工厂：同一个对象会被所有作业共用。只适用于
     * 无作业级状态的动作或单测；有状态的动作（{@code world.*}/{@code case.run} 这类）必须用
     * {@link #registerStepping(ActionDescriptor, Supplier)}，否则第二个作业会读到上一个作业的状态。
     *
     * @throws IllegalStateException 名称重复或参数为 null
     */
    public void registerStepping(ActionDescriptor descriptor, SteppingAction action) {
        if (action == null) {
            throw new IllegalStateException("动作描述与实现都不能为 null");
        }
        registerStepping(descriptor, () -> action);
    }

    /**
     * 用<b>工厂</b>注册步进动作：每个作业取一个新实例（见类注释「步进动作按作业取实例」）。
     *
     * @param factory 每作业实例工厂；不得返回 null
     * @throws IllegalStateException 名称重复或参数为 null
     */
    public void registerStepping(ActionDescriptor descriptor, Supplier<SteppingAction> factory) {
        if (descriptor == null || factory == null) {
            throw new IllegalStateException("动作描述与实现都不能为 null");
        }
        String name = descriptor.name();
        if (entries.containsKey(name)) {
            throw new IllegalStateException("动作重复注册: " + name);
        }
        entries.put(name, new Entry(descriptor, null, factory));
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
