package com.lightning.mod.core.session;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import com.lightning.mod.core.session.ScanCellResolution.Verdict;

/**
 * 「这一格该不该保留、用什么身份」的纯判定（Gitea #127 第 3 条）的离线单测。
 *
 * <h2>本单点名要求锁住的那一行</h2>
 *
 * <b>扫描 = A 方块 / 活动世界 = 空气 ⇒ 不得静默消失</b>：只做第 2 条（判据侧显式校验）时它应当被拦下；
 * 做完第 3 条（按扫描身份烘焙）后它必须<b>按扫描身份保留</b>。两条路都不允许「静默丢块」这第三种结局，
 * 而这正是改造前的行为（{@code world.getBlock(...) == air ⇒ remapped = 0}）。
 *
 * <p>
 * 本测试<b>不</b>依赖 Minecraft 静态实例，也不需要世界对象：判定输入是字符串与布尔
 * （这正是把它抽成纯函数的理由——实机跑一次「好看的结果」证明不了这一行）。
 */
public class ScanCellResolutionTest {

    private static final String STONE = "minecraft:stone";
    private static final String DIRT = "minecraft:dirt";

    // ------------------------------------------------------------ 本单的核心判据

    /** 扫描有块、活动世界是空气 ⇒ 必须保留（禁止静默消失）。 */
    @Test
    public void scanHasBlockButLiveWorldIsAirKeepsScanIdentity() {
        assertEquals(
            "扫描=A方块/活动世界=空气 ⇒ 不得静默消失（做成了第 3 条 ⇒ 按扫描身份保留）",
            Verdict.KEEP_SCAN_IDENTITY,
            ScanCellResolution.decide(STONE, true, true, null));
    }

    /** 扫描与活动世界同块 ⇒ 保留（正常路径，行为不变）。 */
    @Test
    public void sameBlockOnBothSidesKeepsScanIdentity() {
        assertEquals(Verdict.KEEP_SCAN_IDENTITY, ScanCellResolution.decide(STONE, true, false, STONE));
        assertEquals(
            "注册名大小写差异不算冲突（同一注册表键）",
            Verdict.KEEP_SCAN_IDENTITY,
            ScanCellResolution.decide(STONE, true, false, "Minecraft:Stone"));
    }

    /** 扫描与活动世界是**不同**的非空气方块 ⇒ 显式报错（不许静默换块）。 */
    @Test
    public void differentBlockOnLiveWorldIsAnExplicitMismatch() {
        assertEquals(
            "活动世界被换成了另一个方块 ⇒ 不许静默换块、也不许静默丢块，必须显式报错",
            Verdict.WORLD_MISMATCH,
            ScanCellResolution.decide(STONE, true, false, DIRT));
    }

    /** 扫描身份就是空气 ⇒ 没有可保留的内容（这不是丢块）。 */
    @Test
    public void scanAirIsNoContentNotABlockLoss() {
        assertEquals(Verdict.SCAN_AIR, ScanCellResolution.decide("air", false, true, null));
        assertEquals(Verdict.SCAN_AIR, ScanCellResolution.decide("air", false, false, DIRT));
        assertEquals(Verdict.SCAN_AIR, ScanCellResolution.decide("minecraft:air", false, false, DIRT));
        assertEquals(Verdict.SCAN_AIR, ScanCellResolution.decide(null, false, false, DIRT));
        assertEquals(Verdict.SCAN_AIR, ScanCellResolution.decide("  ", false, false, DIRT));
    }

    /** 扫描身份认不出（方块不在注册表里）⇒ 显式报错，绝不回退到「活动世界是什么就画什么」。 */
    @Test
    public void unknownScanIdentityIsExplicitlyRejected() {
        assertEquals(
            "扫描身份无法解析 ⇒ 显式报错（既不许丢、也不许换成活动世界的块）",
            Verdict.SCAN_UNRESOLVED,
            ScanCellResolution.decide("moddoesnotexist:block", false, false, "moddoesnotexist:block"));
        assertEquals(
            "即便活动世界也是空气，也不许把「认不出」当「空气」静默丢掉",
            Verdict.SCAN_UNRESOLVED,
            ScanCellResolution.decide("moddoesnotexist:block", false, true, null));
    }

    // ------------------------------------------------------------ 判据本身的性质

    /** 判定必须是「保留」或「显式错」，不存在「静默丢非空气格」的结局（本单的主题）。 */
    @Test
    public void thereIsNoSilentDropOutcomeForNonAirScanCells() {
        String[] liveIds = { null, STONE, DIRT, "gregtech:gt.blockmachines" };
        boolean[] liveAir = { true, false };
        for (String live : liveIds) {
            for (boolean air : liveAir) {
                Verdict v = ScanCellResolution.decide(STONE, true, air, live);
                assertFalse("非空气扫描格的结果只能是「按扫描身份保留」或显式错，收到 " + v, v == Verdict.SCAN_AIR);
                assertTrue(
                    "非空气扫描格的结果必须是 KEEP 或错，收到 " + v,
                    v == Verdict.KEEP_SCAN_IDENTITY || v == Verdict.WORLD_MISMATCH);
            }
        }
    }

    /** 判据是纯函数：同样的输入永远同样的输出，且不依赖任何外部状态。 */
    @Test
    public void decisionIsPureAndDeterministic() {
        for (int i = 0; i < 3; i++) {
            assertEquals(Verdict.KEEP_SCAN_IDENTITY, ScanCellResolution.decide(STONE, true, true, null));
            assertEquals(Verdict.WORLD_MISMATCH, ScanCellResolution.decide(STONE, true, false, DIRT));
            assertEquals(Verdict.SCAN_AIR, ScanCellResolution.decide("air", false, false, DIRT));
        }
    }

    /** 身份比较与空气识别的辅助判据（错误消息与判定共用同一处实现）。 */
    @Test
    public void identityHelpersMatchTheirDocumentedRules() {
        assertTrue(ScanCellResolution.isAirIdentity("air"));
        assertTrue(ScanCellResolution.isAirIdentity("AIR"));
        assertTrue(ScanCellResolution.isAirIdentity("minecraft:air"));
        assertFalse(ScanCellResolution.isAirIdentity(STONE));
        assertTrue(ScanCellResolution.sameIdentity(STONE, "minecraft:stone"));
        assertTrue(ScanCellResolution.sameIdentity(null, null));
        assertFalse(ScanCellResolution.sameIdentity(null, STONE));
        assertFalse(ScanCellResolution.sameIdentity(STONE, null));
    }
}
