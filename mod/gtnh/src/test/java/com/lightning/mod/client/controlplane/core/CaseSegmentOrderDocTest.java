package com.lightning.mod.client.controlplane.core;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Pattern;
import java.util.stream.Stream;

import org.junit.Test;

/**
 * 段序守卫：{@code docs/} 里出现的「{@code case.run} 执行段序」必须与 {@link CaseValidator#SEGMENTS} 一致。
 *
 * <h2>为什么需要它（Gitea #105 / #136）</h2>
 * 段序是**执行序**，但它被复述在四处以上（{@code case-file.md §1/§3.3/§8.1/§8.8}、{@code contract.md}、
 * 技能文档）。2026-10 收口核对实测：文档里出现过 <b>6 种写法只有 2 种对</b>，其中 {@code case-file.md}
 * 的 §8.1 还臆造了一个段名 {@code shots}——照它写 {@code segments:["shots"]} 会当场得
 * {@code CP-VALID-002}（{@code CaseRunAction} 对段名做白名单校验）。原文改掉不等于不会再漂：
 * **下一次加段时，没人会记得把五处副本一起改**。本测试把那件事变成编译期之后的第一道红灯。
 *
 * <h2>判据（宽进严出，避免把散文误判成段序）</h2>
 * <ol>
 * <li>逐行扫描 {@code docs/**\/*.md}；只看**含箭头**（{@code →} / {@code ->} / {@code ⇒}）的行；</li>
 * <li>把该行按箭头切成 token，只保留「整 token 是一个段名的单复数形态」的那些
 * （{@code world}/{@code capture}/{@code build}/{@code read}/{@code action}/{@code export}/
 * {@code cameras}/{@code criteria}/{@code evidence}，以及**常被误当段名的** {@code shots}）；</li>
 * <li>**少于 2 个 token ⇒ 这行不是段序断言，跳过**（散文里带箭头的「卸载 → 删目录 → 建世界」因此不受影响）；</li>
 * <li>命中的 token 序列必须是 {@code SEGMENTS} 的**保序子序列**（允许只说「world 起手、criteria/evidence 收尾」
 * 这类部分列举），且**不得含任何非段名的名字 token**（{@code shots} 即在此被擒）。</li>
 * </ol>
 *
 * <p>
 * 因此：整条链只有一种正确写法（逐字等于 {@code SEGMENTS}）；部分列举按保序校验；
 * 顺序错位与臆造段名都判红，并直接打印期望序与实得序，省掉一次来回。
 *
 * <p>
 * <b>已知边界（如实登记，不要高估本守卫）</b>：
 * <ul>
 * <li><b>「中段被漏写」擒不住</b>：部分列举必须被允许（文档常只写「world 起手 / criteria 收尾」），
 * 而保序子序列剔掉一个中段仍然保序 ⇒「整链少 {@code export}」这种漂移本守卫判不了
 * （{@code guardItselfRejectsWrongOrders} 里有一条断言故意把这个边界钉住）。真正的解法是
 * <b>只留一处段序字面</b>（{@code case-file.md} §1）＋ 加段时改那一处；</li>
 * <li>只覆盖 {@code docs/**\/*.md}：技能文档（{@code .dsh/skills/}）与 {@code scripts/} 下的说明不在树内。</li>
 * </ul>
 * 扩到全仓与「漏段」判据归 Gitea #136。
 */
public class CaseSegmentOrderDocTest {

    /** 段名的单复数形态 ⇒ 规范段名（只有这九个 + 常被误当段名的 {@code shots}）。 */
    private static final Map<String, String> NAME_FORMS = new LinkedHashMap<String, String>();

    static {
        NAME_FORMS.put("world", "world");
        NAME_FORMS.put("capture", "capture");
        NAME_FORMS.put("build", "build");
        NAME_FORMS.put("read", "read");
        NAME_FORMS.put("action", "action");
        NAME_FORMS.put("export", "export");
        NAME_FORMS.put("camera", "cameras");
        NAME_FORMS.put("cameras", "cameras");
        NAME_FORMS.put("criteria", "criteria");
        NAME_FORMS.put("evidence", "evidence");
        // 不是段名，但必须能被识别出来 —— 否则「臆造段名」这条漂移无人守
        NAME_FORMS.put("shot", "shots");
        NAME_FORMS.put("shots", "shots");
    }

    private static final Pattern ARROW = Pattern.compile("\\s*(?:→|->|⇒)\\s*");

    // ------------------------------------------------------------ 路径

    /** {@code <repoRoot>/docs}（从 {@code user.dir} 向上找，和 {@code TestAssetLibraryTest} 同一手法）。 */
    private static Path docsRoot() {
        Path dir = Paths.get("")
            .toAbsolutePath()
            .normalize();
        for (int i = 0; i < 8 && dir != null; i++) {
            Path candidate = dir.resolve("docs")
                .resolve("control-plane");
            if (Files.isDirectory(candidate)) {
                return dir.resolve("docs");
            }
            dir = dir.getParent();
        }
        fail(
            "找不到 docs/ 根（从 " + Paths.get("")
                .toAbsolutePath() + " 向上 8 层没有 docs/control-plane）——段序守卫无法执行");
        return null;
    }

    /** 仓库根（{@code docs/} 的父目录）。 */
    private static Path repoRoot() {
        return docsRoot().getParent();
    }

    private static List<Path> markdownFiles(Path root) throws IOException {
        List<Path> out = new ArrayList<Path>();
        try (Stream<Path> s = Files.walk(root)) {
            s.filter(Files::isRegularFile)
                .filter(
                    p -> p.getFileName()
                        .toString()
                        .endsWith(".md"))
                .forEach(out::add);
        }
        out.sort(
            (a, b) -> a.toString()
                .compareTo(b.toString()));
        return out;
    }

    // ------------------------------------------------------------ 解析

    /**
     * 取出该行里「按箭头串起来的段名序列」。
     *
     * <p>
     * token 判定分两步：①整 token 就是一个段名形态（{@code world} / {@code camera} / {@code shots}…）；
     * ②否则看 token 的**末词**（文档常写成「依序执行 {@code world}」、{@code case.run} 的「{@code 段序: world}」）。
     * 第 ② 步之前有一道排除：末词之前若出现过 {@code .}（{@code world.rebuild}），说明这是**动作引用**
     * 而不是段序 token，整 token 丢弃——否则散文里的 {@code world.rebuild} 会被读成段名 {@code build}。
     *
     * @return 段名序列；**少于 2 个 token 时返回空表**（这行不是段序断言）
     */
    private static List<String> segmentChain(String line) {
        String[] raw = ARROW.split(line);
        if (raw.length < 2) {
            return new ArrayList<String>();
        }
        List<String> chain = new ArrayList<String>();
        for (String tok : raw) {
            String t = tok.trim()
                .replace("`", "")
                .replace("*", "")
                .replace("|", "")
                .replace("_", "")
                .trim();
            String name = NAME_FORMS.get(t.toLowerCase());
            if (name == null) {
                int cut = -1;
                for (int i = 0; i < t.length(); i++) {
                    char c = t.charAt(i);
                    if (c == ' ' || c == '\t'
                        || c == '（'
                        || c == '('
                        || c == '：'
                        || c == ':'
                        || c == ','
                        || c == '，'
                        || c == '。'
                        || c == '、'
                        || c == '；'
                        || c == ';') {
                        cut = i;
                    }
                }
                if (cut >= 0) {
                    String last = t.substring(cut + 1)
                        .trim()
                        .replaceAll("^[\\[\\](){}「」『』\"'*]+", "")
                        .replaceAll("[\\[\\](){}「」『』\"'*]+$", "");
                    // 末词前面的部分若以 . 结尾（world.rebuild），说明这是动作引用而不是段序 token
                    boolean reference = t.substring(0, cut + 1)
                        .indexOf('.') >= 0;
                    if (!reference) {
                        name = NAME_FORMS.get(last.toLowerCase());
                    }
                }
            }
            if (name != null) {
                chain.add(name);
            }
        }
        return chain.size() >= 2 ? chain : new ArrayList<String>();
    }

    /** {@code sub} 是否为 {@code full} 的保序子序列。 */
    private static boolean isOrderedSubsequence(List<String> sub, List<String> full) {
        int i = 0;
        for (String f : full) {
            if (i < sub.size() && sub.get(i)
                .equals(f)) {
                i++;
            }
        }
        return i == sub.size();
    }

    // ------------------------------------------------------------ 断言

    /** 全仓 {@code docs/**\/*.md} 无一处臆造段名 {@code shots} 被当作执行段。 */
    @Test
    public void noDocInventsShotsAsSegment() throws IOException {
        List<String> offenders = new ArrayList<String>();
        for (Path md : markdownFiles(docsRoot())) {
            int lineNo = 0;
            for (String line : Files.readAllLines(md, StandardCharsets.UTF_8)) {
                lineNo++;
                if (segmentChain(line).contains("shots")) {
                    offenders.add(rel(md) + ":" + lineNo + " → " + line.trim());
                }
            }
        }
        assertTrue(
            "段名里不存在 shots（截图属 cameras 段，shots/ 只是产物目录名）——照它写 segments:[\"shots\"] 会得 CP-VALID-002。" + "违规行：\n  "
                + String.join("\n  ", offenders),
            offenders.isEmpty());
    }

    /**
     * 每一处段序断言都与 {@link CaseValidator#SEGMENTS} 一致（整链逐字等于，部分列举按保序子序列）。
     *
     * <p>
     * 注意：本用例**擒不住「中段被漏写」**（见类注释的已知边界）。它擒的是顺序错位、段名臆造、
     * 以及「整链多出一个非段名 token」。
     */
    @Test
    public void everyDocSegmentChainMatchesCaseValidator() throws IOException {
        List<String> canonical = CaseValidator.SEGMENTS;
        List<String> problems = new ArrayList<String>();
        int checked = 0;

        for (Path md : markdownFiles(docsRoot())) {
            int lineNo = 0;
            for (String line : Files.readAllLines(md, StandardCharsets.UTF_8)) {
                lineNo++;
                List<String> chain = segmentChain(line);
                if (chain.isEmpty()) {
                    continue;
                }
                checked++;
                if (!isOrderedSubsequence(chain, canonical)) {
                    problems.add(
                        rel(md) + ":"
                            + lineNo
                            + "\n    文档写的段序: "
                            + chain
                            + "\n    源码权威段序: "
                            + canonical
                            + "\n    该行: "
                            + line.trim());
                }
            }
        }

        assertTrue("docs/ 里必须至少有一处段序断言（否则本守卫是空转）——一处都没扫到说明解析口径坏了", checked >= 1);
        assertTrue(
            "docs/ 里的段序与 CaseValidator.SEGMENTS 不一致（段序即执行序，文档写错会让调用方少跑段或撞 CP-VALID-002）。"
                + "权威 = core/CaseValidator.java 的 SEGMENTS。违规处：\n  "
                + String.join("\n  ", problems),
            problems.isEmpty());
    }

    /**
     * 守卫自身的正/负对照：证明它**真的能**擒住错序与臆造段名（否则「全绿」没有意义）。
     *
     * <p>
     * 口径与 {@code compare-runs.mjs --selftest} 同一条纪律：验证器具先自证能否证伪。
     */
    @Test
    public void guardItselfRejectsWrongOrders() {
        List<String> canonical = CaseValidator.SEGMENTS;
        assertEquals(
            "契约九段（v1.7）",
            Arrays.asList("world", "capture", "build", "read", "action", "export", "cameras", "criteria", "evidence"),
            canonical);

        // 正对照 1：整链（九段逐字等于 SEGMENTS）
        assertEquals(
            "整链必须逐字等于 SEGMENTS",
            canonical,
            segmentChain("world → capture → build → read → action → export → cameras → criteria → evidence"));
        // 正对照 2：紧凑写法（无空格）
        assertEquals(
            "紧凑写法同样必须逐字等于 SEGMENTS",
            canonical,
            segmentChain("`world→capture→build→read→action→export→cameras→criteria→evidence`"));
        // 正对照 3：部分列举（保序）——「world 起手、criteria/evidence 收尾」这类写法合法
        assertTrue(
            isOrderedSubsequence(segmentChain("`world → capture → build → cameras → criteria → evidence`"), canonical));
        assertTrue(isOrderedSubsequence(segmentChain("段序 world → 中段 → criteria，criteria → evidence 必在末两位"), canonical));
        assertTrue(isOrderedSubsequence(segmentChain("world → capture → build → read → action → export"), canonical));

        // 负对照 1：臆造段名 shots（含末词形态「依序执行 world」与紧凑形态）
        assertEquals(
            "臆造段名必须被识别出来",
            Arrays.asList("world", "build", "read", "shots", "criteria", "evidence"),
            segmentChain("依序执行 world → build → read → (shots) → criteria → evidence"));
        assertFalse(
            "带臆造段名的链必须判红",
            isOrderedSubsequence(segmentChain("依序执行 world → build → read → (shots) → criteria → evidence"), canonical));
        assertFalse(
            "紧凑写法的臆造段名同样必须判红",
            isOrderedSubsequence(segmentChain("world→build→read→(shots)→criteria→evidence"), canonical));

        // 负对照 2：顺序错位（action 排到 read 之前）
        assertFalse(
            "错序必须判红",
            isOrderedSubsequence(
                segmentChain("world → capture → build → action → read → export → cameras → criteria → evidence"),
                canonical));

        // 负对照 3：散文里带箭头但不是段序 —— 不足两个段名 token ⇒ 跳过，不误判
        assertTrue("散文不该被误判成段序", segmentChain("卸载当前托管世界 → 删除托管存档目录 → 以固定种子建虚空世界").isEmpty());
        assertTrue("散文不该被误判成段序", segmentChain("位置 = 清场 → 放置 → TE 补全 → 静置").isEmpty());
        // 负对照 4：动作引用形态不算段序 token（`world.rebuild` 走…、`read.*` → `export.*`）
        assertTrue(
            "动作引用形态不该被当成段序 token",
            segmentChain("`world.rebuild` 走「卸载 → 删目录 → 建虚空世界」；`read.*` → `export.*`").isEmpty());
        assertTrue("read-only 这类复合词不该被当成段名", segmentChain("read-only → read-only（两处都是复合词）").isEmpty());

        // ⚠ 守卫的已知边界（如实写进测试，免得后来者高估它）：
        // 部分列举天然无法判「有没有漏段」——保序子序列剔掉一个中段仍然是保序子序列。
        // 因此「整链少 export」这种漂移只由「单源化 + 人工核对」兜住，本守卫擒不住；
        // 若哪天真出这种事，正解是**只留一处段序字面**（见 case-file.md §1）而不是加强正则。
        assertTrue(
            "（边界）保序子序列擒不住「中段被漏写」——这条断言是故意的，用来固定这个已知边界",
            isOrderedSubsequence(
                segmentChain("world → capture → build → read → action → cameras → criteria → evidence"),
                canonical));
    }

    /** 仓库根到该文档的相对路径（报错信息里的可读定位）。 */
    private static String rel(Path md) {
        return repoRoot().relativize(md)
            .toString()
            .replace('\\', '/');
    }

    /** 紧凑写法（段名紧跟箭头、无空格）也必须被识别成段序，不能因为排版差异漏检。 */
    @Test
    public void compactChainWithoutSpacesIsStillParsed() {
        assertEquals(
            CaseValidator.SEGMENTS,
            segmentChain("world→capture→build→read→action→export→cameras→criteria→evidence"));
        assertEquals(
            "段名紧跟箭头 + 括号包裹的臆造段名：紧凑写法同样不放过",
            Arrays.asList("world", "build", "read", "shots", "criteria", "evidence"),
            segmentChain("world→build→read→(shots)→criteria→evidence"));
    }
}
