package com.lightning.mod.client.controlplane.mc;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Locale;

import net.minecraftforge.fluids.Fluid;
import net.minecraftforge.fluids.FluidRegistry;
import net.minecraftforge.fluids.FluidStack;

import com.lightning.mod.client.controlplane.core.CpException;
import com.lightning.mod.client.controlplane.core.ErrorCodes;

/**
 * 流体名的权威解析（{@code scene.tank.fill} 的 {@code fluid} 参数）：Forge 注册表 + GT 材料表两条路。
 *
 * <h2>为什么需要两条路（实机事实，不是设计偏好）</h2>
 * <ol>
 * <li><b>Forge 注册名</b>（{@code FluidRegistry}）是流体的<b>权威身份</b>——{@code FluidStack} 里装的
 * 就是它，原版/模组的一切流体交互都认它。GT 的材料流体按
 * {@code GTFluidFactory.builder(aMaterial.mName.toLowerCase(Locale.ENGLISH))} 注册
 * （GT5U {@code common/GTProxy.java:2219}，运行期 5.09.52.283 同构），
 * 因此盐酸的注册名是 <b>{@code hydrochloricacid_gt5u}</b>——带 {@code _gt5u} 后缀，
 * 因为材料名本身是 {@code HydrochloricAcid_GT5U}
 * （{@code loaders/materials/MaterialsInit.java:8215}，用来避开 IC2 的同名材料）。</li>
 * <li><b>GT 材料名</b>（{@code Materials.HydrochloricAcid}）是<b>人写用例时唯一自然会写的名字</b>。
 * 要求用例写 {@code hydrochloricacid_gt5u} 等于把 GT 的内部命名泄露给调用方，而该后缀是 GT 的
 * 实现细节（历史上带后缀的正是那些与别模组撞名的材料）。</li>
 * </ol>
 * 故本类<b>两条都接受</b>：先按 Forge 注册名精确命中，再按「规范化 + 去 {@code gt5u} 后缀」匹配注册名，
 * 最后经 GT 自己的 {@code Materials.get(name).getFluid(1)} 取（模组权威路径，不拼任何名字）。
 *
 * <h2>只返回注册表里真实存在的 {@link Fluid}</h2>
 * 绝不由材料名现造一个 {@link Fluid}：那会造出一个「名字对但从未注册」的流体，注入必然失败，
 * 而失败会伪装成「机器不收这个流体」。查不到就 {@code CP-VALID-002}，并把已注册名样本带进
 * {@code context}（与 {@link ModReflect} 族、{@link GtItemList#hint} 同一「查不到必须可自救」口径）。
 */
public final class GtFluids {

    /** GT 材料表类（{@code Materials} 是 GT 的公开面；缺席时本类只走 Forge 注册表）。 */
    static final String GT_MATERIALS_CLASS = "gregtech.api.enums.Materials";

    /** 错误上下文里最多列出的已注册流体名条数（防错误响应被上千个模组流体灌爆）。 */
    static final int MAX_LISTED = 40;

    /** GT 材料名的后缀（{@code HydrochloricAcid_GT5U}）；匹配时剥掉，用于「写自然名也能命中」。 */
    static final String GT5U_SUFFIX = "_gt5u";

    private GtFluids() {}

    /**
     * 解析流体名（<b>纯名称解析，不碰世界</b>）。
     *
     * @param raw   调用方给的流体名（注册名或 GT 材料名，大小写不敏感、可带分隔符差异）
     * @param field 参数路径（错误上下文用）
     * @return 已注册的 {@link Fluid}（非 null）
     * @throws CpException {@code CP-VALID-002}：名字为空 / 查不到（context 带已注册名样本）
     */
    public static Fluid resolve(String raw, String field) {
        String s = raw == null ? "" : raw.trim();
        if (s.isEmpty()) {
            throw CpException.param("流体名为空", field, "须为 Forge 流体注册名或 GT 材料名（如 HydrochloricAcid）");
        }
        // 1) Forge 注册名精确命中（最快路径，也是原版写法）
        Fluid direct = FluidRegistry.getFluid(s);
        if (direct != null) {
            return direct;
        }
        // 2) 规范化匹配（大小写 / 分隔符 / gt5u 后缀差异）
        String want = normalize(s);
        List<String> hits = new ArrayList<String>();
        for (String key : FluidRegistry.getRegisteredFluids()
            .keySet()) {
            if (key != null && normalize(key).equals(want)) {
                hits.add(key);
            }
        }
        if (hits.size() == 1) {
            Fluid f = FluidRegistry.getFluid(hits.get(0));
            if (f != null) {
                return f;
            }
        }
        if (hits.size() > 1) {
            Collections.sort(hits);
            throw CpException.param("流体名有歧义", field, "规范化后匹配到多个注册名: " + hits + "（请用其中之一的完整写法）");
        }
        // 3) GT 材料表（模组权威路径）：Materials.get(name).getFluid(1).getFluid()
        Fluid byMaterial = byMaterial(s);
        if (byMaterial != null) {
            return byMaterial;
        }
        throw CpException.param(
            "未知流体",
            field,
            "Forge 流体注册表与 GT 材料表里都没有: " + raw
                + "（GT 材料流体按材料名小写注册，如盐酸 = hydrochloricacid_gt5u；本实例已注册样本: "
                + sample()
                + "）");
    }

    /**
     * 按 GT 材料名取流体（经 GT 自己的 {@code Materials} + {@code getFluid}）。
     *
     * <p>
     * 三种写法都试：原样、{@code +"_GT5U"}、以及材料表键的规范化匹配（剥 {@code gt5u} 后缀）。
     * 全反射：GT 是 {@code compileOnly} 依赖、整合包里可以缺，硬 import 会在类加载期抛
     * {@link NoClassDefFoundError}（见 {@link ModReflect} 的类注释）。
     *
     * @return 已注册流体；GT 缺席、材料不存在、或该材料没有对应流体时返回 null
     */
    static Fluid byMaterial(String name) {
        Class<?> materials = ModReflect.cls(GT_MATERIALS_CLASS);
        if (materials == null) {
            return null;
        }
        Object material = materialByName(materials, name);
        if (material == null) {
            return null;
        }
        // Materials.getFluid(long) 对没有流体的材料返回 null（Materials.java:2017-2020）
        Object stack = ModReflect.call(material, "getFluid", new Class<?>[] { long.class }, Long.valueOf(1L));
        if (!(stack instanceof FluidStack)) {
            return null;
        }
        Fluid f = ((FluidStack) stack).getFluid();
        return f != null && FluidRegistry.getFluidName(f) != null ? f : null;
    }

    /** 材料表里找材料：原样 → {@code _GT5U} → 规范化（含剥 {@code gt5u} 后缀）；找不到返回 null。 */
    private static Object materialByName(Class<?> materials, String name) {
        Object m = lookupMaterial(materials, name);
        if (m != null) {
            return m;
        }
        m = lookupMaterial(materials, name + "_GT5U");
        if (m != null) {
            return m;
        }
        Object map = ModReflect.callStatic(materials, "getMaterialsMap", new Class<?>[0]);
        if (!(map instanceof java.util.Map)) {
            return null;
        }
        String want = normalize(name);
        Object hit = null;
        for (Object entryObj : ((java.util.Map<?, ?>) map).entrySet()) {
            java.util.Map.Entry<?, ?> e = (java.util.Map.Entry<?, ?>) entryObj;
            String key = e.getKey() == null ? null : String.valueOf(e.getKey());
            if (key == null || !normalize(key).equals(want)) {
                continue;
            }
            if (hit != null) {
                return null; // 歧义：宁可回落到「查不到」也不要猜一个
            }
            hit = e.getValue();
        }
        return hit;
    }

    /** {@code Materials.get(String)}；GT 版本不符（无该方法）时返回 null。 */
    private static Object lookupMaterial(Class<?> materials, String name) {
        Object v = ModReflect.callStatic(materials, "get", new Class<?>[] { String.class }, name);
        return v == null || "null".equals(String.valueOf(v)) ? null : v;
    }

    // ------------------------------------------------------------ 规范化与样本

    /**
     * 匹配用的规范形：小写、去 {@code minecraft:} 前缀、剥末尾的 {@code _GT5U} 后缀、
     * 再去掉 {@code _ - . :} 与空白。
     *
     * <p>
     * 于是 {@code hydrochloricacid_gt5u}、{@code HydrochloricAcid}、{@code Hydrochloric Acid}
     * 三者都归一到 {@code hydrochloricacid}。
     *
     * <p>
     * <b>剥后缀必须先于去分隔符</b>：GT 的后缀字面量是 <b>{@code _GT5U}</b>（含下划线，
     * {@code MaterialsInit.java:8215} 的 {@code setName("HydrochloricAcid_GT5U")}），
     * 因此判据是「末尾是 {@code _gt5u}」而不是「末尾是 {@code gt5u}」。差别在
     * {@code xgt5u} 这类名字上：前者不动它，后者会把它削成 {@code x}——
     * 而削多了会让两个本来不同的流体撞成一个键（虽然后续会报歧义，但那已经是误报）。
     *
     * <p>
     * 去 {@code minecraft:} 前缀是沿用 #99 的既有宽容口径（{@code RegistryNames.normalize}）：
     * 现代写法 {@code minecraft:water} 与原版写法 {@code water} 都该能用。
     *
     * <p>
     * {@code public} 而非包私有：{@link GtStacks} 的材料名匹配与
     * {@code mc.scene.TankFillFamilyTest} 的离线断言都依赖<b>同一个</b>规范化口径。
     * 两份实现会让「用例写自然名能命中」这条保证在两条路上分叉。
     */
    public static String normalize(String s) {
        if (s == null) {
            return "";
        }
        String v = s.trim()
            .toLowerCase(Locale.ROOT);
        if (v.startsWith("minecraft:")) {
            v = v.substring("minecraft:".length());
        }
        if (v.endsWith(GT5U_SUFFIX)) {
            v = v.substring(0, v.length() - GT5U_SUFFIX.length());
        }
        StringBuilder sb = new StringBuilder(v.length());
        for (int i = 0; i < v.length(); i++) {
            char c = v.charAt(i);
            if (c == '_' || c == '-' || c == '.' || c == ':' || Character.isWhitespace(c)) {
                continue;
            }
            sb.append(c);
        }
        return sb.toString();
    }

    /** 已注册流体名样本（排序、截断），供错误上下文用。 */
    static String sample() {
        List<String> all = new ArrayList<String>();
        for (String k : FluidRegistry.getRegisteredFluids()
            .keySet()) {
            if (k != null && !k.isEmpty()) {
                all.add(k);
            }
        }
        Collections.sort(all);
        int total = all.size();
        List<String> head = total > MAX_LISTED ? all.subList(0, MAX_LISTED) : all;
        return head + (total > MAX_LISTED ? " …共 " + total + " 个" : "");
    }

    /**
     * 流体摘要（读回/留痕用）：注册名 + 本地化名 + 温度 + 气态。
     *
     * <p>
     * 注册名取 {@code FluidRegistry.getFluidName}——那是 Forge 的权威身份，也是调用方下次
     * 调本动作时该写的字符串；{@link Fluid#getName()} 在部分模组流体上是同一值，但注册表才是权威。
     */
    public static String registryName(Fluid fluid) {
        if (fluid == null) {
            return null;
        }
        String n = FluidRegistry.getFluidName(fluid);
        return n != null ? n : fluid.getName();
    }

    /**
     * 注入前的「流体是否已知」自检：GT 缺席时也要能回答「这个名字在不在 Forge 注册表里」。
     *
     * @return 注册名；不在注册表里返回 null
     */
    public static String knownRegistryName(String raw) {
        try {
            return registryName(resolve(raw, "fluid"));
        } catch (CpException e) {
            return null;
        }
    }

    /** GT 材料表是否在运行期 classpath 上（诊断用）。 */
    public static boolean materialsAvailable() {
        return ModReflect.cls(GT_MATERIALS_CLASS) != null;
    }

    /** 供错误上下文用的一条环境说明（GT 缺席时调用方要知道「材料名这条路没走」）。 */
    public static String absenceReason() {
        return materialsAvailable() ? null : "GT 材料表不在运行期 classpath 上（缺 " + GT_MATERIALS_CLASS + "），本次只按 Forge 注册名解析";
    }

    /** 未使用但保留：错误码引用，确认本类只抛参数类错误。 */
    static String paramCode() {
        return ErrorCodes.VALID_PARAM;
    }
}
