package com.lightning.mod.client.controlplane.mc;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;

import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import com.google.gson.JsonObject;
import com.lightning.mod.client.controlplane.core.CpException;
import com.lightning.mod.client.controlplane.core.ErrorCodes;
import com.lightning.mod.client.controlplane.core.Json;

/**
 * 托管世界标记（{@code cp_world.json}）的<b>状态机</b>单测。
 *
 * <h2>被钉死的缺陷</h2>
 * 修复前标记<b>只在重建的最末 MARKER 阶段</b>写：build 阶段失败即在存档根留下「有世界文件、
 * 无标记」的残留 ⇒ {@code world.rebuild} 拒绝（{@link WorldRebuildRunner#assertManagedIfExists}）、
 * 删除阶段也拒绝（{@link ManagedWorld#assertDeletable}）⇒ <b>没有任何 API 能清掉它</b>，
 * 只能手工删目录（实机擒获）。修法是<b>标记前置</b>：世界建好后立刻写
 * {@code complete:false}，构建成功后改写 {@code complete:true}。
 *
 * <h2>本类为什么能在离线跑（而不是只能实机验证）</h2>
 * 本测试的全部判据都只依赖<b>文件系统上的标记文件</b>与<b>两个判据函数</b>
 * （{@link ManagedWorld#hasMarker} = 可删/可重建；{@link ManagedWorld#isComplete}
 * = 可当成品复用）。它们都是纯 JDK + Gson，不需要世界运行时——而「失败后能不能重建」这条路
 * 的<b>全部逻辑</b>就是这两条判据（重建机在 DELETE/ARM 阶段只调它们）。故实机段二验证的是
 * 「MC 真的按这个序调用了它们」，不是判据本身。
 *
 * <h2>三组断言（与任务书验收标准逐条对齐）</h2>
 * <ol>
 * <li><b>流转</b>：{@code complete} 的 false → true 流转（前置 → 收口），且中间态可删；</li>
 * <li><b>失败残留可删</b>：{@code complete:false} 的目录通过删除确认与重建前置检查——
 * 这正是修复的落点（修复前它会被拒，因为那时失败残留根本没有标记）；</li>
 * <li><b>负对照</b>：无标记目录<b>仍然</b>被拒绝（安全属性不回退）。</li>
 * </ol>
 */
public class ManagedWorldMarkerTest {

    @Rule
    public TemporaryFolder tmp = new TemporaryFolder();

    /** 一个合法的托管世界目录名。 */
    private static final String FOLDER = "cp_marker_sm";

    /** 重建用的固定种子（与用例同口径：幂等重建要求固定种子）。 */
    private static final long SEED = 20261007L;

    // ============================================================ 组 1：complete 状态机流转

    /**
     * <b>核心流转</b>：前置写 {@code false} → 收口写 {@code true}，且两态都「有标记」。
     *
     * <p>
     * 这两条断言合起来才是修复的全部：{@code hasMarker} 恒为 true（失败残留也能删），
     * {@code isComplete} 从 false 变 true（中途不得被当成品）。
     */
    @Test
    public void preMarkerIsIncompleteThenPromotedToComplete() throws IOException {
        Path dir = newWorldDir();

        JsonObject pre = ManagedWorld.writeMarker(dir, FOLDER, SEED, true, false);
        assertFalse("前置标记必须显式写 complete:false", Json.optBool(pre, "complete", true));
        assertTrue("前置后目录「有标记」——失败残留因此可删（修复的落点）", ManagedWorld.hasMarker(dir));
        assertTrue("有标记 ⇒ 是托管目录（可删/可重建）", ManagedWorld.isManaged(dir));
        assertFalse("但不得当作构建完成的成品复用", ManagedWorld.isComplete(dir));

        JsonObject done = ManagedWorld.promoteMarker(dir, FOLDER, SEED, true);
        assertTrue("收口后必须是 complete:true", Json.optBool(done, "complete", false));
        assertTrue("收口后仍是托管目录", ManagedWorld.isManaged(dir));
        assertTrue("收口后才允许当成品复用", ManagedWorld.isComplete(dir));
        assertTrue("落盘的标记也必须是 complete:true", Boolean.TRUE.equals(readMarkerProp(dir, "complete")));
    }

    /**
     * 前置写下的标记<b>字段本身</b>必须齐全（不只是 complete）。
     *
     * <p>
     * 理由：前置标记会一直留在盘上直到收口，其间任何只读消费者（{@code world.info}、
     * 审计）读到的就是它。若它缺 {@code seed}/{@code void}/{@code schema}，那些消费者会
     * 把「有世界正在构建」误读成「标记损坏」。
     */
    @Test
    public void preMarkerCarriesFullIdentityNotJustTheFlag() throws IOException {
        Path dir = newWorldDir();
        ManagedWorld.writeMarker(dir, FOLDER, SEED, true, false);

        JsonObject m = ManagedWorld.readMarker(dir);
        assertNotNull("前置标记必须可解析", m);
        assertEquals("lightning.cp-world/1", Json.optString(m, "schema", null));
        assertEquals(FOLDER, Json.optString(m, "folder", null));
        assertEquals(SEED, Json.optLong(m, "seed", -1L));
        assertTrue("void 字段照写", Json.optBool(m, "void", false));
        assertEquals(ManagedWorld.CREATED_BY, Json.optString(m, "createdBy", null));
        assertNotNull("createdAt 照写（世界创建时刻）", Json.optString(m, "createdAt", null));
        assertNull("未完成时不得写 completedAt（否则「完成时刻」会被误读）", Json.optString(m, "completedAt", null));
    }

    /**
     * 收口<b>保留</b> {@code createdAt} 并补 {@code completedAt}。
     *
     * <p>
     * 「先失败、后重跑成功」是本次修复的主场景：若收口顺手重写 {@code createdAt}，
     * 审计就会读不出世界真正的创建时刻（把重跑那一次当成创建）。
     */
    @Test
    public void promotionKeepsCreatedAtAndAddsCompletedAt() throws IOException {
        Path dir = newWorldDir();
        JsonObject pre = ManagedWorld.writeMarker(dir, FOLDER, SEED, true, false);
        String createdAt = Json.optString(pre, "createdAt", null);
        assertNotNull(createdAt);

        JsonObject done = ManagedWorld.promoteMarker(dir, FOLDER, SEED, true);
        assertEquals("收口不得改写 createdAt（世界创建时刻不变）", createdAt, Json.optString(done, "createdAt", null));
        assertNotNull("收口必须补 completedAt", Json.optString(done, "completedAt", null));
        assertEquals("收口不得动 seed", SEED, Json.optLong(done, "seed", -1L));
        assertEquals("收口不得动 folder", FOLDER, Json.optString(done, "folder", null));
    }

    /** 收口是幂等的：连做两次，除 {@code completedAt} 外内容不变。 */
    @Test
    public void promotionIsIdempotentInShape() throws IOException {
        Path dir = newWorldDir();
        ManagedWorld.writeMarker(dir, FOLDER, SEED, true, false);
        ManagedWorld.promoteMarker(dir, FOLDER, SEED, true);
        String first = withoutCompletedAt(ManagedWorld.readMarker(dir));
        String createdAt = Json.optString(ManagedWorld.readMarker(dir), "createdAt", null);

        JsonObject again = ManagedWorld.promoteMarker(dir, FOLDER, SEED, true);
        assertEquals(true, Json.optBool(again, "complete", false));
        assertEquals("第二次收口仍不得改写 createdAt", createdAt, Json.optString(again, "createdAt", null));
        assertEquals("除 completedAt（时刻会变）外内容逐字不变", first, withoutCompletedAt(again));
    }

    // ============================================================ 组 2：失败残留可删 / 可重建

    /**
     * <b>核心回归锁</b>：{@code complete:false} 的失败残留必须通过删除二次确认。
     *
     * <p>
     * 修复前这个目录是「无标记」的（标记还没写），删除确认<b>必然拒绝</b>它——这就是
     * 「没有任何 API 能清掉」的实现根因。本用例直接对修复后的产物断言不抛异常。
     */
    @Test
    public void incompleteResiduePassesDeleteConfirmation() throws IOException {
        Path dir = newWorldDir();
        ManagedWorld.writeMarker(dir, FOLDER, SEED, true, false);
        // 再塞点「世界文件」，模拟 build 途中失败的真实残留形态
        Files.write(dir.resolve("level.dat"), new byte[] { 1, 2, 3 });
        Files.createDirectories(dir.resolve("region"));
        Files.write(
            dir.resolve("region")
                .resolve("r.0.0.mca"),
            new byte[] { 4, 5, 6 });

        try {
            ManagedWorld.assertDeletable(dir, FOLDER, "world.rebuild");
        } catch (CpException e) {
            fail("失败残留（complete:false）必须可删，却被拒: " + e.detail() + " [" + e.code() + "]");
        }
    }

    /**
     * 失败残留必须通过重建动作的<b>前置检查</b>（「非托管世界拒绝写」那道门）。
     *
     * <p>
     * 这是缺陷报告点名的第二个拒绝点（{@code assertManagedIfExists}）：两个门都放行，
     * 「同 folder 可经 {@code world.rebuild} 正常重建」才成立。
     */
    @Test
    public void incompleteResiduePassesRebuildPrecondition() throws IOException {
        Path saves = savesRoot();
        Path dir = saves.resolve(FOLDER);
        Files.createDirectories(dir);
        ManagedWorld.writeMarker(dir, FOLDER, SEED, true, false);

        try {
            WorldRebuildRunner.assertManagedIfExists(
                saves.getParent()
                    .toFile(),
                FOLDER);
        } catch (CpException e) {
            fail("失败残留必须能重跑重建，却被前置检查拒: " + e.detail() + " [" + e.code() + "]");
        }
    }

    /**
     * 残留被删后重建成功 ⇒ 目录回到 {@code complete:true}（模拟 DELETE → ARM → … → MARKER 全序）。
     *
     * <p>
     * 这条把「失败 → 重跑 → 成功」三步串起来：先造一个失败残留，再按重建机的真实动作序列
     * （删除 → 前置写 false → 收口 true）走一遍，断言终态是可复用的成品世界。
     */
    @Test
    public void rebuildAfterFailureYieldsReusableWorld() throws IOException {
        Path saves = savesRoot();
        Path dir = saves.resolve(FOLDER);
        Files.createDirectories(dir);

        // ① 首次构建失败留下的残留
        ManagedWorld.writeMarker(dir, FOLDER, SEED, true, false);
        Files.write(dir.resolve("level.dat"), new byte[] { 9 });
        assertFalse("残留不是可复用成品", ManagedWorld.isComplete(dir));

        // ② 重跑：DELETE 阶段（过二次确认后整目录删除）
        ManagedWorld.assertDeletable(dir, FOLDER, "world.rebuild");
        FileTrees.deleteTree(dir);
        assertFalse("删除后目录不存在", Files.exists(dir));

        // ③ ARM 阶段：前置写 false
        ManagedWorld.writeMarker(dir, FOLDER, SEED, true, false);
        assertTrue("前置后立即可删（下一次失败也能救）", ManagedWorld.hasMarker(dir));
        assertFalse("构建中不得复用", ManagedWorld.isComplete(dir));

        // ④ MARKER 阶段：收口
        ManagedWorld.promoteMarker(dir, FOLDER, SEED, true);
        assertTrue("重跑成功后是可复用成品", ManagedWorld.isComplete(dir));
        assertTrue("落盘标记为 true", Boolean.TRUE.equals(readMarkerProp(dir, "complete")));
    }

    // ============================================================ 组 2.5：驱动生产接缝（非手拼标记）

    /**
     * <b>生产接缝回归锁</b>：{@code world.rebuild} 的 ARM 阶段真的会写下一份 {@code complete:false}
     * 的标记。
     *
     * <p>
     * 上面前几组用的是 {@link ManagedWorld#writeMarker} 直接造态，能证明「标记判据对不对」，
     * 但证明不了「重建机真的会写它」——修复前重建机根本不写前置标记，只靠那些用例全绿也没用。
     * 本用例直接调 {@link WorldRebuildRunner#armMarker}（ARM 阶段的全部副作用），把这条接缝钉死。
     */
    @Test
    public void armStageWritesIncompleteMarkerOnProductionPath() throws IOException {
        Path saves = savesRoot();
        JsonObject m = WorldRebuildRunner.armMarker(
            saves.getParent()
                .toFile(),
            FOLDER,
            SEED);

        assertFalse("ARM 阶段写的必须是 complete:false", Json.optBool(m, "complete", true));
        assertTrue("ARM 之后立即有标记（这是修法的全部）", ManagedWorld.hasMarker(saves.resolve(FOLDER)));
        assertFalse("ARM 之后不得被当成品复用", ManagedWorld.isComplete(saves.resolve(FOLDER)));
    }

    /**
     * <b>全序回归锁（主证据形态）</b>：走一遍重建机真实的标记序列，
     * 中途在 BUILD 之后失败，断言残留可删；再重跑一次，断言终态可复用。
     *
     * <p>
     * 这就是段二实机要验的那条路（失败 → 可重建）在离线侧的等价物：ARM → （BUILD 失败）→
     * 残留可删可重建 → 重跑 ARM → 收口。
     */
    @Test
    public void productionMarkerSequenceSurvivesBuildFailureAndRebuild() throws IOException {
        Path saves = savesRoot();
        java.io.File dataDir = saves.getParent()
            .toFile();
        Path dir = saves.resolve(FOLDER);

        // 第一轮：ARM 成功，随后 BUILD 失败（模拟：标记停在 false）
        WorldRebuildRunner.armMarker(dataDir, FOLDER, SEED);
        Files.write(dir.resolve("level.dat"), new byte[] { 7, 7 });
        assertEquals("失败残留：标记在，但未完成", Boolean.FALSE, readMarkerProp(dir, "complete"));

        // 残留可删（两个拒绝点都要放行）——修复前这里必炸，因为标记根本没写下来
        ManagedWorld.assertDeletable(dir, FOLDER, "world.rebuild");
        WorldRebuildRunner.assertManagedIfExists(dataDir, FOLDER);

        // 第二轮：DELETE → ARM → MARKER（收口），走生产接缝
        FileTrees.deleteTree(dir);
        WorldRebuildRunner.armMarker(dataDir, FOLDER, SEED);
        WorldRebuildRunner.closeMarker(dir, FOLDER, SEED, true);
        assertTrue("重跑成功后是可复用成品", ManagedWorld.isComplete(dir));
        assertEquals("收口写的是 complete:true", Boolean.TRUE, readMarkerProp(dir, "complete"));

        // 收口后的世界可快照（成品复用门放行）
        ManagedWorld.assertCompleteWorld(dir, FOLDER, "world.snapshot");
    }

    /**
     * {@code case.run} 的 {@code world} 段<b>不收口</b>（{@code markComplete=false}）。
     *
     * <p>
     * 该段后面还有独立的 build 段；若它提前收口，build 段失败就会留下「标记说完成、场景只铺了
     * 一半」的世界，下游会误判为可复用。本用例锁住「不收口」这个选择。
     */
    @Test
    public void caseRunWorldSegmentLeavesMarkerIncompleteForLaterBuildSegment() throws IOException {
        Path saves = savesRoot();
        java.io.File dataDir = saves.getParent()
            .toFile();
        Path dir = saves.resolve(FOLDER);

        WorldRebuildRunner.armMarker(dataDir, FOLDER, SEED);
        WorldRebuildRunner.closeMarker(dir, FOLDER, SEED, false);

        assertFalse("world 段后面还有 build 段时不得收口（否则 build 失败会留下假完成的世界）", ManagedWorld.isComplete(dir));
        assertTrue("但仍可删可重建", ManagedWorld.isManaged(dir));
    }

    // ============================================================ 组 3：负对照（安全属性不回退）
    /**
     * <b>负对照 ①</b>：无标记的目录仍然被删除确认拒绝（安全属性不回退）。
     *
     * <p>
     * 修法放宽的是「带标记但未完成」，<b>不是</b>「无标记」。这条与
     * {@link #incompleteResiduePassesDeleteConfirmation} 成对：一条证明残留被放行，
     * 一条证明放行的边界没有溢出到无标记目录。
     */
    @Test
    public void unmarkedDirStillRefusedByDeleteConfirmation() throws IOException {
        Path saves = savesRoot();
        Path dir = saves.resolve(FOLDER);
        Files.createDirectories(dir);
        Files.write(dir.resolve("level.dat"), new byte[] { 1 });

        try {
            ManagedWorld.assertDeletable(dir, FOLDER, "world.rebuild");
            fail("无标记目录必须仍被拒绝删除（安全属性回退）");
        } catch (CpException e) {
            assertEquals(ErrorCodes.STATE, e.code());
            assertTrue(
                "错误信息须点名缺哪个文件: " + e.detail(),
                e.detail()
                    .contains(ManagedWorld.MARKER));
        }
    }

    /** <b>负对照 ②</b>：无标记的目录仍然被重建前置检查拒绝。 */
    @Test
    public void unmarkedDirStillRefusedByRebuildPrecondition() throws IOException {
        Path saves = savesRoot();
        Path dir = saves.resolve(FOLDER);
        Files.createDirectories(dir);
        Files.write(dir.resolve("level.dat"), new byte[] { 1 });

        try {
            WorldRebuildRunner.assertManagedIfExists(
                saves.getParent()
                    .toFile(),
                FOLDER);
            fail("无标记目录必须仍被前置检查拒（安全属性回退）");
        } catch (CpException e) {
            assertEquals(ErrorCodes.STATE, e.code());
            assertTrue(
                e.detail()
                    .contains(ManagedWorld.MARKER));
        }
    }

    /** <b>负对照 ③</b>：无标记目录不得被当成品复用（{@code assertCompleteWorld} 与 isComplete 都要拒）。 */
    @Test
    public void unmarkedDirIsNotACompleteWorld() throws IOException {
        Path saves = savesRoot();
        Path dir = saves.resolve(FOLDER);
        Files.createDirectories(dir);

        assertFalse(ManagedWorld.hasMarker(dir));
        assertFalse("无标记：不是托管世界", ManagedWorld.isManaged(dir));
        assertFalse("无标记：更不是成品世界", ManagedWorld.isComplete(dir));
        try {
            ManagedWorld.assertCompleteWorld(dir, FOLDER, "world.snapshot");
            fail("无标记目录必须被成品复用门拒绝");
        } catch (CpException e) {
            assertEquals(ErrorCodes.STATE, e.code());
            assertTrue(
                "拒绝理由须是「非托管世界」而不是「未完成」",
                e.detail()
                    .contains("非托管世界"));
        }
    }

    /**
     * <b>负对照 ④</b>：未完成世界不得被当成品复用（{@code complete:false} 的可用性边界）。
     *
     * <p>
     * 与上面一条的区别是拒绝<b>理由</b>：这里目录确实是托管的（可以删/重建），只是不能复用。
     * 两类拒绝必须分得开——否则调用方会把「重跑重建就能修」误当成「目录名写错了」。
     */
    @Test
    public void incompleteWorldIsRefusedAsReusableButAllowedForDelete() throws IOException {
        Path dir = newWorldDir();
        ManagedWorld.writeMarker(dir, FOLDER, SEED, true, false);

        // 可删（安全边界放行）
        ManagedWorld.assertDeletable(dir, FOLDER, "world.rebuild");
        // 不可复用（可用性边界拒绝）
        try {
            ManagedWorld.assertCompleteWorld(dir, FOLDER, "world.snapshot");
            fail("complete:false 必须被成品复用门拒");
        } catch (CpException e) {
            assertEquals(ErrorCodes.STATE, e.code());
            assertTrue(
                "理由须点名「构建未完成」: " + e.detail(),
                e.detail()
                    .contains("构建未完成"));
            assertNotNull("须给出怎么修（重跑重建）", e.context());
            assertTrue(
                "hint 须指路重建",
                Json.optString(e.context(), "hint", "")
                    .contains("world.rebuild"));
        }
    }

    // ============================================================ 向后兼容与形态防御

    /**
     * <b>向后兼容</b>：本字段引入前写下的标记（无 {@code complete} 键）按「已完成」读。
     *
     * <p>
     * 理由见 {@link ManagedWorld} 类注释：那时的标记只在构建完成后才写，缺键即旧口径的完成标记。
     * 若不这么读，升级后所有既有托管世界都会突然变成「未完成」，快照门一律拒绝——
     * 那是一次静默的兼容性破坏。
     */
    @Test
    public void legacyMarkerWithoutCompleteReadsAsComplete() throws IOException {
        Path dir = newWorldDir();
        JsonObject legacy = new JsonObject();
        legacy.addProperty("schema", ManagedWorld.SCHEMA);
        legacy.addProperty("folder", FOLDER);
        legacy.addProperty("seed", SEED);
        legacy.addProperty("void", true);
        legacy.addProperty("createdBy", ManagedWorld.CREATED_BY);
        writeMarkerFile(dir, legacy);

        assertTrue("缺 complete 键 ⇒ 旧口径的完成标记", ManagedWorld.markerComplete(ManagedWorld.readMarker(dir)));
        assertTrue(ManagedWorld.isComplete(dir));
        ManagedWorld.assertCompleteWorld(dir, FOLDER, "world.snapshot"); // 不抛
    }

    /**
     * <b>形态防御</b>：{@code complete} 键在但不是布尔 ⇒ 按<b>未完成</b>处理（失败显式）。
     *
     * <p>
     * 判据不能写成 {@code Json.optBool(..., true)}：那样 null / 字符串 / 数字都会被当成
     * 「大概是完成的」。宁可把它当未完成（可删可重建），也不放一个形态坏掉的世界进成品复用路径。
     */
    @Test
    public void malformedCompleteValueReadsAsIncomplete() throws IOException {
        for (String raw : new String[] { "null", "\"true\"", "1", "[]", "{}" }) {
            Path dir = tmp.newFolder("malformed-" + Math.abs(raw.hashCode()))
                .toPath();
            JsonObject m = new JsonObject();
            m.addProperty("schema", ManagedWorld.SCHEMA);
            m.addProperty("folder", FOLDER);
            m.add(ManagedWorld.FIELD_COMPLETE, Json.parseStrict(raw));
            writeMarkerFile(dir, m);

            assertFalse(
                "complete=" + raw + " 形态非法 ⇒ 须按未完成读（不能猜成完成）",
                ManagedWorld.markerComplete(ManagedWorld.readMarker(dir)));
            assertFalse(ManagedWorld.isComplete(dir));
        }
    }

    /** 标记文件存在但内容不是合法 JSON ⇒ 有标记（可删）但不可复用，且不得抛。 */
    @Test
    public void corruptMarkerIsDeletableButNotReusable() throws IOException {
        Path dir = newWorldDir();
        Files.write(dir.resolve(ManagedWorld.MARKER), "{ not json".getBytes(StandardCharsets.UTF_8));

        assertTrue("文件在 ⇒ hasMarker 为真（可删：这正是修法要救的形态之一）", ManagedWorld.hasMarker(dir));
        assertTrue(ManagedWorld.isManaged(dir));
        assertNull("读不出来 ⇒ readMarker 返回 null", ManagedWorld.readMarker(dir));
        assertFalse("损坏的标记不得当成品复用", ManagedWorld.isComplete(dir));
        assertFalse(ManagedWorld.markerComplete(null));

        // 可删：不因标记损坏而拒
        ManagedWorld.assertDeletable(dir, FOLDER, "world.rebuild");
        try {
            ManagedWorld.assertCompleteWorld(dir, FOLDER, "world.snapshot");
            fail("损坏标记必须被成品复用门拒");
        } catch (CpException e) {
            assertEquals(ErrorCodes.STATE, e.code());
        }
    }

    /**
     * <b>收口拒绝为未认证目录补写标记</b>（安全属性的一部分）。
     *
     * <p>
     * 「写标记」等于把目录认证为托管世界，只允许发生在标记前置那条显式路径上。若收口顺手补写，
     * 任何一个没被我们建过的目录都会被认证成托管世界——安全属性直接回退。故此处必须失败显式。
     */
    @Test
    public void promotionRefusesToCertifyUnmarkedDirectory() throws IOException {
        Path saves = savesRoot();
        Path dir = saves.resolve(FOLDER);
        Files.createDirectories(dir);
        Files.write(dir.resolve("level.dat"), new byte[] { 1, 2, 3 });

        try {
            ManagedWorld.promoteMarker(dir, FOLDER, SEED, true);
            fail("收口不得为无标记目录补写标记（会把未认证目录认证成托管世界）");
        } catch (CpException e) {
            assertEquals(ErrorCodes.STATE, e.code());
            assertTrue(
                e.detail()
                    .contains("拒绝把未认证的目录认证为托管世界"));
        }
        assertFalse("失败后不得留下任何标记", ManagedWorld.hasMarker(dir));
    }

    /**
     * 标记前置写入会建出目录本身（DELETE 之后目录不存在，ARM 要负责把它造出来）。
     */
    @Test
    public void preMarkerCreatesDirectoryIfAbsent() throws IOException {
        Path dir = savesRoot().resolve(FOLDER);
        assertFalse(Files.exists(dir));

        ManagedWorld.writeMarker(dir, FOLDER, SEED, true, false);
        assertTrue("前置写标记须建出目录（否则进世界的写会落在不存在的目录上）", Files.isDirectory(dir));
        assertTrue(ManagedWorld.hasMarker(dir));
    }

    // ============================================================ 夹具

    /** {@code <tmp>/saves/<FOLDER>}——走真实存档根，让「目录名 + 根内」两道校验都真跑。 */
    private Path newWorldDir() throws IOException {
        Path dir = savesRoot().resolve(FOLDER);
        Files.createDirectories(dir);
        return dir;
    }

    /** 临时存档根。 */
    private Path savesRoot() throws IOException {
        return tmp.newFolder("saves")
            .toPath();
    }

    /** 读标记里的一个布尔属性（缺失返回 null）。 */
    private static Boolean readMarkerProp(Path dir, String key) {
        JsonObject m = ManagedWorld.readMarker(dir);
        if (m == null || !m.has(key)) {
            return null;
        }
        return Boolean.valueOf(
            m.get(key)
                .getAsBoolean());
    }

    /** 直接落一份标记对象（造历史形态用，绕开 {@link ManagedWorld#writeMarker} 的字段）。 */
    private static void writeMarkerFile(Path dir, JsonObject marker) throws IOException {
        Files.createDirectories(dir);
        Files.write(
            dir.resolve(ManagedWorld.MARKER),
            Json.toPretty(marker)
                .getBytes(StandardCharsets.UTF_8));
    }

    /** 从规范化文本里剔除 {@code completedAt} 成员（收口幂等比较用：该键的值是时刻，逐次不同）。 */
    private static String withoutCompletedAt(JsonObject marker) {
        JsonObject copy = Json.copyObject(marker);
        copy.remove("completedAt");
        return Json.canonical(copy);
    }
}
