package com.lightning.mod.client.controlplane.mc;

import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * 模组族（LP / AE2 / GT）的补全器与描述器注册（contract.md §10 第 6 条的注册表：
 * {@code vanilla} / {@code lp-pipe} / {@code ae2-part} / {@code gt-machine}）。
 *
 * <h2>不装模组也不能炸（类引用隔离）</h2>
 * 本类是控制面唯一「探测模组在不在」的地方：
 * <ul>
 * <li>各族的补全器/描述器代码<b>一律经 {@link ModReflect} 反射</b>触达模组类型——LP 在本树只有
 * {@code runtimeOnlyNonPublishable}（编译期根本没有 LP 类型可 import），AE2 与 GT 虽是
 * {@code compileOnly} 但整合包里可以缺，硬 import 会在类加载期抛 {@code NoClassDefFoundError}，
 * 连控制面自身都起不来；</li>
 * <li>{@link #registerAll()} 先用 {@link ModReflect#allPresent} 探测，缺席就<b>跳过注册</b>并把原因记进
 * {@link #absences()}，同时打一条 WARN——注册动作本身永远成功；</li>
 * <li>缺席族的用例（{@code "completer":"lp-pipe"}）在 {@link SceneBuilder} 的 te 步上得到
 * {@code CP-VALID-002}，{@code context.fields} 里直接写着「LP 不在运行期 classpath 上」这类原因，
 * 不必翻日志。</li>
 * </ul>
 *
 * <h2>为什么在启动时注册而不是用时再探</h2>
 * 契约 §10 第 6 条的注册表是<b>可自描述的</b>：{@code case.validate} 的报错、{@code GET /cp/v1/actions} 的
 * 说明都要能说出「有哪些族可用」。注册表在控制面装配完成时就定格，观测到的东西才不会随第一次调用变化。
 * 探测成本是一次 {@code Class.forName}（不初始化），可忽略。
 */
public final class ModTeFamilies {

    /** LP 可用性判定所需的类（缺任何一个都视为「LP 不可用」）。 */
    private static final String[] LP_CLASSES = { LpPipeCompleter.LP_BLOCK_CLASS, LpPipeCompleter.LP_TILE_CLASS,
        LpPipeCompleter.LP_FACADE_CLASS };

    /** AE2 可用性判定所需的类。 */
    private static final String[] AE2_CLASSES = { Ae2PartCompleter.IPART_HOST_CLASS,
        Ae2PartCompleter.TILE_CABLE_BUS_CLASS, Ae2PartCompleter.PART_PLACEMENT_CLASS };

    /**
     * GT 可用性判定所需的类。
     *
     * <p>
     * 只要这四个到齐，「GT 机器放置通道」就可用：{@code ItemMachines} 是放置路径宿主，
     * {@code BlockMachines} 是方块身份判据，{@code IGregTechTileEntity} 是「有没有 MetaTileEntity」
     * 的判据，{@code ItemList} 是「按常量名取机器/电池」的清单入口。
     */
    private static final String[] GT_CLASSES = { GtMachineCompleter.GT_ITEM_MACHINES_CLASS,
        GtMachineCompleter.GT_BLOCK_MACHINES_CLASS, GtMachineCompleter.GT_TILE_INTERFACE, GtItemList.ITEM_LIST_CLASS };

    private static final Map<String, String> ABSENCES = new LinkedHashMap<String, String>();
    private static volatile boolean registered;

    private ModTeFamilies() {}

    /**
     * 注册全部模组族（幂等）。
     *
     * <p>
     * 由 {@link ControlPlaneBootstrap#start} 在控制面装配时调用；{@link SceneBuilder} 构造时也会调一次
     * （防御性：任何走场景构建的入口——{@code world.rebuild} 的 build 段、{@code case.run}——都保证
     * 注册表就位）。
     */
    public static synchronized void registerAll() {
        if (registered) {
            return;
        }
        registered = true;
        registerLp();
        registerAe2();
        registerGt();
        CpLog.info(
            "TE 补全器族：%s；描述器族：%s%s",
            TeCompleters.names(),
            TeDescribers.names(),
            ABSENCES.isEmpty() ? "" : "（缺席 " + ABSENCES.keySet() + "）");
    }

    /** 已注册的族名（补全器与描述器的交集，即「既能放又能读」的族）。 */
    public static java.util.List<String> registeredFamilies() {
        registerAll();
        return TeCompleters.names();
    }

    /** 缺席族的族名 → 原因（只读视图）。 */
    public static synchronized Map<String, String> absences() {
        registerAll();
        return Collections.unmodifiableMap(new LinkedHashMap<String, String>(ABSENCES));
    }

    /** 某族缺席的原因；在场或从未探测返回 null。 */
    public static synchronized String absenceOf(String family) {
        registerAll();
        return family == null ? null : ABSENCES.get(family);
    }

    /** 是否已注册（诊断用）。 */
    public static boolean isRegistered() {
        return registered;
    }

    // ------------------------------------------------------------ 各族

    private static void registerLp() {
        if (!ModReflect.allPresent(LP_CLASSES)) {
            String reason = "LogisticsPipes 不在运行期 classpath 上（缺 " + firstMissing(LP_CLASSES)
                + "）"
                + modLoadedHint("LogisticsPipes")
                + "：lp-pipe 族未注册";
            ABSENCES.put(LpPipeCompleter.NAME, reason);
            CpLog.warn("控制面：%s", reason);
            return;
        }
        TeCompleters.register(new LpPipeCompleter());
        TeDescribers.register(new LpPipeDescriber());
    }

    private static void registerAe2() {
        if (!ModReflect.allPresent(AE2_CLASSES)) {
            String reason = "Applied Energistics 2 不在运行期 classpath 上（缺 " + firstMissing(AE2_CLASSES)
                + "）"
                + modLoadedHint("appliedenergistics2")
                + "：ae2-part 族未注册";
            ABSENCES.put(Ae2PartCompleter.NAME, reason);
            CpLog.warn("控制面：%s", reason);
            return;
        }
        TeCompleters.register(new Ae2PartCompleter());
        TeDescribers.register(new Ae2PartDescriber());
    }

    /**
     * GT 族（{@code gt-machine}）。
     *
     * <p>
     * 补全器走 GT 自己的机器放置路径（{@link GtMachineCompleter}），描述器读回
     * {@code getMetaTileID()}/{@code getMetaTileEntity()}——这两件事必须同族注册：
     * 场景清单的哈希对「空壳 vs 真机器」是盲的，只有描述器能分辨（见 {@link GtMachineDescriber}
     * 的类注释）。
     */
    private static void registerGt() {
        if (!ModReflect.allPresent(GT_CLASSES)) {
            String reason = "GregTech (GT5-Unofficial) 不在运行期 classpath 上（缺 " + firstMissing(GT_CLASSES)
                + "）"
                + modLoadedHint("gregtech")
                + "：gt-machine 族未注册";
            ABSENCES.put(GtMachineCompleter.NAME, reason);
            CpLog.warn("控制面：%s", reason);
            return;
        }
        TeCompleters.register(new GtMachineCompleter());
        TeDescribers.register(new GtMachineDescriber());
    }

    /**
     * 缺席原因里补一句 FML 侧的看法。
     *
     * <p>
     * 区分两种截然不同的缺席：整合包<b>根本没装</b>（FML 也说没加载——用例作者该改用例）vs
     * <b>装了但类加载器看不到</b>（FML 说加载了——这是环境问题，该查 classpath）。少了这句话，
     * 两种情况在日志里长得一模一样。
     */
    private static String modLoadedHint(String modId) {
        try {
            return cpw.mods.fml.common.Loader.isModLoaded(modId) ? "，但 FML 报告该 mod 已加载（类加载器差异？）" : "，FML 也未加载该 mod";
        } catch (Throwable t) {
            return "";
        }
    }

    private static String firstMissing(String[] classes) {
        for (String c : classes) {
            if (!ModReflect.isPresent(c)) {
                return c;
            }
        }
        return classes.length == 0 ? "?" : classes[0];
    }
}
