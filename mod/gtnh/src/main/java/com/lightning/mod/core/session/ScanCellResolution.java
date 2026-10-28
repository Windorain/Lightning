package com.lightning.mod.core.session;

import java.util.Locale;

/**
 * 「这一格该不该保留、用什么身份渲染」的<b>纯判定</b>。
 *
 * <h2>它替代了什么</h2>
 *
 * 改造前 {@code MeshCaptureService.finalizeSingleStructure} 逐格用
 * {@code world.getBlock(wx,wy,wz)} 回查<b>活动世界</b>，空气即 {@code remapped=0} —— 世界在录制之后被改动
 * 就会把块<b>静默丢掉</b>（不报错、不告警、不进 context）。本判定把「保留哪些格、用什么身份」交还给
 * <b>扫描身份</b>（{@code cellTypes[ti]} 的 {@code registryId}/{@code meta}/{@code tileNbt}）：
 *
 * <table>
 * <caption>判定表</caption>
 * <tr>
 * <td>{@link Verdict#SCAN_AIR}</td>
 * <td>扫描身份就是空气 ⇒ 没有可保留的内容（这<b>不是</b>丢块）</td>
 * </tr>
 * <tr>
 * <td>{@link Verdict#KEEP_SCAN_IDENTITY}</td>
 * <td>活动世界该坐标是空气（世界被改动）或与扫描同块
 * ⇒ <b>按扫描身份保留</b>；「扫描有块、活动世界是空气」必须走这条，绝不允许静默消失</td>
 * </tr>
 * <tr>
 * <td>{@link Verdict#SCAN_UNRESOLVED}</td>
 * <td>扫描身份认不出来（方块已不在注册表里）⇒ 显式报错</td>
 * </tr>
 * <tr>
 * <td>{@link Verdict#WORLD_MISMATCH}</td>
 * <td>活动世界该坐标是<b>另一个非空气方块</b> ⇒ 显式报错
 * （不许静默丢、也不许静默换块）</td>
 * </tr>
 * </table>
 *
 * <h2>为什么 air 归「保留」而「另一个方块」归「报错」</h2>
 *
 * 空气不是「另一个身份」，而是「该格已不存在」：它没有任何可比对的身份，把它当冲突处理或当丢块处理
 * 都会重新引入该失真（产物随导出时刻的世界变化）。而两个<b>不同的非空气方块</b>是真正的身份冲突
 * ——此时「该按谁渲染」没有唯一正确答案，按扫描渲染就是静默换块、按世界渲染就是静默失真，故显式报错。
 *
 * <h2>纯度</h2>
 *
 * 本类不 import 任何 {@code net.minecraft.*}，也不读任何静态实例：输入是字符串与布尔，输出是枚举。
 * 因此「扫描=A方块/活动世界=空气 ⇒ 不得静默消失」这类判据可以在纯 JVM 下逐行锁死
 * （见 {@code ScanCellResolutionTest}）。渲染仍可用活动 world 实例（RenderBlocks/TE/贴图需要），
 * 但「保留哪些格、用什么身份」只来自本判定。
 */
public final class ScanCellResolution {

    /** 判定结果。 */
    public enum Verdict {
        /** 扫描身份即空气：该格无内容可保留。 */
        SCAN_AIR,
        /** 按扫描身份保留（活动世界是空气，或与扫描同块）。 */
        KEEP_SCAN_IDENTITY,
        /** 扫描身份无法解析（方块不在注册表里）⇒ 调用方必须显式报错。 */
        SCAN_UNRESOLVED,
        /** 活动世界该坐标是另一个非空气方块 ⇒ 调用方必须显式报错。 */
        WORLD_MISMATCH
    }

    private ScanCellResolution() {}

    /**
     * 判定单格。
     *
     * @param scanRegistryId 扫描身份里的方块注册名（{@code cellTypes[ti].registryId}；可能为 null）
     * @param scanResolvable 扫描身份能否解析成方块（{@code Block.getBlockFromName} 非 null 且非空气）
     * @param liveIsAir      活动世界该坐标是否为空气
     * @param liveRegistryId 活动世界该坐标的方块注册名（{@code liveIsAir} 为 true 时可传 null）
     */
    public static Verdict decide(String scanRegistryId, boolean scanResolvable, boolean liveIsAir,
        String liveRegistryId) {
        if (isAirIdentity(scanRegistryId)) {
            return Verdict.SCAN_AIR;
        }
        if (!scanResolvable) {
            return Verdict.SCAN_UNRESOLVED;
        }
        if (liveIsAir) {
            // 世界在录制之后被改动（该格被清空）：按扫描身份保留 —— 这是「不许静默丢块」的落点
            return Verdict.KEEP_SCAN_IDENTITY;
        }
        if (sameIdentity(scanRegistryId, liveRegistryId)) {
            return Verdict.KEEP_SCAN_IDENTITY;
        }
        return Verdict.WORLD_MISMATCH;
    }

    /** 注册名是否表示空气（采样器对空气写的是字面量 {@code "air"}；{@code minecraft:air} 一并认）。 */
    public static boolean isAirIdentity(String registryId) {
        if (registryId == null) {
            return true;
        }
        String s = registryId.trim()
            .toLowerCase(Locale.ROOT);
        return s.isEmpty() || "air".equals(s) || "minecraft:air".equals(s);
    }

    /** 两个注册名是否指同一个方块（大小写不敏感；null 只与 null 相同）。 */
    public static boolean sameIdentity(String a, String b) {
        if (a == null || b == null) {
            return a == null && b == null;
        }
        return a.trim()
            .equalsIgnoreCase(b.trim());
    }
}
