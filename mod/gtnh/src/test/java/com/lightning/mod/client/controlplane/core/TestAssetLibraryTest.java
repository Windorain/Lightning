package com.lightning.mod.client.controlplane.core;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Pattern;
import java.util.stream.Stream;

import org.junit.Test;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;

/**
 * {@code test/} 资产库的<b>机械门槛检查</b>。
 *
 * <h2>为什么门槛必须由构建来判</h2>
 * 「入库门槛 = 可重放三件套」如果只写在 README 里，它就是一句宣言：资产随 PR 演进，
 * 而「这一份是不是还齐备」没人会在改完用例之后手工复核一遍。本测试把门槛接进
 * {@code gradle test}——资产一坏，构建当场红，且错误指向具体文件与具体那一件。
 *
 * <h2>三件套的逐类具体化（本测试逐条落地）</h2>
 * <table>
 * <tr>
 * <th>类</th>
 * <th>①固定请求序列</th>
 * <th>②固定世界重建参数</th>
 * <th>③期望产物</th>
 * </tr>
 * <tr>
 * <td>{@code cases/}</td>
 * <td>用例文件本身自包含（无 include/ref/extends）</td>
 * <td>{@code world.void==true} 且 {@code seed} 显式</td>
 * <td>{@code criteria} 非空 + {@code evidence.expect} 非空 + {@code variants} 非空（负对照）</td>
 * </tr>
 * <tr>
 * <td>{@code criteria/}</td>
 * <td>断言集声明 {@code requiresCase} + 输入契约</td>
 * <td>不适用（替代物 = {@code requiresCase} 指向的用例是 hermetic 的）</td>
 * <td>逐条断言带 {@code id/target/expect/failSemantics} + 附负对照</td>
 * </tr>
 * <tr>
 * <td>{@code tutorials/}</td>
 * <td>{@code program.json} + {@code SOURCE.md}</td>
 * <td>同 {@code cases/}</td>
 * <td>骨架期只要求门槛说明齐备（实跑样本尚未入库）</td>
 * </tr>
 * <tr>
 * <td>{@code expected/}</td>
 * <td>基准引用 {@code {caseId, caseSha256}}（caseSha256 = 用例 UTF-8 文本 CRLF→LF 归一后的 sha256）</td>
 * <td>记录生成条件（world/runId/版本）</td>
 * <td>{@code manifest.json} 逐产物声明比较模式 + 比对器在位</td>
 * </tr>
 * </table>
 *
 * <h2>与「命名 kebab-case」的关系</h2>
 * 命名不是风格问题：{@code expected/} 的子目录名必须逐字等于用例 {@code id}，
 * 而 {@code id} 是 run 目录名的组成部分（case-file.md §8 第 4 条）——名字一漂，基准就找不到它的用例了。
 * 因此本测试把「文件名 == id」与 kebab-case 一起锁住。
 */
public class TestAssetLibraryTest {

    /** kebab-case：小写字母/数字，段间单个连字符。 */
    private static final Pattern KEBAB = Pattern.compile("^[a-z0-9]+(-[a-z0-9]+)*$");

    /** 资产库根（{@code <repoRoot>/test}）。 */
    private static Path libraryRoot() {
        Path dir = Paths.get("")
            .toAbsolutePath()
            .normalize();
        for (int i = 0; i < 8 && dir != null; i++) {
            Path candidate = dir.resolve("test");
            if (Files.isDirectory(candidate.resolve("cases"))) {
                return candidate;
            }
            dir = dir.getParent();
        }
        fail(
            "找不到 test/ 资产库根（从 " + Paths.get("")
                .toAbsolutePath() + " 向上 8 层没有 test/cases）");
        return null;
    }

    /** 递归收集 {@code .json} 资产。 */
    private static List<Path> jsonFiles(Path root) throws IOException {
        List<Path> out = new ArrayList<Path>();
        if (!Files.isDirectory(root)) {
            return out;
        }
        try (Stream<Path> s = Files.walk(root)) {
            s.filter(Files::isRegularFile)
                .filter(
                    p -> p.getFileName()
                        .toString()
                        .endsWith(".json"))
                .forEach(out::add);
        }
        out.sort(
            (a, b) -> a.toString()
                .compareTo(b.toString()));
        return out;
    }

    private static JsonObject readJson(Path p) throws IOException {
        return Json.parseStrictObject(new String(Files.readAllBytes(p), StandardCharsets.UTF_8));
    }

    // ------------------------------------------------------------ 目录结构

    /** 四类目录齐备；缺一类即红——「资产库」不是随便放几个文件。 */
    @Test
    public void fourAssetDirectoriesExist() {
        Path root = libraryRoot();
        for (String dir : new String[] { "cases", "criteria", "tutorials", "expected" }) {
            assertTrue("缺资产类目录: test/" + dir, Files.isDirectory(root.resolve(dir)));
        }
        assertTrue("缺总索引: test/README.md", Files.isRegularFile(root.resolve("README.md")));
    }

    /** 每一类都有本类 README（索引与门槛检查单的落点）。 */
    @Test
    public void everyAssetClassHasReadme() {
        Path root = libraryRoot();
        for (String dir : new String[] { "cases", "criteria", "tutorials", "expected" }) {
            assertTrue(
                "缺本类索引: test/" + dir + "/README.md（每份资产可发现、可重放）",
                Files.isRegularFile(
                    root.resolve(dir)
                        .resolve("README.md")));
        }
    }

    // ------------------------------------------------------------ expected/：caseSha256

    /**
     * 全部登记在 {@code expected/} 下的 {@code caseSha256} 都等于用例本体的「LF 归一哈希」。
     *
     * <p>
     * 这是 {@code expected/} 三件套第①件的机械判据：manifest 与 A3 证据都靠
     * {@code {caseId, caseSha256}} 指向用例，登记值一旦与用例对不上，基准就静默失效。
     * 归一化在哈希前完成，故同一份用例在 LF / CRLF 检出上算出同一个值；反过来，
     * 用检出平台原始字节登记的旧值会在另一种换行的检出上当场暴露。
     *
     * <p>
     * 归一与哈希复用生产侧唯一实现 {@link Hashing#sha256HexUtf8Lf(String)}，测试里不另写
     * 一份；同时对每个登记用例跑一次 {@link CaseParser#parseFile(java.nio.file.Path)}，
     * 核对运行期 {@code caseSha256} 与登记值逐字相同——登记与运行期由同一条判据锁住。
     */
    @Test
    public void registeredCaseSha256MatchesCanonicalCaseText() throws IOException {
        Path root = libraryRoot();
        Map<String, Path> casesById = new LinkedHashMap<String, Path>();
        for (Path p : jsonFiles(root.resolve("cases"))) {
            String id = Json.optString(readJson(p), "id", null);
            if (id != null) {
                casesById.put(id, p);
            }
        }

        int checked = 0;
        for (Path p : jsonFiles(root.resolve("expected"))) {
            String rel = root.relativize(p)
                .toString()
                .replace('\\', '/');
            JsonObject o = readJson(p);
            String caseId = Json.optString(o, "caseId", null);
            String recorded = Json.optString(o, "caseSha256", null);
            // 只校验登记型基准；parts-acceptance 等没有 {caseId, caseSha256} 的交付物不在此列
            if (caseId == null || recorded == null) {
                continue;
            }
            assertTrue(rel + "：caseSha256 必须是 64 位小写十六进制，实际为 " + recorded, recorded.matches("^[0-9a-f]{64}$"));
            Path caseFile = casesById.get(caseId);
            assertNotNull(rel + "：登记了 caseId=" + caseId + "，但 test/cases 下没有对应用例", caseFile);
            String text = new String(Files.readAllBytes(caseFile), StandardCharsets.UTF_8);
            assertEquals(
                rel + "：caseSha256 与用例 "
                    + root.relativize(caseFile)
                        .toString()
                        .replace('\\', '/')
                    + " 的 LF 归一哈希不一致（口径：UTF-8 文本 CRLF→LF 后取 sha256；用例或登记值变化必须同步）",
                Hashing.sha256HexUtf8Lf(text),
                recorded);
            CaseFile parsed = new CaseParser().parseFile(caseFile);
            assertEquals(
                rel + "：运行期 CaseParser 产出的 caseSha256 与登记值不一致"
                    + "（登记与运行期必须共用 Hashing#sha256HexUtf8Lf：UTF-8 文本 CRLF→LF 后取 sha256）",
                recorded,
                parsed.sha256());
            checked++;
        }
        assertTrue("expected/ 下没有任何 {caseId, caseSha256} 登记：基准引用检查会变成空转", checked >= 3);
    }

    // ------------------------------------------------------------ cases/：三件套

    /** 全部 {@code test/cases/**} 用例都能过 {@code case.validate}（解析 + 取值域 + 判据完备性）。 */
    @Test
    public void everyCaseValidates() throws IOException {
        List<Path> files = jsonFiles(libraryRoot().resolve("cases"));
        assertTrue("test/cases 下没有任何用例", files.size() >= 5);
        for (Path p : files) {
            String text = new String(Files.readAllBytes(p), StandardCharsets.UTF_8);
            try {
                CaseFile f = new CaseParser().parse(text);
                new CaseValidator().plan(f);
            } catch (CpException e) {
                fail("用例校验失败 " + libraryRoot().relativize(p) + "：" + e.detail() + " " + Json.toJson(e.context()));
            }
        }
    }

    /**
     * 三件套齐备（{@code cases/} 逐条具体化）。
     *
     * <p>
     * 第③件在本测试里由三条合成：{@code criteria} 非空（有判据）、{@code evidence.expect} 非空
     * （有期望产物清单）、{@code variants} 非空（有负对照——「只证明该绿」不足以定义「正确」）。
     */
    @Test
    public void everyCaseHasThreePieceGate() throws IOException {
        for (Path p : jsonFiles(libraryRoot().resolve("cases"))) {
            String rel = libraryRoot().relativize(p)
                .toString()
                .replace('\\', '/');
            JsonObject o = readJson(p);

            // ② 固定世界重建参数：world 段必填、void 必须显式为 true、seed 必须显式
            JsonObject world = Json.optObject(o, "world");
            assertNotNull(rel + "：缺 world 段（hermetic 纪律要求起手重建世界）", world);
            assertTrue(rel + "：world.void 必须显式为 true（case-file.md §2 / §8.8）", Json.optBool(world, "void", false));
            assertNotNull(rel + "：world.seed 必须显式（不得靠默认值承担可重放语义）", Json.get(world, "seed"));
            assertTrue(
                rel + "：world.folder 必须以 cp_ 开头",
                Json.optString(world, "folder", "")
                    .startsWith("cp_"));

            // ③ 期望产物：判据 + 证据清单 + 负对照
            JsonArray criteria = Json.optArray(o, "criteria");
            assertNotNull(rel + "：缺 criteria 段", criteria);
            assertTrue(rel + "：criteria 至少一条（存在即绿的判据不算期望产物）", criteria.size() >= 1);
            JsonObject evidence = Json.optObject(o, "evidence");
            assertNotNull(rel + "：缺 evidence 段", evidence);
            JsonArray expect = evidence == null ? null : Json.optArray(evidence, "expect");
            assertNotNull(rel + "：缺 evidence.expect", expect);
            assertTrue(rel + "：evidence.expect 非空（期望产物清单不能是空的）", expect.size() >= 1);
            JsonArray variants = Json.optArray(o, "variants");
            assertNotNull(rel + "：缺 variants 段（负对照是「判据不恒绿」的唯一机械保障）", variants);
            assertTrue(rel + "：variants 至少一条", variants.size() >= 1);

            // ① 固定请求序列：自包含（无 include/ref/extends —— 顶层字段严格模式已经保证，
            // 这里再正面确认一次「不是靠外部引用拼出来的程序」）
            for (String forbidden : new String[] { "include", "ref", "extends", "criteriaRef" }) {
                assertFalse(rel + "：出现了 " + forbidden + "（v1 无 include 机制，用例必须自包含）", o.has(forbidden));
            }
        }
    }

    /**
     * 每份用例的文件名逐字等于顶层 {@code id}，且都是 kebab-case。
     *
     * <p>
     * 这不是风格问题：{@code expected/<caseId>/} 的目录名必须逐字等于 {@code id}，
     * 而 {@code id} 又是 run 目录名的组成部分——名字一漂，基准就找不到它的用例了。
     */
    @Test
    public void caseFileNamesMatchIdsAndAreKebabCase() throws IOException {
        for (Path p : jsonFiles(libraryRoot().resolve("cases"))) {
            String fileName = p.getFileName()
                .toString();
            String stem = fileName.substring(0, fileName.length() - ".json".length());
            String rel = libraryRoot().relativize(p)
                .toString()
                .replace('\\', '/');
            assertTrue(
                "文件名不是 kebab-case: " + rel,
                KEBAB.matcher(stem)
                    .matches());
            JsonObject o = readJson(p);
            String id = Json.optString(o, "id", null);
            assertNotNull(rel + "：缺 id", id);
            assertEquals("文件名必须逐字等于顶层 id（便于反查，也是 expected/ 的目录名来源）", stem, id);
            // 目录名同样要 kebab-case（族目录只是分组，但也不许出现大写/下划线）
            Path parent = libraryRoot().resolve("cases")
                .relativize(p)
                .getParent();
            for (Path seg : parent) {
                assertTrue(
                    "cases/ 下的目录名不是 kebab-case: " + seg,
                    KEBAB.matcher(seg.toString())
                        .matches());
            }
        }
    }

    /** 每份用例至少有一条「决定性判据」——不是只有 artifact-exists 这种「存在即绿」。 */
    @Test
    public void everyCaseHasAtLeastOneDecisiveCriterion() throws IOException {
        for (Path p : jsonFiles(libraryRoot().resolve("cases"))) {
            String rel = libraryRoot().relativize(p)
                .toString()
                .replace('\\', '/');
            JsonObject o = readJson(p);
            JsonArray criteria = Json.optArray(o, "criteria");
            boolean decisive = false;
            for (int i = 0; criteria != null && i < criteria.size(); i++) {
                String type = Json.optString(
                    criteria.get(i)
                        .getAsJsonObject(),
                    "type",
                    "");
                // 决定性 = 对**值**做断言，而不是只对**存在**做断言
                if (!CriteriaEngine.TYPE_ARTIFACT_EXISTS.equals(type)
                    && !CriteriaEngine.TYPE_ARTIFACT_NONEMPTY.equals(type)) {
                    decisive = true;
                    break;
                }
            }
            assertTrue(
                rel + "：只有存在性判据（artifact-exists/artifact-nonempty）——那不能定义「正确」，"
                    + "至少要有一条对值的断言（json-field / te-state-equals / world-hash-equals / 图像阈值）",
                decisive);
        }
    }

    /** 负对照的 {@code expectCriteriaRed} 必须指向本用例里真实存在的判据 id（防恒绿假断言）。 */
    @Test
    public void variantExpectationsPointAtRealCriteria() throws IOException {
        for (Path p : jsonFiles(libraryRoot().resolve("cases"))) {
            String rel = libraryRoot().relativize(p)
                .toString()
                .replace('\\', '/');
            JsonObject o = readJson(p);
            JsonArray criteria = Json.optArray(o, "criteria");
            java.util.Set<String> ids = new java.util.LinkedHashSet<String>();
            for (int i = 0; criteria != null && i < criteria.size(); i++) {
                ids.add(
                    Json.optString(
                        criteria.get(i)
                            .getAsJsonObject(),
                        "id",
                        ""));
            }
            JsonArray variants = Json.optArray(o, "variants");
            for (int i = 0; variants != null && i < variants.size(); i++) {
                JsonObject v = variants.get(i)
                    .getAsJsonObject();
                JsonArray red = Json.optArray(v, "expectCriteriaRed");
                assertNotNull(rel + "：variants[" + i + "] 缺 expectCriteriaRed", red);
                for (int k = 0; k < red.size(); k++) {
                    String cid = red.get(k)
                        .getAsString();
                    assertTrue(
                        rel + "：变体 " + Json.optString(v, "id", "?") + " 的 expectCriteriaRed 指向未知判据 id: " + cid,
                        ids.contains(cid));
                }
            }
        }
    }

    /** 变体必须是「只改判据、不动 world/build」型（可整跑顺带执行）。 */
    @Test
    public void variantsOnlyPatchCriteria() throws IOException {
        for (Path p : jsonFiles(libraryRoot().resolve("cases"))) {
            String rel = libraryRoot().relativize(p)
                .toString()
                .replace('\\', '/');
            JsonObject o = readJson(p);
            JsonArray variants = Json.optArray(o, "variants");
            for (int i = 0; variants != null && i < variants.size(); i++) {
                JsonObject v = variants.get(i)
                    .getAsJsonObject();
                JsonArray mutate = Json.optArray(v, "mutate");
                for (int k = 0; mutate != null && k < mutate.size(); k++) {
                    String pointer = Json.optString(
                        mutate.get(k)
                            .getAsJsonObject(),
                        "path",
                        "");
                    assertTrue(
                        rel + "：变体 "
                            + Json.optString(v, "id", "?")
                            + " 的补丁打到了 "
                            + pointer
                            + "——变体只许改判据/读数（改 world/build 需要真实重建，整跑里不执行，会变成空转绿）",
                        pointer.startsWith("/criteria") || pointer.startsWith("/read")
                            || pointer.startsWith("/action"));
                }
            }
        }
    }

    /** 用例引用的 {@code action} 段不得含收尾原语（与 {@code CaseValidator} 同一禁令名单）。 */
    @Test
    public void casesNeverOrchestrateShutdown() throws IOException {
        for (Path p : jsonFiles(libraryRoot().resolve("cases"))) {
            JsonObject o = readJson(p);
            JsonArray action = Json.optArray(o, "action");
            for (int i = 0; action != null && i < action.size(); i++) {
                String name = Json.optString(
                    action.get(i)
                        .getAsJsonObject(),
                    "action",
                    "");
                assertFalse(
                    libraryRoot()
                        .relativize(p) + "：action[" + i + "] 编排了 " + name + "（收尾原语不得编入固定程序，见 case-file.md §3.2）",
                    CaseValidator.ACTION_FORBIDDEN.contains(name));
            }
        }
    }

    /** 段序契约在资产里被真实使用：至少一份用例用了 {@code action} 段、至少一份用了 {@code read} 段。 */
    @Test
    public void libraryCoversBothNewSegments() throws IOException {
        boolean hasAction = false;
        boolean hasRead = false;
        for (Path p : jsonFiles(libraryRoot().resolve("cases"))) {
            JsonObject o = readJson(p);
            JsonArray a = Json.optArray(o, "action");
            JsonArray r = Json.optArray(o, "read");
            if (a != null && a.size() > 0) {
                hasAction = true;
            }
            if (r != null && r.size() > 0) {
                hasRead = true;
            }
        }
        assertTrue("资产库里没有一份用例使用 action 段（L2 编排能力面未被覆盖）", hasAction);
        assertTrue("资产库里没有一份用例使用 read 段（读面能力面未被覆盖）", hasRead);
    }
}
