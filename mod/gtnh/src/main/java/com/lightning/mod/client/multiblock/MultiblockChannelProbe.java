package com.lightning.mod.client.multiblock;

import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;

import net.minecraft.item.ItemStack;
import net.minecraft.util.StatCollector;
import net.minecraft.world.World;

import com.gtnewhorizon.structurelib.StructureLibAPI;
import com.gtnewhorizon.structurelib.alignment.constructable.IConstructable;
import com.gtnewhorizon.structurelib.alignment.constructable.IConstructableProvider;
import com.gtnewhorizon.structurelib.alignment.constructable.ISurvivalConstructable;
import com.gtnewhorizon.structurelib.structure.AutoPlaceEnvironment;
import com.gtnewhorizon.structurelib.structure.IItemSource;
import com.gtnewhorizon.structurelib.structure.IStructureDefinition;
import com.gtnewhorizon.structurelib.structure.IStructureElement;
import com.gtnewhorizon.structurelib.structure.IStructureElementChain;
import com.gtnewhorizon.structurelib.structure.StructureDefinition;
import com.gtnewhorizon.structurelib.structure.StructureUtility;

import cpw.mods.fml.relauncher.Side;
import cpw.mods.fml.relauncher.SideOnly;
import gregtech.api.GregTechAPI;
import gregtech.api.interfaces.metatileentity.IMetaTileEntity;
import gregtech.api.util.GTStructureUtility;
import gregtech.common.misc.GTStructureChannels;

/**
 * T1.2 通道探测内核。
 * <p>
 * 三件事，互不依赖地各自成立，失败也各自记录：
 * <ol>
 * <li><b>枚举</b>：扫描 {@link GregTechAPI#METATILEENTITIES}，取出全部 {@link IConstructable}
 * （{@link IConstructableProvider} 是基座 {@code BaseMetaTileEntity} 实现、返回的就是这些 MTE，故不重复计入），
 * 记录类名 / 显示名 / 本地化名 / 是否 {@link ISurvivalConstructable}。</li>
 * <li><b>通道</b>：遍历该机 {@link IStructureDefinition} 的全部结构片段与全部元素，解出每个元素实际读的通道
 * （{@code withChannel} 匿名类的 {@code val$channel}，或自定义元素直读 —— 后者不靠名字猜，见下）。</li>
 * <li><b>总 Tier</b>：见 {@link MultiblockTierEstimator}，在假世界里真放控制器逐级 {@code construct}。</li>
 * </ol>
 * <p>
 * <b>为什么通道名不能只靠反射 {@code val$channel}</b>（T0.4 R6）：{@code StructureUtility#withChannel} 返回的匿名类
 * 是唯一带 {@code val$channel} 的容器，而 {@code MTETankTFFT#TFFTStorageFieldElement} 这类自定义元素<b>不经包裹</b>，
 * 在自己的 {@code getHint} 里读 {@code GTStructureChannels.TFFT_FIELD}。本实现的处理方式是<b>不猜名字</b>：
 * 对每个「不认识的」元素做取值域探测，若参照方块集合随触发值变化，就把这个元素类名与观测上界原样落盘
 * （{@code unknownValueDependentElements}），并用 {@link #applyRegistryCrossCheck} 把该 id 的注册表登记值与
 * 各通道的上界比对，供人工/下游裁决。
 */
@SideOnly(Side.CLIENT)
public final class MultiblockChannelProbe {

    /** 单通道取值域探测的硬上限（T0.4 R10：{@code glass} 实测 ≈35，留足余量）。 */
    public static final int MAX_CHANNEL_VALUE = 64;
    /** 取值域早停：连续这么多个取值给出的参照方块集合完全不变，即认为已夹取到上界。 */
    private static final int DOMAIN_PLATEAU = 3;

    /**
     * 尺寸型通道 {@code getValueClamped(trigger, min, max)} 的静态事实表（T0.4 §3.5 六条读取点全表；
     * {@code MTETankTFFT} 的 MAX_LAYER_AMOUNT 取 16）。
     * <p>
     * 尺寸型通道<b>不绑定到符号</b>（{@code .use()} 命中数 = 0），只在 {@code construct} 里被读取，
     * 因此结构定义里看不到它；本表是唯一可机读的来源，落盘时标 {@code domainSource: "source-table"}。
     */
    private static final Map<String, int[]> DIMENSION_DOMAINS = new LinkedHashMap<String, int[]>();

    /** {@code 机器简单名 -> 尺寸通道 id}（值表在 {@link #DIMENSION_DOMAINS} 里按 {@code 机器|通道} 存）。 */
    private static final Map<String, String> MACHINE_DIMENSION_CHANNEL = new LinkedHashMap<String, String>();

    private static void putDimension(String machine, String channel, int min, int max) {
        DIMENSION_DOMAINS.put(machine + "|" + channel, new int[] { min, max });
        MACHINE_DIMENSION_CHANNEL.put(machine, channel);
    }

    private static int[] dimensionDomain(String machine, String channel) {
        return DIMENSION_DOMAINS.get(machine + "|" + channel);
    }

    /**
     * 「自定义 IStructureElement 直读通道」的显式映射表。
     * <p>
     * <b>为什么必须有这张表</b>（T0.4 R6 的最后一环）：这类元素<b>没有</b> {@code withChannel} 包裹
     * （所以没有 {@code val$channel} 可读），而且<b>不实现</b> {@code IStructureElement#getBlocksToPlace}
     * （所以取值域探测拿不到任何东西 —— 它只在 {@code spawnHint}/{@code placeBlock} 里读通道）。
     * 两条自动路径都覆盖不到，唯一的事实来源就是读取点本身。
     * <p>
     * 已核实（pinned GT5U 5.09.52.283 的 {@code javap}）：
     * {@code MTETankTFFT$TFFTStorageFieldElement} 是枚举、实现 {@code IStructureElement}，
     * 其 {@code getHint} 调 {@code GTStructureChannels.TFFT_FIELD.getValueClamped(stack, 1, Field.VALUES.length)}，
     * 而 {@code javap -c} 显示该类<b>没有</b> {@code getBlocksToPlace} 实现（继承默认返回 {@code null}）。
     * 它在 {@code MTETankTFFT} 的结构定义里以 {@code TFFTStorageFieldElement.INSTANCE} 直接 {@code addElement}。
     */
    private static final Map<String, String[]> CUSTOM_CHANNEL_ELEMENTS = new LinkedHashMap<String, String[]>();

    /**
     * 自定义通道元素的<b>声明取值上界</b>：{@code 通道 id -> {1 基上界, 依据}}。
     * <p>
     * 只在「注册表里没有该通道的登记项」时才需要它：{@code TFFT_FIELD} 的取值上界由
     * {@code getValueClamped(stack, 1, Field.VALUES.length)} 决定，而 {@code Field.VALUES.length == 10}，
     * 但该通道<b>没有</b> {@code registerAsIndicator} 调用（{@code ChannelDescription#items} 为空，
     * 实测 registry.json 的 {@code field.items=0}），所以注册表给不出上界。
     */
    private static final Map<String, String[]> CUSTOM_CHANNEL_DECLARED_MAX = new LinkedHashMap<String, String[]>();

    static {
        // 元素类简单名 -> { 通道 enumName, 通道 id, 取值域来源说明 }
        CUSTOM_CHANNEL_ELEMENTS.put(
            "MTETankTFFT$TFFTStorageFieldElement",
            new String[] { "TFFT_FIELD", "field",
                "getValueClamped(stack, 1, MTETankTFFT.Field.VALUES.length)，VALUES 长度 10（T1..T10）" });
        CUSTOM_CHANNEL_DECLARED_MAX
            .put("field", new String[] { "10", "MTETankTFFT.Field.VALUES.length（T1..T10，pinned GT5U 5.09.52.283）" });
    }

    private static String[] customChannelMapping(Class<?> cls) {
        // 允许简单名与全限定名两种写法匹配
        String full = cls.getName();
        int dot = full.lastIndexOf('.');
        String simpleName = dot < 0 ? full : full.substring(dot + 1);
        for (Map.Entry<String, String[]> e : CUSTOM_CHANNEL_ELEMENTS.entrySet()) {
            if (e.getKey()
                .equals(simpleName)
                || e.getKey()
                    .equals(full)) {
                return e.getValue();
            }
        }
        return null;
    }

    private static final Map<String, List<String>> ENUM_NAMES_BY_ID = new LinkedHashMap<String, List<String>>();
    private static final Set<String> CHANNEL_ID_SET = new LinkedHashSet<String>();

    static {
        // 自定义通道元素显式映射（必须在下面 customChannelMapping 使用前填充）
        CUSTOM_CHANNEL_ELEMENTS.put(
            "MTETankTFFT$TFFTStorageFieldElement",
            new String[] { "TFFT_FIELD", "field",
                "getValueClamped(stack, 1, MTETankTFFT.Field.VALUES.length)，VALUES 长度 10（T1..T10）" });

        // 尺寸型通道的静态事实表：值 = {min, max}，与 getValueClamped(trigger, min, max) 的两个实参一一对应
        putDimension("MTEDistillationTower", "height", 3, 12);
        putDimension("MTEMegaDistillTower", "height", 3, 12);
        putDimension("MTEAdvDistillationTower", "height", 3, 12);
        putDimension("MTEPowerSubStation", "height", 4, 18);
        putDimension("MTELapotronicSuperCapacitor", "height", 4, 50);
        putDimension("MTEAssemblyLine", "length", 5, 16);
        putDimension("MTEAdvAssLine", "length", 5, 16);
        putDimension("MTEIndustrialCokeOven", "length", 1, 16);
        putDimension("MTETankTFFT", "height", 4, 16);
        putDimension("MTENetworkSwitchAdv", "length", 1, 16);

        for (GTStructureChannels c : GTStructureChannels.values()) {
            CHANNEL_ID_SET.add(c.get());
            List<String> byId = ENUM_NAMES_BY_ID.get(c.get());
            if (byId == null) {
                byId = new ArrayList<String>();
                ENUM_NAMES_BY_ID.put(c.get(), byId);
            }
            byId.add(c.name());
        }
    }

    // ------------------------------------------------------------------ 反射内核（T0.2 §4.2 的「无公开访问器」成员）

    private static final String LAZY_ELEMENT_CLASS = "com.gtnewhorizon.structurelib.structure.LazyStructureElement";
    private static final String HATCH_BUILDER_CLASS = "gregtech.api.util.HatchElementBuilder";
    private static final String FIELD_HATCH_HINT = "mHint";

    /**
     * 匿名类捕获字段的候选名。
     * <p>
     * <b>为什么不能只写 {@code val$channel}</b>：StructureLib 是用<b>现代 javac + jabel</b> 编译的，
     * 现代 javac 对匿名类捕获变量生成的是 {@code arg$1}/{@code arg$2}…，而不是 JDK 8 时代的
     * {@code val$channel}。参考实现 {@code BlockRenderer6343/StructureHacks} 硬编码 {@code val$channel}，
     * 只对「JDK 8 目标字节码」成立。本实现改为<b>候选名 + 值校验</b>：逐个读候选字段，第一个取值落在
     * StructureLib 通道注册表里的字符串即认定为通道 id（见 {@link #withChannelName}）。
     */
    private static final String[] CAPTURED_STRING_FIELDS = { "val$channel", "arg$1", "arg$2", "arg$3" };
    /**
     * backing / 内层元素捕获字段的候选名。
     * <p>
     * 实测（{@code summary.json#reflectionKernelFacts}）：本仓运行时的 {@code withChannel} 匿名类字段是
     * {@code IStructureElement val$backing} + {@code String val$channel}，{@code onElementPass} 匿名类字段是
     * {@code IStructureElement val$element} + {@code Consumer val$onCheckPass}。两个都保留 {@code arg$N} 兜底，
     * 以兼容将来改用现代 javac 字节码（那时名字会变成 {@code arg$N}）。
     */
    private static final String[] CAPTURED_ELEMENT_FIELDS = { "val$backing", "val$element", "arg$1", "arg$2", "arg$3",
        "val$elem" };

    private static final String CLASS_WITH_CHANNEL;
    private static final String CLASS_ON_ELEMENT_PASS;
    private static final String CLASS_HATCH_ELEMENT;

    private static final Method LAZY_GET_METHOD;

    /** 反射内核初始化失败原因（null = 全部成功）。失败不阻断扫描，只把相应能力降级为 fallback。 */
    public static final String REFLECTION_ERROR;

    /** 反射内核自检事实（落盘到 {@code environment.json}，供版本升级后定位断裂面）。 */
    public static final String REFLECTION_KERNEL_FACTS;

    static {
        StringBuilder facts = new StringBuilder();
        StringBuilder err = new StringBuilder();
        IStructureElement<IConstructable> channelElem = null;
        IStructureElement<IConstructable> onPassElem = null;
        IStructureElement<IConstructable> hatchElem = null;
        Method lazyGet = null;

        // 1) 先把各容器匿名类的运行时类名构造出来（拿不到就没法按类名识别，逐项独立记错）
        try {
            IStructureElement<IConstructable> backing = StructureUtility
                .ofBlocksTiered((a, b) -> 0, null, (c, d) -> {}, e -> -1);
            channelElem = StructureUtility.withChannel("blah", backing);
            onPassElem = StructureUtility.onElementPass(o -> {}, backing);
        } catch (Throwable t) {
            appendError(err, "constructContainerElements", t);
        }
        try {
            // build() 要求 adder / casingIndex / hint 三者都已设置且为正数（HatchElementBuilder.java:418/216/222）
            @SuppressWarnings("unchecked")
            IStructureElement<IConstructable> h = (IStructureElement<IConstructable>) (IStructureElement<?>) GTStructureUtility
                .buildHatchAdder()
                .adder((t, te, idx) -> false)
                .casingIndex(1)
                .hint(1)
                .build();
            hatchElem = h;
        } catch (Throwable t) {
            appendError(err, "constructHatchElement", t);
        }

        // 2) LazyStructureElement#get 是 private 包级私有类的方法：用普通反射（setAccessible）而非 MethodHandle
        try {
            Class<?> lazy = Class.forName(LAZY_ELEMENT_CLASS);
            lazyGet = lazy.getDeclaredMethod("get", Object.class);
            lazyGet.setAccessible(true);
        } catch (Throwable t) {
            appendError(err, "resolveLazyGetter", t);
        }

        // 3) HatchElementBuilder#mHint 可解析性自检
        try {
            findField(Class.forName(HATCH_BUILDER_CLASS), FIELD_HATCH_HINT);
        } catch (Throwable t) {
            appendError(err, "resolveHatchHintField", t);
        }

        facts.append("withChannelClass=")
            .append(
                channelElem == null ? "<unavailable>"
                    : channelElem.getClass()
                        .getName())
            .append("; fields=")
            .append(channelElem == null ? "-" : describeFields(channelElem.getClass()))
            .append("; onElementPassClass=")
            .append(
                onPassElem == null ? "<unavailable>"
                    : onPassElem.getClass()
                        .getName())
            .append("; fields=")
            .append(onPassElem == null ? "-" : describeFields(onPassElem.getClass()))
            .append("; hatchElementClass=")
            .append(
                hatchElem == null ? "<unavailable>"
                    : hatchElem.getClass()
                        .getName())
            .append("; fields=")
            .append(hatchElem == null ? "-" : describeFields(hatchElem.getClass()))
            .append("; lazyClass=")
            .append(LAZY_ELEMENT_CLASS)
            .append("; lazyGetResolved=")
            .append(lazyGet != null);

        CLASS_WITH_CHANNEL = channelElem == null ? null
            : channelElem.getClass()
                .getName();
        CLASS_ON_ELEMENT_PASS = onPassElem == null ? null
            : onPassElem.getClass()
                .getName();
        CLASS_HATCH_ELEMENT = hatchElem == null ? null
            : hatchElem.getClass()
                .getName();
        LAZY_GET_METHOD = lazyGet;
        REFLECTION_ERROR = err.length() == 0 ? null : err.toString();
        REFLECTION_KERNEL_FACTS = facts.toString();
    }

    private static void appendError(StringBuilder sb, String stage, Throwable t) {
        if (sb.length() > 0) sb.append(" | ");
        sb.append(stage)
            .append(" -> ")
            .append(t.toString());
        Throwable c = t.getCause();
        if (c != null) {
            sb.append(" caused by ")
                .append(c.toString());
        }
    }

    /** {@code 字段名:类型} 列表，供 environment.json 记录（这是版本升级时的断裂面证据）。 */
    private static String describeFields(Class<?> owner) {
        StringBuilder sb = new StringBuilder();
        for (Field f : owner.getDeclaredFields()) {
            if (java.lang.reflect.Modifier.isStatic(f.getModifiers())) continue;
            if (sb.length() > 0) sb.append(",");
            sb.append(f.getName())
                .append(':')
                .append(
                    f.getType()
                        .getSimpleName());
        }
        return sb.toString();
    }

    private static Field findField(Class<?> owner, String name) throws NoSuchFieldException {
        Class<?> c = owner;
        while (c != null) {
            try {
                Field f = c.getDeclaredField(name);
                f.setAccessible(true);
                return f;
            } catch (NoSuchFieldException ignored) {
                c = c.getSuperclass();
            }
        }
        throw new NoSuchFieldException(owner.getName() + "#" + name);
    }

    private static Method findMethod(Class<?> owner, String name, Class<?>... params) throws NoSuchMethodException {
        Method m = owner.getDeclaredMethod(name, params);
        m.setAccessible(true);
        return m;
    }

    private static boolean isWithChannelElement(IStructureElement<?> e) {
        return CLASS_WITH_CHANNEL != null && CLASS_WITH_CHANNEL.equals(
            e.getClass()
                .getName());
    }

    private static boolean isLazyElement(IStructureElement<?> e) {
        return LAZY_ELEMENT_CLASS.equals(
            e.getClass()
                .getName());
    }

    private static boolean isOnElementPass(IStructureElement<?> e) {
        return CLASS_ON_ELEMENT_PASS != null && CLASS_ON_ELEMENT_PASS.equals(
            e.getClass()
                .getName());
    }

    private static boolean isHatchElement(IStructureElement<?> e) {
        return CLASS_HATCH_ELEMENT != null && CLASS_HATCH_ELEMENT.equals(
            e.getClass()
                .getName());
    }

    // ------------------------------------------------------------------ 数据结构

    public static final class ChannelObservedValue {

        public int value;
        public String blocksKey = "";
        public int blockCount;
    }

    public static final class ChannelProbe {

        public String enumName = "";
        public String id = "";
        public String kind = "replace";
        public String discoverySource = "unknown";
        public String elementClass = "";
        /** {@code probed} | {@code source-table} | {@code declared-boolean} | {@code fallback} */
        public String domainSource = "fallback";
        public Integer min;
        public Integer max;
        public int distinctValues;
        public int observedMax;
        /** 观测到的<b>不同方块状态</b>个数（= {@code distinctValues} 的显式别名，用于和提示列表长度区分）。 */
        public int observedBlockStateCount;
        public boolean plateauReached;
        /** 提示列表尾部是否存在与最后一个新档位相同的重复项（见 {@code probeOneChannel} 的注释）。 */
        public boolean hintListHasTrailingRepeat;
        public Integer registryItemCount;
        public Integer registryMaxValue;
        /**
         * {@code machine} | {@code global-registry}。
         * <p>
         * {@code max} 的口径：{@code probed} 时是<b>本机</b>该通道参照方块集合停止变化前的最后一个新档位
         * （= 本机实际可用的取值数）；{@code source-table} 时是 {@code getValueClamped} 的 1 基上界。
         * 注册表的 {@code maxRegisteredValue} 是<b>全局并集</b>（所有机器共用同一张
         * {@code ChannelDescription#items}），因此两者不等是正常现象，不是数据冲突。
         */
        public String domainScope = "machine";
        public String registryAgreement = "not-compared";
        /** 「自定义元素直读通道」时的独立观测上界（与通道自身抓取值域口径不同）。 */
        public Integer unknownElementObservedMax;
        /** 合并掉的重复元素条目数（同一元素被多个符号/结构片段共享）。 */
        public int duplicateElementCount;
        /** 该通道被观测到的取值 → 参照方块集合指纹（1 基；含夹取后的重复值）。 */
        public final List<ChannelObservedValue> observed = new ArrayList<ChannelObservedValue>();
        public final List<String> notes = new ArrayList<String>();
    }

    public static final class Failure {

        public String fqcn;
        public String stage;
        public String exception;
        public String message;
        public String stackTraceHead;
    }

    public static final class MachineProbe {

        public int mteId;
        public String fqcn = "";
        public String simpleName = "";
        public String displayName = "";
        public String localizedName = "";
        public boolean isMetaTileEntity;
        public boolean isSurvivalConstructable;
        public boolean hasStructureDefinition;
        public int structurePieceCount;
        public int distinctElementCount;
        public int skippedNonTieredElements;
        public final Set<String> elementClassNames = new LinkedHashSet<String>();
        public final List<ChannelProbe> channels = new ArrayList<ChannelProbe>();
        public final List<String> unknownValueDependentElements = new ArrayList<String>();
        public final List<String> notes = new ArrayList<String>();

        public Integer maxTotalTier;
        public String tierSource = "none";
        public int tierAttempts;
        public boolean tierEstimateHitCap;
        public int tierBlocksAtMax;
        public String tierFailure;
        public long tierElapsedMs;
        /** 逐级 {@code construct} 的世界变更量（诊断用：deltas[i] = tier i+1 的 block set 变更次数）。 */
        public List<Integer> tierMutationDeltas = new ArrayList<Integer>();
        /** tier=2 那一次 construct 造成的具体方块变更（诊断「为什么一直在变」）。 */
        public List<String> tierSecondTierTrace = new ArrayList<String>();

        public boolean channelProbeFailed;
        public String channelFailure;

        /** 每个通道探测时使用的空世界与上下文（{@code getBlocksToPlace} 的坐标参数）。 */
        public transient World probeWorld;
        public transient IConstructable probeContext;

        public String slug() {
            return simpleName.toLowerCase(Locale.ROOT)
                .replaceAll("[^a-z0-9]+", "-")
                .replaceAll("^-|-$", "");
        }
    }

    // ------------------------------------------------------------------ 权威通道注册表（首选数据源）

    /** 通道注册表快照（StructureLib {@code ChannelDescription.getAll()}，T0.4 §3.7 方法 2）。 */
    public static Map<String, com.gtnewhorizon.structurelib.ChannelDescription> channelRegistry() {
        return new TreeMap<String, com.gtnewhorizon.structurelib.ChannelDescription>(
            com.gtnewhorizon.structurelib.ChannelDescription.getAll());
    }

    public static Map<String, List<String>> enumNamesById() {
        return ENUM_NAMES_BY_ID;
    }

    public static String kindOfChannelId(String enumName, String id) {
        for (GTStructureChannels c : GTStructureChannels.values()) {
            if (c.name()
                .equals(enumName)) return kindOf(c);
        }
        return kindOfById(id);
    }

    public static String kindOfById(String id) {
        if ("height".equals(id) || "length".equals(id)) return "dimension";
        if ("gt_hatch".equals(id)) return "hatch";
        return "replace";
    }

    private static String kindOf(GTStructureChannels c) {
        return kindOfById(c.get());
    }

    /** 通道 → 该通道全部枚举名（{@code casing} → 3 条）。 */
    public static List<String> enumNamesForId(String id) {
        List<String> l = ENUM_NAMES_BY_ID.get(id);
        return l == null ? Collections.<String>emptyList() : Collections.unmodifiableList(l);
    }

    // ------------------------------------------------------------------ 枚举

    /** 枚举全部 GT 多方块；顺序 = {@code METATILEENTITIES} 下标，保证跨运行确定序。 */
    public static List<MachineProbe> enumerate() {
        List<MachineProbe> out = new ArrayList<MachineProbe>();
        IMetaTileEntity[] all = GregTechAPI.METATILEENTITIES;
        if (all == null) return out;
        for (int i = 0; i < all.length; i++) {
            IMetaTileEntity mte = all[i];
            if (mte == null) continue;
            if (!(mte instanceof IConstructable)) continue;
            MachineProbe m = new MachineProbe();
            m.mteId = i;
            m.fqcn = mte.getClass()
                .getName();
            m.simpleName = mte.getClass()
                .getSimpleName();
            m.isMetaTileEntity = true;
            m.isSurvivalConstructable = mte instanceof ISurvivalConstructable;
            try {
                ItemStack form = mte.getStackForm(1);
                if (form != null) {
                    m.displayName = String.valueOf(form.getDisplayName());
                    String unlocalized = form.getUnlocalizedName();
                    m.localizedName = unlocalized == null ? ""
                        : String.valueOf(StatCollector.translateToLocal(unlocalized));
                }
            } catch (Throwable t) {
                m.notes.add(
                    "getStackForm/显示名解析失败: " + t.getClass()
                        .getSimpleName());
            }
            out.add(m);
        }
        return out;
    }

    /**
     * 基座侧计数：{@link IConstructableProvider} 是 {@code BaseMetaTileEntity} 实现的接口，
     * 其 {@code getConstructable()} 返回的就是同一批 {@code IMetaTileEntity}。本方法只做一致性断言，
     * 不做二次展开（否则同一台机器会出现两份）。
     */
    public static int countBaseTileProvidesConstructable() {
        IMetaTileEntity[] all = GregTechAPI.METATILEENTITIES;
        if (all == null) return 0;
        int n = 0;
        for (IMetaTileEntity mte : all) {
            if (mte != null && mte instanceof IConstructableProvider) n++;
        }
        return n;
    }

    // ------------------------------------------------------------------ 通道探测

    private static final IItemSource EMPTY_ITEM_SOURCE = new IItemSource() {

        @Override
        public Map<ItemStack, Integer> take(java.util.function.Predicate<ItemStack> predicate, boolean simulate,
            int count) {
            return Collections.emptyMap();
        }
    };

    private static final AutoPlaceEnvironment PROBE_ENV = AutoPlaceEnvironment
        .fromLegacy(EMPTY_ITEM_SOURCE, null, a -> {});

    /** 探测一台机器的全部通道。单通道失败不影响其它通道；整体失败记在 {@code channelFailure}。 */
    public static void probeChannels(MachineProbe m, IConstructable multi) {
        m.probeContext = multi;
        try {
            IStructureDefinition<IConstructable> def = castDefinition(multi);
            if (def == null) {
                m.hasStructureDefinition = false;
                m.notes.add("getStructureDefinition() 不返回 StructureDefinition，无法遍历元素");
                return;
            }
            m.hasStructureDefinition = true;
            Map<String, IStructureElement<IConstructable>[]> structures = structuresOf(def);
            m.structurePieceCount = structures.size();

            // 元素去重（同一元素对象可能被多个符号 / 多个结构片段共享）
            Set<Object> seen = Collections.newSetFromMap(new java.util.IdentityHashMap<Object, Boolean>());
            List<IStructureElement<IConstructable>> distinct = new ArrayList<IStructureElement<IConstructable>>();
            for (IStructureElement<IConstructable>[] arr : structures.values()) {
                if (arr == null) continue;
                for (IStructureElement<IConstructable> e : arr) {
                    if (e == null) continue;
                    if (seen.add(e)) distinct.add(e);
                }
            }
            m.distinctElementCount = distinct.size();

            Map<String, List<IStructureElement<IConstructable>>> byId = new LinkedHashMap<String, List<IStructureElement<IConstructable>>>();
            List<IStructureElement<IConstructable>> unknownElements = new ArrayList<IStructureElement<IConstructable>>();
            boolean sawHatch = false;

            for (IStructureElement<IConstructable> e : distinct) {
                m.elementClassNames.add(
                    e.getClass()
                        .getName());
                sawHatch = collectChannels(multi, e, byId, unknownElements, m, 0) || sawHatch;
            }

            for (Map.Entry<String, List<IStructureElement<IConstructable>>> entry : byId.entrySet()) {
                assignChannels(m, entry.getKey(), entry.getValue());
            }

            // 未识别的元素：用取值域探测证明它是否「值依赖触发器」，从而判断有没有漏掉通道（T0.4 R6）
            Set<String> unknownSignatures = new LinkedHashSet<String>();
            for (IStructureElement<IConstructable> e : unknownElements) {
                // 自定义元素直读通道（T0.4 R6 型）：既没有 withChannel 包裹、又不实现 getBlocksToPlace，
                // 两条自动路径都覆盖不到 —— 只能按显式映射补登记，并把「为什么能认出来」写进 notes。
                String[] mapped = customChannelMapping(e.getClass());
                if (mapped != null) {
                    if (!hasChannelId(m, mapped[1])) {
                        m.channels.add(
                            customChannelElementProbe(
                                m,
                                mapped[0],
                                mapped[1],
                                mapped[2],
                                e.getClass()
                                    .getName()));
                    }
                    continue;
                }
                detectValueDependentElement(m, e, unknownSignatures);
            }

            // 尺寸型通道从不绑定符号（T0.4 §3.5），只能按「机器 → 通道」的静态事实表补登记
            String dimChannel = MACHINE_DIMENSION_CHANNEL.get(m.simpleName);
            if (dimChannel != null) {
                m.channels.add(dimensionChannelProbe(m, dimChannel));
            }

            if (sawHatch) {
                ChannelProbe p = new ChannelProbe();
                p.enumName = "HATCH";
                p.id = "gt_hatch";
                p.kind = "hatch";
                p.discoverySource = "element-scan(hatch-builder)";
                p.domainSource = "declared-boolean";
                p.registryAgreement = "not-applicable";
                p.notes.add("布尔开关型通道（HatchElementBuilder 的自动放置门槛），无语义取值，不生成滑杆");
                m.channels.add(p);
            }

            Collections.sort(m.channels, (a, b) -> {
                int c = a.id.compareTo(b.id);
                return c != 0 ? c : a.enumName.compareTo(b.enumName);
            });
            dedupeChannels(m);
        } catch (Throwable t) {
            m.channelProbeFailed = true;
            m.channelFailure = describe(t);
            m.notes.add("通道探测整体失败（已落盘，不静默跳过）");
            throw new RuntimeException(t);
        }
    }

    @SuppressWarnings("unchecked")
    private static IStructureDefinition<IConstructable> castDefinition(IConstructable multi) {
        Object def = multi.getStructureDefinition();
        return def instanceof IStructureDefinition ? (IStructureDefinition<IConstructable>) def : null;
    }

    @SuppressWarnings("unchecked")
    private static Map<String, IStructureElement<IConstructable>[]> structuresOf(
        IStructureDefinition<IConstructable> def) {
        if (def instanceof StructureDefinition) {
            return ((StructureDefinition<IConstructable>) def).getStructures();
        }
        return Collections.emptyMap();
    }

    /**
     * 沿链展开一个元素，登记它读了哪些通道；返回是否发现舱口元素。
     * <p>
     * 展开规则：{@code withChannel} 匿名类 → 读出通道 id（值校验）后继续展开 backing；{@code LazyStructureElement}
     * → 用实例解析后继续；{@code onElementPass} → 展开捕获的内层元素后继续；{@code IStructureElementChain}
     * → 每个 fallback 都展开（OR 语义，位置由多个元素共同决定）。不认识的元素进 {@code unknownElements}。
     */
    private static boolean collectChannels(IConstructable multi, IStructureElement<IConstructable> element,
        Map<String, List<IStructureElement<IConstructable>>> byId, List<IStructureElement<IConstructable>> unknown,
        MachineProbe m, int depth) {
        if (element == null || depth > 24) return false;

        if (isHatchElement(element)) return true;

        if (isWithChannelElement(element)) {
            String channel = withChannelName(element);
            if (channel != null && !channel.isEmpty()) {
                addChannel(byId, channel, element);
            } else {
                m.notes.add(
                    "withChannel 元素的捕获字段里没有可识别的通道 id（候选字段 " + java.util.Arrays.toString(CAPTURED_STRING_FIELDS)
                        + "，实际字段 "
                        + describeFields(element.getClass())
                        + "），通道记为未知");
                unknown.add(element);
            }
            IStructureElement<IConstructable> backing = capturedElement(element);
            if (backing != null && backing != element) {
                collectChannels(multi, backing, byId, unknown, m, depth + 1);
            }
            return false;
        }

        if (isLazyElement(element)) {
            IStructureElement<IConstructable> inner = lazyResolve(multi, element);
            if (inner != null && inner != element) {
                return collectChannels(multi, inner, byId, unknown, m, depth + 1);
            }
            m.notes.add(
                "LazyStructureElement 解析失败（类名 " + element.getClass()
                    .getName() + "），其内部通道未登记");
            return false;
        }

        if (isOnElementPass(element)) {
            IStructureElement<IConstructable> inner = onElementPassUnderlying(element);
            if (inner != null && inner != element) {
                return collectChannels(multi, inner, byId, unknown, m, depth + 1);
            }
            m.notes.add("onElementPass 解包失败（实际字段 " + describeFields(element.getClass()) + "），其内部通道未登记");
            return false;
        }

        if (element instanceof IStructureElementChain) {
            IStructureElement<IConstructable>[] fallbacks = ((IStructureElementChain<IConstructable>) element)
                .fallbacks();
            boolean hatch = false;
            if (fallbacks != null) {
                for (IStructureElement<IConstructable> f : fallbacks) {
                    hatch = collectChannels(multi, f, byId, unknown, m, depth + 1) || hatch;
                }
            }
            return hatch;
        }
        unknown.add(element);
        return false;
    }

    private static void addChannel(Map<String, List<IStructureElement<IConstructable>>> byId, String channel,
        IStructureElement<IConstructable> element) {
        List<IStructureElement<IConstructable>> l = byId.get(channel);
        if (l == null) {
            l = new ArrayList<IStructureElement<IConstructable>>();
            byId.put(channel, l);
        }
        for (IStructureElement<IConstructable> e : l) {
            if (e == element) return;
        }
        l.add(element);
    }

    /**
     * 从 {@code withChannel} 匿名类里读出通道 id。
     * <p>
     * <b>值校验，不是名字硬编码</b>：StructureLib 由现代 javac + jabel 编译，匿名类捕获字段名是
     * {@code arg$1}/{@code arg$2}…（不是 JDK8 的 {@code val$channel}）；本方法逐个读候选字段，第一个
     * <b>取值落在 StructureLib 通道注册表里</b>的字符串即认定为通道 id。这样对参考实现所在的 JDK8 字节码
     * 与运行时装载的现代字节码都成立，且失败时返回 null（由调用方记为「通道未登记」，不猜）。
     */
    private static String withChannelName(IStructureElement<?> element) {
        for (String name : CAPTURED_STRING_FIELDS) {
            Object v = readField(element, name);
            if (!(v instanceof String)) continue;
            String s = (String) v;
            if (s.isEmpty()) continue;
            if (isRegisteredChannel(s)) return s;
        }
        return null;
    }

    private static boolean isRegisteredChannel(String id) {
        // GTStructureChannels 是编译期可见的权威通道全集（30 条）；StructureLib 注册表可能因为类初始化时机
        // 只填充了一部分（实测主菜单态 26/30），因此两个来源取并集，避免把真通道判成未知。
        if (CHANNEL_ID_SET.contains(id)) return true;
        try {
            return com.gtnewhorizon.structurelib.ChannelDescription.getAll()
                .containsKey(id);
        } catch (Throwable t) {
            return false;
        }
    }

    private static Object readField(Object target, String name) {
        try {
            Field f = findField(target.getClass(), name);
            return f.get(target);
        } catch (Throwable t) {
            return null;
        }
    }

    /** 从 {@code withChannel} 匿名类里取出被包裹的 backing 元素（候选名 + 类型校验）。 */
    @SuppressWarnings("unchecked")
    private static IStructureElement<IConstructable> capturedElement(Object owner) {
        for (String name : CAPTURED_ELEMENT_FIELDS) {
            Object v = readField(owner, name);
            if (v instanceof IStructureElement) return (IStructureElement<IConstructable>) v;
        }
        return null;
    }

    @SuppressWarnings("unchecked")
    private static IStructureElement<IConstructable> lazyResolve(IConstructable multi,
        IStructureElement<IConstructable> element) {
        if (LAZY_GET_METHOD == null) return null;
        try {
            return (IStructureElement<IConstructable>) LAZY_GET_METHOD.invoke(element, multi);
        } catch (Throwable t) {
            return null;
        }
    }

    /** {@code onElementPass} 的内层元素：优先读捕获字段，退化到 {@code val$element}。 */
    private static IStructureElement<IConstructable> onElementPassUnderlying(IStructureElement<IConstructable> e) {
        return capturedElement(e);
    }

    /**
     * 未识别元素的值依赖证明：对 k = 1..N 枚举参照方块集合，若集合随 k 变化，说明该元素读了触发器的某个通道值。
     * <p>
     * 这是 T0.4 R6 的补齐手段：{@code MTETankTFFT} 的 {@code field} 元素<b>没有</b> {@code withChannel} 包裹，
     * 若只做符号遍历就会漏掉 {@code TFFT_FIELD}。
     * <p>
     * <b>本方法刻意不猜通道 id</b>：元素类名（{@code StructureUtility$34} 这类匿名类）在多个通道间完全复用，
     * 仅靠「上界吻合」会张冠李戴（实测把 {@code item_pipe} 认成 {@code chassis}）。因此这里只产出
     * 「元素类名 + 观测上界 + 观测序列」的原始事实，落进 {@code unknownValueDependentElements}，
     * 由人工/T1.3 决定是否需要补映射；唯一例外是元素自己<b>直接持有</b>可读的通道 id（见 {@link #capturedChannelId}）。
     */
    private static void detectValueDependentElement(MachineProbe m, IStructureElement<IConstructable> e,
        Set<String> seenSignatures) {
        String cls = e.getClass()
            .getName();
        int bound = Math.min(MAX_CHANNEL_VALUE, 32);
        List<Set<String>> seq = new ArrayList<Set<String>>();
        for (int k = 1; k <= bound; k++) {
            try {
                seq.add(referenceBlockSet(m, e, k));
            } catch (Throwable t) {
                return;
            }
        }
        // 「值依赖触发器」的证明 + 观测上界（最后一个首次出现的取值）+ 夹取平台
        int lastNew = 1;
        int changes = 0;
        for (int i = 1; i < seq.size(); i++) {
            if (!seq.get(i)
                .equals(seq.get(i - 1))) {
                lastNew = i + 1;
                changes++;
            }
        }
        if (changes == 0) {
            m.skippedNonTieredElements++;
            return; // 值不依赖触发器 → 不是通道元素
        }
        int plateaus = 0;
        for (int i = seq.size() - 1; i > 0 && seq.get(i)
            .equals(seq.get(i - 1)); i--) {
            plateaus++;
        }

        String signature = cls + "|" + lastNew + "|" + summarize(seq, lastNew);
        if (!seenSignatures.add(signature)) return; // 同一元素被多个符号/片段共享，只记一次

        // 唯一可采纳的路径：元素自己持有可读的通道 id（例如自定义元素把通道枚举存成字段）
        String capturedId = capturedChannelId(e);
        if (capturedId != null && !hasChannelId(m, capturedId)) {
            ChannelProbe p = probeOneChannel(
                m,
                capturedId,
                enumNameForId(capturedId),
                e,
                "captured-field(custom-element)");
            p.notes.add("该元素未使用 withChannel 包裹，但自身持有可读的通道 id `" + capturedId + "`（T0.4 R6 型自定义元素）");
            p.unknownElementObservedMax = Integer.valueOf(plateaus >= DOMAIN_PLATEAU ? lastNew : bound);
            m.channels.add(p);
            return;
        }
        if (plateaus < DOMAIN_PLATEAU) {
            m.unknownValueDependentElements
                .add(cls + " [未识别] 观测到值依赖（上界 " + lastNew + "），但 " + bound + " 内未见夹取平台，通道归属与上界未定");
            return;
        }
        m.unknownValueDependentElements.add(
            cls + " [未识别] 观测到值依赖，上界 "
                + lastNew
                + "，且元素自身不持有可读通道 id；观测序列 "
                + summarize(seq, lastNew)
                + "（不猜通道归属；如需归因请补显式映射）");
    }

    private static boolean hasChannelId(MachineProbe m, String id) {
        for (ChannelProbe p : m.channels) {
            if (p.id.equals(id)) return true;
        }
        return false;
    }

    /** 尺寸型通道的登记：取值域来自静态事实表，标 {@code domainSource: source-table}。 */
    private static ChannelProbe dimensionChannelProbe(MachineProbe m, String channelId) {
        ChannelProbe p = new ChannelProbe();
        p.id = channelId;
        p.enumName = enumNameForId(channelId);
        p.kind = "dimension";
        p.discoverySource = "source-table(dimension-read-site)";
        p.domainSource = "source-table";
        p.registryAgreement = "not-applicable";
        int[] mm = dimensionDomain(m.simpleName, channelId);
        if (mm != null) {
            p.min = Integer.valueOf(mm[0]);
            p.max = Integer.valueOf(mm[1] - mm[0] + 1);
            p.observedMax = p.max.intValue();
            p.distinctValues = p.max.intValue();
            p.observedBlockStateCount = p.max.intValue();
            p.plateauReached = true;
            p.notes.add("尺寸型通道不绑定结构符号（.use() 命中数 = 0），只在 construct/survivalConstruct 里被 getValueClamped 读取");
            p.notes.add(
                "getValueClamped(trigger, " + mm[0]
                    + ", "
                    + mm[1]
                    + ")：值 1 → 尺寸 "
                    + mm[0]
                    + "，值 k → 尺寸 min(k-1+"
                    + mm[0]
                    + ", "
                    + mm[1]
                    + ")，故通道值上界 = "
                    + p.max
                    + "（1 基偏移语义，T0.4 §2.3 机制 C）");
        } else {
            p.domainSource = "fallback";
            p.notes.add("尺寸型通道但本机不在 T0.4 §3.5 的静态事实表内：min/max 未确定");
        }
        return p;
    }

    /**
     * 自定义元素直读通道的登记（{@link #CUSTOM_CHANNEL_ELEMENTS}）。
     * <p>
     * 取值域仍然去注册表取（注册表是权威数据源），同时把 {@code getValueClamped} 的 1 基上界一并落盘，
     * 两者都记，不改判。
     */
    private static ChannelProbe customChannelElementProbe(MachineProbe m, String enumName, String id, String sourceNote,
        String elementClassName) {
        ChannelProbe p = new ChannelProbe();
        p.id = id;
        p.enumName = enumName;
        p.kind = kindOfChannelId(enumName, id);
        p.discoverySource = "explicit-map(custom-element)";
        p.elementClass = elementClassName;
        p.domainSource = "source-table";
        p.notes.add("元素 `" + elementClassName + "` 不经 withChannel 包裹、且不实现 getBlocksToPlace，取值域与归属来自显式映射：" + sourceNote);
        applyRegistryCrossCheck(p);
        // 显式映射的取值域：注册表全局并集上界优先；注册表没有登记项时用声明上界
        if (p.registryMaxValue != null && p.registryMaxValue.intValue() > 0) {
            p.max = p.registryMaxValue;
            p.observedMax = p.registryMaxValue.intValue();
            p.domainScope = "global-registry";
            p.notes.add("取值域取注册表全局并集上界 " + p.max);
        } else {
            String[] declared = CUSTOM_CHANNEL_DECLARED_MAX.get(id);
            if (declared != null) {
                p.max = Integer.valueOf(declared[0]);
                p.observedMax = p.max.intValue();
                p.domainScope = "machine";
                p.notes.add("注册表无该通道登记项，取值上界取声明值 " + p.max + "（依据：" + declared[1] + "）");
            } else {
                p.notes.add("注册表里没有该通道的登记项，且无声明上界：取值域未确定（请补 CUSTOM_CHANNEL_DECLARED_MAX）");
            }
        }
        return p;
    }

    /**
     * 同一多方块内「同 id 且同 enumName 且观测数据完全一致」的条目合并（多为同一元素被多个符号共享）。
     * <p>
     * <b>注意不能只按 id 合并</b>：{@code casing} 的三条枚举名同 id 但取值域/枚举名不同，必须各自保留
     * （T0.4 §2.4 的重名消歧要求）。
     */
    private static void dedupeChannels(MachineProbe m) {
        Map<String, ChannelProbe> kept = new LinkedHashMap<String, ChannelProbe>();
        int removed = 0;
        for (ChannelProbe p : m.channels) {
            String key = p.enumName + "|"
                + p.id
                + "|"
                + p.kind
                + "|"
                + p.domainSource
                + "|"
                + p.max
                + "|"
                + p.observed.size()
                + "|"
                + p.discoverySource;
            ChannelProbe first = kept.get(key);
            if (first == null) {
                kept.put(key, p);
            } else {
                removed++;
                first.duplicateElementCount++;
            }
        }
        if (removed > 0) {
            m.channels.clear();
            m.channels.addAll(kept.values());
            for (ChannelProbe p : m.channels) {
                if (p.duplicateElementCount > 0) {
                    p.notes.add("该条目由 " + (p.duplicateElementCount + 1) + " 个观测完全一致的元素条目合并（同一元素被多个符号/结构片段共享）");
                }
            }
        }
    }

    /**
     * 元素自身是否持有可读的通道 id：候选字段取值落在注册表里，且该 id 尚未被本机其它元素占用。
     * <p>
     * 这是「不靠 withChannel 包裹」的通道元素的正解：只有当元素<b>真的存了</b>通道 id 才认，绝不按上界猜。
     */
    private static String capturedChannelId(IStructureElement<?> e) {
        for (String name : CAPTURED_STRING_FIELDS) {
            Object v = readField(e, name);
            if (v instanceof String && isRegisteredChannel((String) v)) return (String) v;
        }
        return null;
    }

    private static String summarize(List<Set<String>> seq, int lastNew) {
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < seq.size() && i < lastNew + 1; i++) {
            if (i > 0) sb.append(" | ");
            sb.append(i + 1)
                .append("→")
                .append(seq.get(i));
        }
        return sb.toString();
    }

    private static String enumNameForId(String id) {
        List<String> names = enumNamesForId(id);
        return names.isEmpty() ? "UNKNOWN_" + id.toUpperCase(Locale.ROOT) : names.get(0);
    }

    /**
     * 分配一个 id 下的元素到具体通道。{@code casing} 这类重名 id：本机可能只用了其中一条 ——
     * 三条共用同一个 {@code ChannelDescription} 实例与同一张值表，因此取值域相同；本方法按枚举名顺序并列输出
     * （每条都标 {@code ambiguous-id}），不编造归属。
     */
    private static void assignChannels(MachineProbe m, String id, List<IStructureElement<IConstructable>> elements) {
        if (elements.isEmpty()) return;
        List<String> enumNames = enumNamesForId(id);
        if (enumNames.isEmpty()) enumNames = Collections.singletonList("UNKNOWN_" + id.toUpperCase(Locale.ROOT));

        for (int i = 0; i < elements.size(); i++) {
            ChannelProbe p = probeOneChannel(
                m,
                id,
                enumNames.get(Math.min(i, enumNames.size() - 1)),
                elements.get(i),
                "element-scan");
            if (enumNames.size() > 1) {
                p.notes.add(
                    "id `" + id
                        + "` 在 GTStructureChannels 里有 "
                        + enumNames.size()
                        + " 个枚举名（"
                        + join(enumNames)
                        + "），三者共用同一个 ChannelDescription 值表；本机该 id 下共有 "
                        + elements.size()
                        + " 个互不相同的元素，本条按出现顺序落在枚举名。"
                        + p.enumName
                        + "（跨机器引用时以 {enumName,id} 双键为准）");
            }
            m.channels.add(p);
        }
    }

    private static String join(List<String> l) {
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < l.size(); i++) {
            if (i > 0) sb.append(", ");
            sb.append(l.get(i));
        }
        return sb.toString();
    }

    /** 对单个元素探测某通道的取值域：值 1..MAX 逐个注入触发器，记录参照方块集合的变化。 */
    private static ChannelProbe probeOneChannel(MachineProbe m, String id, String enumName,
        IStructureElement<IConstructable> element, String discoverySource) {
        ChannelProbe p = new ChannelProbe();
        p.id = id;
        p.enumName = enumName;
        p.kind = kindOfChannelId(enumName, id);
        p.discoverySource = discoverySource;
        p.elementClass = element.getClass()
            .getName();

        if ("hatch".equals(p.kind)) {
            p.domainSource = "declared-boolean";
            p.registryAgreement = "not-applicable";
            p.notes.add("布尔开关型通道，无整数取值域");
            return p;
        }
        if ("dimension".equals(p.kind)) {
            int[] mm = dimensionDomain(m.simpleName, id);
            if (mm != null) {
                p.min = Integer.valueOf(mm[0]);
                p.max = Integer.valueOf(mm[1] - mm[0] + 1);
                p.observedMax = p.max.intValue();
                p.distinctValues = p.max.intValue();
                p.plateauReached = true;
                p.domainSource = "source-table";
                p.registryAgreement = "not-applicable";
                p.notes.add(
                    "尺寸型通道 getValueClamped(trigger, " + mm[0]
                        + ", "
                        + mm[1]
                        + ")：值 1 → 尺寸 "
                        + mm[0]
                        + "，值 k → 尺寸 min(k-1+"
                        + mm[0]
                        + ", "
                        + mm[1]
                        + ")，故通道值上界 = "
                        + p.max
                        + "（1 基偏移语义，T0.4 §2.3 机制 C）");
            } else {
                p.domainSource = "fallback";
                p.notes.add("尺寸型通道但本机不在 T0.4 §3.5 的静态事实表内：min/max 未确定");
            }
            return p;
        }

        List<Set<String>> seq = new ArrayList<Set<String>>();
        boolean plateau = false;
        for (int k = 1; k <= MAX_CHANNEL_VALUE; k++) {
            Set<String> sig = null;
            try {
                sig = referenceBlockSet(m, element, k);
            } catch (Throwable t) {
                p.notes.add(
                    "取值 " + k
                        + " 上 getBlocksToPlace 抛出: "
                        + t.getClass()
                            .getSimpleName());
            }
            seq.add(sig);
            ChannelObservedValue ov = new ChannelObservedValue();
            ov.value = k;
            ov.blocksKey = sig == null ? "<null>" : sig.toString();
            ov.blockCount = sig == null ? 0 : sig.size();
            p.observed.add(ov);
            if (k >= DOMAIN_PLATEAU) {
                if (eq(seq.get(k - 2), sig) && eq(seq.get(k - 3), sig)) {
                    plateau = true;
                    break;
                }
            }
        }
        p.observedMax = p.observed.size();
        p.plateauReached = plateau;
        Set<String> distinct = new LinkedHashSet<String>();
        for (Set<String> s : seq) {
            distinct.add(s == null ? "<null>" : s.toString());
        }
        p.observedBlockStateCount = distinct.size();
        p.distinctValues = p.observedBlockStateCount;

        if (plateau) {
            int lastNew = 1;
            for (int i = 1; i < seq.size(); i++) {
                if (!eq(seq.get(i), seq.get(i - 1))) lastNew = i + 1;
            }
            p.max = Integer.valueOf(lastNew);
            p.domainSource = "probed";
            // 提示列表尾部是否含重复项：末尾已进入夹取平台、但平台起点仍 > 最后一个新档位
            p.hintListHasTrailingRepeat = p.observedMax > lastNew;
            if (p.hintListHasTrailingRepeat) {
                p.notes.add(
                    "提示列表（allKnownTiers）长度为 " + p.observedMax
                        + "，但最后一个「新档位」是 "
                        + lastNew
                        + "：第 "
                        + (lastNew + 1)
                        + ".."
                        + p.observedMax
                        + " 项与第 "
                        + lastNew
                        + " 项指向同一方块状态（列表尾部有重复项）。T1.3 构造变体时两者得到相同几何，但作为<b>滑杆刻度</b>口径不同");
            }
        } else {
            p.max = Integer.valueOf(p.observedMax);
            p.domainSource = "fallback";
            p.notes.add("取值 1.." + p.observedMax + " 内参照方块集合仍在变化，未观测到夹取平台；上界标 fallback（硬上限 " + MAX_CHANNEL_VALUE + "）");
        }
        applyRegistryCrossCheck(p);
        if (p.observedBlockStateCount <= 1) {
            // 元素对该通道的读取在本探测路径上不可观测（例如自定义元素把通道值用于「已放置方块计数」判定，
            // 探测时世界为空 → 值恒为某常量）。此时<b>回落到注册表</b>（权威数据源），并标明来源。
            int probedRange = p.observedMax;
            p.domainSource = "fallback";
            if (p.registryMaxValue != null && p.registryMaxValue.intValue() > 0) {
                p.max = p.registryMaxValue;
                p.observedMax = p.registryMaxValue.intValue();
                p.domainScope = "global-registry";
                p.domainSource = "fallback(registry)";
                p.notes
                    .add("本元素在通道 1.." + probedRange + " 上给出同一参照方块集合（该元素的通道读取在本探测路径不可观测）；" + "取值域回落到注册表全局上界 " + p.max);
            } else {
                p.max = Integer.valueOf(0);
                p.notes.add("该元素在本通道全部取值下给出同一参照方块集合，且注册表无登记项：取值域未确定");
            }
        }
        return p;
    }

    private static boolean eq(Set<String> a, Set<String> b) {
        if (a == null || b == null) return a == b;
        return a.equals(b);
    }

    /** 用通道注册表交叉核对：不改判，只标 {@code registryAgreement}。 */
    private static void applyRegistryCrossCheck(ChannelProbe p) {
        try {
            com.gtnewhorizon.structurelib.ChannelDescription d = channelRegistry().get(p.id);
            if (d == null) {
                p.registryAgreement = "no-registry-entry";
                return;
            }
            p.registryItemCount = Integer.valueOf(
                d.getItems()
                    .size());
            int maxValue = 0;
            for (Integer v : d.getItems()
                .values()) {
                if (v != null && v.intValue() > maxValue) maxValue = v.intValue();
            }
            p.registryMaxValue = Integer.valueOf(maxValue);
            if ("dimension".equals(p.kind) || "hatch".equals(p.kind)) {
                p.registryAgreement = "not-applicable";
            } else if (p.max == null || p.max.intValue() == 0 || maxValue == 0) {
                p.registryAgreement = "registry-empty";
            } else if (maxValue == p.max.intValue()) {
                p.registryAgreement = "match";
            } else if (maxValue > p.max.intValue()) {
                // 注册表是所有机器共用的<b>全局并集</b>（同一张 ChannelDescription#items），
                // 本机只用其中一段是正常现象。只有本机上界大于全局上界才是真异常。
                p.registryAgreement = "machine-subset";
                p.notes.add(
                    "本机可用取值 1.." + p.max
                        + " 是注册表全局并集 1.."
                        + maxValue
                        + "（"
                        + d.getItems()
                            .size()
                        + " 个登记项）的子集");
            } else {
                p.registryAgreement = "machine-exceeds-registry";
                p.notes.add(
                    "本机探测上界 " + p.max
                        + " 大于注册表 "
                        + p.id
                        + " 的最大登记值 "
                        + maxValue
                        + "（注册表条目 "
                        + d.getItems()
                            .size()
                        + " 个）——需要复核探测口径或注册表是否缺登记");
            }
        } catch (Throwable t) {
            p.registryAgreement = "registry-error:" + t.getClass()
                .getSimpleName();
        }
    }

    /**
     * 以「注入值 k」取参照方块集合的指纹。
     * <p>
     * 关键语义（T0.4 §2.3.1 第 2 条）：通道键缺失时 {@code ChannelDataAccessor#getChannelData} 回落到
     * {@code masterStack.stackSize}，所以<b>把 stackSize 置为 k 即等价于「该通道 = k」</b>，无需真写 NBT 子通道；
     * 对自定义元素直读通道（如 {@code MTETankTFFT} 的 field 元素）同样成立。
     * <p>
     * 这是「探测取值域」路径；T1.3 构造变体必须走 {@code placeBlock}/{@code spawnHint}（T0.4 R4）。
     */
    public static Set<String> referenceBlockSet(MachineProbe m, IStructureElement<IConstructable> element, int k) {
        ItemStack trigger = new ItemStack(StructureLibAPI.getDefaultHologramItem(), k);
        IStructureElement.BlocksToPlace btp = element
            .getBlocksToPlace(m.probeContext, m.probeWorld, 0, 0, 0, trigger, PROBE_ENV);
        Set<String> out = new LinkedHashSet<String>();
        if (btp == null) return out;
        Iterable<ItemStack> stacks = btp.getStacks();
        if (stacks == null) return out;
        for (ItemStack s : stacks) {
            if (s == null || s.getItem() == null) continue;
            out.add(
                net.minecraft.item.Item.getIdFromItem(s.getItem()) + ":"
                    + s.getItemDamage()
                    + (s.stackSize > 1 ? "x" + s.stackSize : ""));
        }
        return out;
    }

    static String describe(Throwable t) {
        return t.getClass()
            .getName() + ": "
            + t.getMessage();
    }

    static Failure failureOf(Throwable t, String fqcn, String stage) {
        Failure f = new Failure();
        f.fqcn = fqcn;
        f.stage = stage;
        f.exception = t.getClass()
            .getName();
        f.message = String.valueOf(t.getMessage());
        StackTraceElement[] st = t.getStackTrace();
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < Math.min(st.length, 8); i++) {
            if (i > 0) sb.append(" <- ");
            sb.append(st[i].toString());
        }
        f.stackTraceHead = sb.toString();
        return f;
    }
}
