package com.lightning.mod.client.meshcapture.env;

import java.util.ArrayList;
import java.util.Collections;
import java.util.EnumMap;
import java.util.List;
import java.util.Map;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.lightning.mod.client.meshcapture.env.CaptureEnvironmentFacts.Fact;

import cpw.mods.fml.relauncher.Side;
import cpw.mods.fml.relauncher.SideOnly;

/**
 * 一次捕获会话的环境事实<strong>不可变快照</strong>：只回答"这次运行里能录到什么"，不回答"谁占了这个调用点"。
 * <p>
 * 读法只有三种：{@link #get(Fact)}（能力型事实）、{@link #handlers()}（诊断标签）、{@link #tesrBatching()}（诊断标签）。
 * 策略侧只允许读，不得反过来写——快照由 {@link CaptureEnvironmentRegistry} 在会话开始时统一产出。
 * <p>
 * 保守性：没有跑过探针时 {@link #get(Fact)} 一律 {@link Capability#UNKNOWN}。策略必须把 UNKNOWN 当成
 * "不知道"而不是"不能"——兜底与放行的判据都不能建立在猜测上。
 */
@SideOnly(Side.CLIENT)
public final class CaptureEnvironment {

    private final EnumMap<Fact, Capability> capabilities;
    private final List<String> handlers;
    private final TesrBatchingState tesrBatching;
    private final TogglePresence chestCacheToggle;
    private final ModelAccessPresence tankModelAccess;
    private final List<String> notes;
    private final long generation;

    CaptureEnvironment(Map<Fact, Capability> capabilities, List<String> handlers, TesrBatchingState tesrBatching,
        TogglePresence chestCacheToggle, ModelAccessPresence tankModelAccess, List<String> notes, long generation) {
        EnumMap<Fact, Capability> copy = new EnumMap<Fact, Capability>(Fact.class);
        for (Fact f : Fact.values()) {
            Capability c = capabilities == null ? null : capabilities.get(f);
            copy.put(f, c != null ? c : Capability.UNKNOWN);
        }
        this.capabilities = copy;
        this.handlers = handlers == null ? null : Collections.unmodifiableList(new ArrayList<String>(handlers));
        this.tesrBatching = tesrBatching != null ? tesrBatching : TesrBatchingState.UNKNOWN;
        this.chestCacheToggle = chestCacheToggle != null ? chestCacheToggle : TogglePresence.UNKNOWN;
        this.tankModelAccess = tankModelAccess != null ? tankModelAccess : ModelAccessPresence.UNKNOWN;
        this.notes = notes == null ? Collections.<String>emptyList()
            : Collections.unmodifiableList(new ArrayList<String>(notes));
        this.generation = generation;
    }

    /** 全 UNKNOWN 的保守快照（探针未跑、GL 未就绪、探测整体失败）。 */
    public static CaptureEnvironment allUnknown(String reason) {
        List<String> notes = new ArrayList<String>();
        if (reason != null && !reason.isEmpty()) {
            notes.add(reason);
        }
        return new CaptureEnvironment(
            null,
            null,
            TesrBatchingState.UNKNOWN,
            TogglePresence.UNKNOWN,
            ModelAccessPresence.UNKNOWN,
            notes,
            0L);
    }

    public Capability get(Fact fact) {
        Capability c = fact == null ? null : capabilities.get(fact);
        return c != null ? c : Capability.UNKNOWN;
    }

    /** {@code ModelRenderer} 的模型几何能否录到（折中命名，供策略侧直接调用）。 */
    public Capability modelRendererGeometry() {
        return get(Fact.MODEL_RENDERER_GEOMETRY);
    }

    /** 主 {@code Tessellator} 顶点通道是否可用。 */
    public Capability tessellatorVertices() {
        return get(Fact.TESSELLATOR_VERTICES);
    }

    /** {@code DirectTessellator} 通道是否在场。 */
    public Capability directTessellatorVertices() {
        return get(Fact.DIRECT_TESSELLATOR_VERTICES);
    }

    /** 外部处理器方法名；{@code null} = 本次没有采集（与"采集到空集"不同）。 */
    public List<String> handlers() {
        return handlers;
    }

    public TesrBatchingState tesrBatching() {
        return tesrBatching;
    }

    /** 箱子 TESR 网格缓存开关的可得性（PRESENT 才允许在捕获窗口内临时拨动）。 */
    public TogglePresence angelicaTesrChestCacheToggle() {
        return chestCacheToggle;
    }

    /** 某族渲染器的模型数据可得性（只有 {@link ModelAccessPresence#PRESENT} 才允许那条策略参与）。 */
    public ModelAccessPresence tankModelAccess() {
        return tankModelAccess;
    }

    public List<String> notes() {
        return notes;
    }

    /** 注册表递增的代次；{@code 0} = 从未真正探测过。 */
    public long generation() {
        return generation;
    }

    /** 诊断用 JSON（gson 2.2.4 兼容：手工 {@link JsonObject}/{@link JsonArray}）。 */
    public JsonObject toJson() {
        JsonObject root = new JsonObject();
        root.addProperty("generation", Long.valueOf(generation));
        JsonObject caps = new JsonObject();
        for (Fact f : Fact.values()) {
            caps.addProperty(f.name(), get(f).name());
        }
        root.add("capabilities", caps);
        root.addProperty("tesrBatching", tesrBatching.name());
        root.addProperty("angelicaTesrChestCacheToggle", chestCacheToggle.name());
        root.addProperty("enderStorageTankModelAccess", tankModelAccess.name());
        if (handlers == null) {
            root.addProperty("modelRendererHandlersCollected", Boolean.FALSE);
        } else {
            root.addProperty("modelRendererHandlersCollected", Boolean.TRUE);
            JsonArray arr = new JsonArray();
            for (String h : handlers) {
                arr.add(new com.google.gson.JsonPrimitive(h));
            }
            root.add("modelRendererHandlers", arr);
        }
        JsonArray noteArr = new JsonArray();
        for (String n : notes) {
            noteArr.add(new com.google.gson.JsonPrimitive(n));
        }
        root.add("notes", noteArr);
        return root;
    }
}
