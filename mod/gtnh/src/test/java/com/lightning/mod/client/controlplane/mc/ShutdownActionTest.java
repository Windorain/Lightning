package com.lightning.mod.client.controlplane.mc;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;

import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import com.google.gson.JsonObject;
import com.lightning.mod.client.controlplane.core.ActionDescriptor;
import com.lightning.mod.client.controlplane.core.ActionRegistry;
import com.lightning.mod.client.controlplane.core.Contract;
import com.lightning.mod.client.controlplane.core.Json;
import com.lightning.mod.client.controlplane.core.Tier;

/**
 * {@code core.shutdown}（v1.6，issue #103 V5 裁决）的离线单测。
 *
 * <h2>为什么这一段必须离线锁死</h2>
 * 本动作的职责是「把结论落成进程退出码然后杀进程」——它的失败模式全是<b>不可回滚</b>的：
 * 猜成绿会把一次红跑报成绿跑（外层脚本据此放行），猜成红会把一次绿跑报成红跑（无人值守误报）。
 * 而「杀进程」这条路在单测里当然不能真跑。因此这里锁的是它的<b>定码逻辑</b>（纯函数，
 * {@link ShutdownAction#resolveVerdictIn} 与 MC 状态解耦）与<b>自描述</b>；真正的退出行为由
 * 实机 {@code dryRun} 证据覆盖（见 {@code temp/cp-assets/}）。
 *
 * <h2>退出码约定（本测试逐条锁）</h2>
 * 
 * <pre>
 * 0 = 判据全绿（evidence.overall == "green"）
 * 2 = 有红（evidence.overall != "green"）
 * 3 = 设施错误（连「绿没绿」都读不出来）
 * </pre>
 * 
 * 这条约定必须与 {@code evidence.overall} 对齐——不是「大致对应」，而是逐值可判定。
 */
public class ShutdownActionTest {

    @Rule
    public TemporaryFolder tmp = new TemporaryFolder();

    // ------------------------------------------------------------ 退出码常量与含义

    /** 三个约定码的取值本身也是契约（外层脚本按它分支，改值即破坏兼容）。 */
    @Test
    public void exitCodeConstantsAreContractValues() {
        assertEquals(0, ShutdownAction.EXIT_OK);
        assertEquals(2, ShutdownAction.EXIT_RED);
        assertEquals(3, ShutdownAction.EXIT_FACILITY);
    }

    /** 每个码都有人读含义（失败显式：码不能只有数字）。 */
    @Test
    public void everyCodeHasMeaning() {
        assertEquals("判据全绿", ShutdownAction.meaning(ShutdownAction.EXIT_OK));
        assertEquals("有红", ShutdownAction.meaning(ShutdownAction.EXIT_RED));
        assertEquals("设施错误", ShutdownAction.meaning(ShutdownAction.EXIT_FACILITY));
        assertTrue(
            "非约定码必须如实标注而不是硬套某个约定含义",
            ShutdownAction.meaning(7)
                .contains("自定义"));
    }

    // ------------------------------------------------------------ 定码：按 evidence.overall

    /** {@code overall=green} ⇒ 0（判据全绿）。两份文件都绿。 */
    @Test
    public void greenEvidenceYieldsZero() throws IOException {
        Path runs = runWith("20261007-120000-read-surface-12", "read-surface", "green", "green");
        ShutdownAction.Verdict v = ShutdownAction.resolveVerdictIn(runs, null, "20261007-120000-read-surface-12", null);
        assertEquals(ShutdownAction.EXIT_OK, v.code);
        assertEquals("run-overall", v.source);
        assertEquals("green", v.overall);
    }

    /** {@code overall=red} ⇒ 2（有红）。 */
    @Test
    public void redEvidenceYieldsTwo() throws IOException {
        Path runs = runWith("20261007-120000-read-surface-12", "read-surface", "red", "red");
        ShutdownAction.Verdict v = ShutdownAction.resolveVerdictIn(runs, null, "20261007-120000-read-surface-12", null);
        assertEquals(ShutdownAction.EXIT_RED, v.code);
        assertEquals("red", v.overall);
    }

    /**
     * <b>criteria 红而 evidence 绿 ⇒ 必须 2</b>（#103 实机擒获的缺陷的回归锁）。
     *
     * <h2>这条为什么是本测试最重要的一条</h2>
     * 两份文件的语义不同：{@code criteria.json.overall} 是用例声明的<b>判据</b>结论，
     * {@code evidence.json.overall} 是<b>期望证据核对</b>结论（该在场的产物在不在）。
     * 实机实测确实存在 {@code criteria=red} 而 {@code evidence=green} 的 run（一次
     * {@code l1-orchestration} 的 2 条判据红、12 项期望产物齐备）。
     *
     * <p>
     * 首版实现只读 {@code evidence.json}，于是对那个 run 返回 <b>0「判据全绿」</b>——
     * 正是裁决点名要防的「把一次红跑读成绿跑」。这条断言把那个缺陷钉死。
     */
    @Test
    public void criteriaRedWithEvidenceGreenYieldsTwo() throws IOException {
        Path runs = runWith("20261007-120000-l1-orchestration-1", "l1-orchestration", "red", "green");
        ShutdownAction.Verdict v = ShutdownAction
            .resolveVerdictIn(runs, null, "20261007-120000-l1-orchestration-1", null);
        assertEquals("criteria 红而 evidence 绿时绝不能报 0（只读 evidence.json 会犯这个错）", ShutdownAction.EXIT_RED, v.code);
        assertEquals("red", v.criteriaOverall);
        assertEquals("green", v.evidenceOverall);
    }

    /** 反向：evidence 红而 criteria 绿 ⇒ 同样 2（任一非绿即红，与 CaseRunAction.overall() 同源）。 */
    @Test
    public void evidenceRedWithCriteriaGreenYieldsTwo() throws IOException {
        Path runs = runWith("20261007-120000-x-1", "x", "green", "red");
        ShutdownAction.Verdict v = ShutdownAction.resolveVerdictIn(runs, null, "20261007-120000-x-1", null);
        assertEquals(ShutdownAction.EXIT_RED, v.code);
    }

    /** 只有 criteria.json（未跑 evidence 段）⇒ 按 criteria 定码，不因缺 evidence 判设施错误。 */
    @Test
    public void criteriaOnlyRunStillResolves() throws IOException {
        Path runs = tmp.newFolder("runs")
            .toPath();
        Path dir = runs.resolve("20261007-120000-partial-1");
        Files.createDirectories(dir);
        writeDoc(dir.resolve("criteria.json"), "red");
        ShutdownAction.Verdict v = ShutdownAction.resolveVerdictIn(runs, null, "20261007-120000-partial-1", null);
        assertEquals(ShutdownAction.EXIT_RED, v.code);
        assertNull("evidence.json 不存在时 evidenceOverall 应为 null（不是错误）", v.evidenceOverall);
    }

    /** 两份结论文件都不存在 ⇒ 3（绝不因此判绿——那是「没有结论」不是「结论绿」）。 */
    @Test
    public void noConclusionFileYieldsFacilityError() throws IOException {
        Path runs = tmp.newFolder("runs")
            .toPath();
        Files.createDirectories(runs.resolve("20261007-120000-x-1"));
        ShutdownAction.Verdict v = ShutdownAction.resolveVerdictIn(runs, null, "20261007-120000-x-1", null);
        assertEquals(ShutdownAction.EXIT_FACILITY, v.code);
        assertTrue(v.detail.contains("既无 criteria.json 也无 evidence.json"));
    }

    /**
     * 任何非 green 的 overall 都 ⇒ 2，不是只认字面量 {@code "red"}。
     *
     * <p>
     * 这是「绝不猜成绿」的机械形态：将来若引入第三个结论取值（如 {@code "skipped"}），
     * 它必须走红而不是静默放行——把 {@code !green} 写成 {@code ==red} 会让新取值变成绿。
     */
    @Test
    public void anyNonGreenOverallYieldsTwo() throws IOException {
        Path runs = tmp.newFolder("runs")
            .toPath();
        int i = 0;
        for (String overall : new String[] { "red", "error", "skipped", "" }) {
            String runId = "20261007-12000" + i + "-read-surface-12";
            writeRun(runs, runId, overall, overall);
            ShutdownAction.Verdict v = ShutdownAction.resolveVerdictIn(runs, null, runId, null);
            assertEquals("overall=" + overall + " 必须判红（非 green 一律非 0）", ShutdownAction.EXIT_RED, v.code);
            i++;
        }
    }

    // ------------------------------------------------------------ 定码：设施错误（3）

    /** runId 指向不存在的 run ⇒ 3（设施错误），绝不猜成 0。 */
    @Test
    public void missingRunYieldsFacilityError() throws IOException {
        Path runs = runWith("20261007-120000-read-surface-12", "read-surface", "green", "green");
        ShutdownAction.Verdict v = ShutdownAction.resolveVerdictIn(runs, null, "20261007-999999-nope-1", null);
        assertEquals(ShutdownAction.EXIT_FACILITY, v.code);
        assertTrue("缺 run 必须指名「两份结论文件都没有」而不是猜绿: " + v.detail, v.detail.contains("既无 criteria.json 也无 evidence.json"));
    }

    /** evidence.json 存在但不是合法 JSON ⇒ 3（形态不符不是「绿」）。 */
    @Test
    public void malformedEvidenceYieldsFacilityError() throws IOException {
        Path runs = tmp.newFolder("runs")
            .toPath();
        Path dir = runs.resolve("20261007-120000-read-surface-12");
        Files.createDirectories(dir);
        Files.write(dir.resolve("evidence.json"), "{ not json".getBytes(StandardCharsets.UTF_8));
        ShutdownAction.Verdict v = ShutdownAction.resolveVerdictIn(runs, null, "20261007-120000-read-surface-12", null);
        assertEquals(ShutdownAction.EXIT_FACILITY, v.code);
        assertTrue(v.detail.contains("合法 JSON"));
    }

    /** evidence.json 没有 overall 字段 ⇒ 3（形态不符）。 */
    @Test
    public void evidenceWithoutOverallYieldsFacilityError() throws IOException {
        Path runs = tmp.newFolder("runs")
            .toPath();
        Path dir = runs.resolve("20261007-120000-read-surface-12");
        Files.createDirectories(dir);
        JsonObject doc = new JsonObject();
        doc.addProperty("schema", "lightning.cp-evidence/1");
        Files.write(
            dir.resolve("evidence.json"),
            Json.toPretty(doc)
                .getBytes(StandardCharsets.UTF_8));
        ShutdownAction.Verdict v = ShutdownAction.resolveVerdictIn(runs, null, "20261007-120000-read-surface-12", null);
        assertEquals(ShutdownAction.EXIT_FACILITY, v.code);
        assertTrue(v.detail.contains("overall"));
    }

    /** 既没给 runId/caseId 也没给 code ⇒ 3（不猜结论——猜成绿是最坏的失败模式）。 */
    @Test
    public void noRunAndNoCodeYieldsFacilityError() throws IOException {
        Path runs = tmp.newFolder("runs")
            .toPath();
        ShutdownAction.Verdict v = ShutdownAction.resolveVerdictIn(runs, null, null, null);
        assertEquals(ShutdownAction.EXIT_FACILITY, v.code);
        assertEquals("none", v.source);
        assertTrue(v.detail.contains("不猜结论"));
    }

    // ------------------------------------------------------------ 定码：显式 code 优先

    /** 显式 {@code code} 优先于 evidence 读取（外部驱动已自行判定时用）。 */
    @Test
    public void explicitCodeWinsOverEvidence() throws IOException {
        Path runs = runWith("20261007-120000-read-surface-12", "read-surface", "green", "green");
        ShutdownAction.Verdict v = ShutdownAction
            .resolveVerdictIn(runs, Integer.valueOf(ShutdownAction.EXIT_RED), "20261007-120000-read-surface-12", null);
        assertEquals(ShutdownAction.EXIT_RED, v.code);
        assertEquals("explicit", v.source);
        // 显式码时不去读 evidence，因此 overall 必须为空（不假装核对过）
        assertNull(v.overall);
    }

    /** 非约定显式码放行，但如实标注「别当约定码读」。 */
    @Test
    public void nonConventionExplicitCodeIsAnnotated() throws IOException {
        Path runs = tmp.newFolder("runs")
            .toPath();
        ShutdownAction.Verdict v = ShutdownAction.resolveVerdictIn(runs, Integer.valueOf(7), null, null);
        assertEquals(7, v.code);
        assertEquals("explicit", v.source);
        assertNotNull(v.detail);
        assertTrue(v.detail.contains("不在约定集合"));
    }

    // ------------------------------------------------------------ 定码：按 caseId 找最新 run

    /** 给 caseId 时取该用例<b>最新</b>的 run（按名称排序即时间序）。 */
    @Test
    public void caseIdResolvesToLatestRun() throws IOException {
        Path runs = tmp.newFolder("runs")
            .toPath();
        writeRun(runs, "20261007-100000-read-surface-3", "red", "red");
        writeRun(runs, "20261007-120000-read-surface-12", "green", "green");
        writeRun(runs, "20261007-110000-read-surface-7", "red", "red");
        ShutdownAction.Verdict v = ShutdownAction.resolveVerdictIn(runs, null, null, "read-surface");
        assertEquals(ShutdownAction.EXIT_OK, v.code);
        assertEquals("20261007-120000-read-surface-12", v.runId);
    }

    /** caseId 找不到 run ⇒ 3 且 source 标明是查表失败（不是「读文件失败」，两者根因不同）。 */
    @Test
    public void unknownCaseIdYieldsFacilityError() throws IOException {
        Path runs = tmp.newFolder("runs")
            .toPath();
        writeRun(runs, "20261007-120000-read-surface-12", "green", "green");
        ShutdownAction.Verdict v = ShutdownAction.resolveVerdictIn(runs, null, null, "never-ran");
        assertEquals(ShutdownAction.EXIT_FACILITY, v.code);
        assertEquals("caseId-lookup", v.source);
    }

    /**
     * caseId 匹配必须<b>逐字</b>，不能是前缀/子串。
     *
     * <p>
     * 反例形态：{@code cp-a} 用 contains 会命中 {@code cp-ab} 的 run，于是「读错 run」静默发生——
     * 而那正是本动作最不该犯的错（它据此决定进程退出码）。
     */
    @Test
    public void caseIdMatchingIsExact() {
        assertTrue(ShutdownAction.matchesCase("20261007-120000-read-surface-12", "read-surface"));
        assertTrue(ShutdownAction.matchesCase("20261007-120000-cp-a-3", "cp-a"));
        assertTrue(ShutdownAction.matchesCase("20261007-120000-cp-a", "cp-a"));
        assertFalse(ShutdownAction.matchesCase("20261007-120000-cp-ab-3", "cp-a"));
        assertFalse(ShutdownAction.matchesCase("20261007-120000-cp-ab", "cp-a"));
        assertFalse(ShutdownAction.matchesCase("nope", "cp-a"));
        assertFalse(ShutdownAction.matchesCase(null, "cp-a"));
        assertFalse(ShutdownAction.matchesCase("20261007-120000-cp-a-3", null));
    }

    // ------------------------------------------------------------ 自描述（D1/D3）

    /** 动作已注册、scene 级（可写 ⇒ 框架自动要求 confirm）、since=1.6、契约版本覆盖它。 */
    @Test
    public void shutdownIsRegisteredAtSceneTierWithSince16() {
        ActionRegistry registry = new ActionRegistry();
        ActionRegistrar.registerAll(null, registry);
        ActionDescriptor d = registry.descriptor(ShutdownAction.NAME);
        assertNotNull("core.shutdown 必须已注册", d);
        assertEquals("结束进程比任何世界写都不可逆，必须过同一道确认门", Tier.SCENE, d.tier());
        assertTrue("可写动作必须要求 confirm", d.writable());
        assertEquals("1.6", d.since());
        assertTrue(
            "契约版本必须覆盖动作 since（自述目录不能自相矛盾）",
            Double.parseDouble(Contract.VERSION) >= Double.parseDouble(d.since()));
    }

    /**
     * 自描述六要素齐备，且<b>写出退出码约定与退出纪律</b>。
     *
     * <p>
     * 这条不是形式检查：外层无人值守脚本的作者只看自述端点。如果自述里没有「0/2/3」这三个数，
     * 他就只能去读源码或猜——而「没有自描述的动作视为不存在」（需求书 §8.1）。
     * 同理，{@code Runtime.halt} 会被 FMLSecurityManager 静默拦掉这件事必须写在自述里，
     * 否则下一个人会「顺手改成 halt」并把红跑读成绿跑（实测事故）。
     */
    @Test
    public void descriptorDocumentsExitCodesAndDiscipline() {
        ActionRegistry registry = new ActionRegistry();
        ActionRegistrar.registerAll(null, registry);
        ActionDescriptor d = registry.descriptor(ShutdownAction.NAME);
        String desc = d.description();
        assertTrue("自述必须写明 0=判据全绿", desc.contains("0=判据全绿"));
        assertTrue("自述必须写明 2=有红", desc.contains("2=有红"));
        assertTrue("自述必须写明 3=设施错误", desc.contains("3=设施错误"));
        assertTrue("自述必须写明与 run 结论对齐", desc.contains("run 的合并结论对齐"));
        assertTrue(
            "自述必须写明读**两份**结论文件（只读其一会把红跑报成绿跑——#103 实机缺陷）",
            desc.contains("criteria.json") && desc.contains("evidence.json") && desc.contains("两份"));
        assertTrue("自述必须写明退出纪律（exitJava）", desc.contains("exitJava"));
        assertTrue("自述必须写明绝不 Runtime.halt 及其原因", desc.contains("Runtime.halt"));
        assertTrue("自述必须写明不许编入固定程序", desc.contains("不许编入固定程序"));
        assertFalse(
            "returns 不能为空",
            d.returns()
                .trim()
                .isEmpty());
        assertTrue(
            "至少给一条可复制示例",
            d.examples()
                .size() > 0);
        // 可写动作的示例必须自带 confirm，否则照抄示例会被 CP-CONFIRM-001 拒
        for (int i = 0; i < d.examples()
            .size(); i++) {
            JsonObject ex = d.examples()
                .get(i)
                .getAsJsonObject();
            assertTrue("示例 " + i + " 缺 confirm:true（照抄会被 CP-CONFIRM-001 拒）", Json.optBool(ex, "confirm", false));
        }
        // dryRun 必须在自描述里可见（D3：默认值可见；它是本动作唯一的自证手段）
        boolean dryRunDocumented = false;
        for (ActionDescriptor.Param p : d.params()) {
            if ("dryRun".equals(p.name())) {
                dryRunDocumented = true;
                assertNotNull("dryRun 必须给出默认值（D3 默认值可见）", p.defaultValue());
            }
        }
        assertTrue("自述必须包含 dryRun 参数", dryRunDocumented);
    }

    // ------------------------------------------------------------ 参数校验

    /** 退出码越界报 CP-VALID-002（进程退出码是 8 位无符号）。 */
    @Test
    public void outOfRangeCodeIsRejected() {
        try {
            ShutdownAction.checkCode(Integer.valueOf(200), "code");
            org.junit.Assert.fail("应报 CP-VALID-002");
        } catch (com.lightning.mod.client.controlplane.core.CpException e) {
            assertEquals(com.lightning.mod.client.controlplane.core.ErrorCodes.VALID_PARAM, e.code());
        }
        // 边界内不报
        ShutdownAction.checkCode(Integer.valueOf(0), "code");
        ShutdownAction.checkCode(Integer.valueOf(127), "code");
        ShutdownAction.checkCode(null, "code");
    }

    // ------------------------------------------------------------ 夹具

    /** criteria.json 与 evidence.json 的文件名（与 {@link ShutdownAction} 的常量同源）。 */
    private static final String CRITERIA = ShutdownAction.CRITERIA_PATH;

    /** 见 {@link #CRITERIA}。 */
    private static final String EVIDENCE = ShutdownAction.EVIDENCE_PATH;

    /**
     * 造一个 run：两份结论文件各写一个 overall。
     *
     * <p>
     * <b>为什么夹具必须能分开设两份</b>：本动作的核心正确性主张是「任一非绿即红」，
     * 而它只有在两份<b>不一致</b>时才被检验到。只给一个 overall 的夹具会把那个主张藏起来
     * （首版实现正是在这种夹具下全绿、实机才露馅）。
     */
    private Path runWith(String runId, String caseId, String criteriaOverall, String evidenceOverall)
        throws IOException {
        Path runs = tmp.newFolder("runs")
            .toPath();
        writeRun(runs, runId, criteriaOverall, evidenceOverall);
        return runs;
    }

    /** 在 runs 根下写一个 run 的两份结论文件。 */
    private static void writeRun(Path runs, String runId, String criteriaOverall, String evidenceOverall)
        throws IOException {
        Path dir = runs.resolve(runId);
        Files.createDirectories(dir);
        writeDoc(dir.resolve(CRITERIA), "lightning.criteria/1", runId, criteriaOverall);
        writeDoc(dir.resolve(EVIDENCE), "lightning.cp-evidence/1", runId, evidenceOverall);
    }

    /** 写一份结论文件（{@code overall} 为 null 时不写该字段，用于形态不符的场景）。 */
    private static void writeDoc(Path path, String overall) throws IOException {
        writeDoc(path, "lightning.cp-evidence/1", null, overall);
    }

    /** 见 {@link #writeDoc(Path, String)}。 */
    private static void writeDoc(Path path, String schema, String runId, String overall) throws IOException {
        JsonObject doc = new JsonObject();
        doc.addProperty("schema", schema);
        if (runId != null) {
            doc.addProperty("runId", runId);
        }
        if (overall != null) {
            doc.addProperty("overall", overall);
        }
        Files.write(
            path,
            Json.toPretty(doc)
                .getBytes(StandardCharsets.UTF_8));
    }
}
