package com.lightning.mod.client.controlplane.mc.input;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.List;
import java.util.regex.Pattern;

import org.junit.Test;

/**
 * 未实现清单的**两处同源守卫**（Gitea #166 的 DR-9 / DR-2）。
 *
 * <h2>为什么需要它</h2>
 * 契约 §11.2 的末条写的是「本清单与 {@code input.state.notImplemented} 同源：实现一项就同时删两处，
 * <b>不得</b>只删一处」。但修复前实际有**三**处清单：§11.2（12 条）、
 * {@link InputCapabilities#NOT_IMPLEMENTED}（11 条）、{@code input.state} 实际输出（6 条字面 +
 * 动态缺口）——三者条数与措辞都不同源，「同源」这条规则于是形同虚设（删一处仍不同源）。
 *
 * <p>
 * 本用例把「两处必须一起动」变成编译期之后的第一道红灯：**条数不等即红**。它刻意不去比对逐条措辞
 * （两边详略本来就不同：文档写判据与影响，Java 写机读短句），只钉住「条数」与
 * 「两个必须两边都在的主题」——这两条已经足以擒住「只在一边加/删」这种漂移。
 *
 * <p>
 * <b>已知边界（如实登记）</b>：措辞级漂移（同一条两处越写越不像）本守卫擒不住；那需要逐条 id 化，
 * 属更大的改造（未在 #166 范围内）。
 */
public class InputCapabilitiesDocParityTest {

    /** 契约 §11.2 的表行：{@code | 12 | ... |}。 */
    private static final Pattern TABLE_ROW = Pattern.compile("^\\|\\s*\\d+\\s*\\|.*$");

    private static Path contractDoc() {
        Path dir = Paths.get("")
            .toAbsolutePath()
            .normalize();
        for (int i = 0; i < 8 && dir != null; i++) {
            Path candidate = dir.resolve("docs")
                .resolve("control-plane")
                .resolve("input-contract.md");
            if (Files.isRegularFile(candidate)) {
                return candidate;
            }
            dir = dir.getParent();
        }
        fail("找不到 docs/control-plane/input-contract.md（从 " + Paths.get("") + " 向上 8 层）");
        return null;
    }

    /** §11.2 表里的条目（夹在「### 11.2」与「### 11.3」之间）。 */
    private static List<String> documentedNotImplemented() throws IOException {
        List<String> rows = new ArrayList<String>();
        boolean inSection = false;
        for (String line : Files.readAllLines(contractDoc(), StandardCharsets.UTF_8)) {
            if (line.startsWith("### 11.2")) {
                inSection = true;
                continue;
            }
            if (inSection && line.startsWith("### 11.3")) {
                break;
            }
            if (inSection && TABLE_ROW.matcher(line.trim())
                .matches()) {
                rows.add(line);
            }
        }
        return rows;
    }

    /** 文档 §11.2 与 Java 能力真值表**条数必须相等**（少一处就意味着「只删了一处」）。 */
    @Test
    public void docAndJavaListHaveTheSameNumberOfEntries() throws IOException {
        List<String> doc = documentedNotImplemented();
        assertTrue("守卫自身失效：§11.2 一条都没解析到（解析口径或文档结构变了）", doc.size() >= 10);
        assertEquals(
            "契约 §11.2 与 InputCapabilities.NOT_IMPLEMENTED 必须同源（条数不等 ⇒ 只改了一边；" + "实现一项就同时删两处，不得只删一处）",
            doc.size(),
            InputCapabilities.NOT_IMPLEMENTED.size());
    }

    /**
     * #166 新登记的两条必须**两边都在**：#166 DR-2（滚轮符号未实机校准）与 DR-9
     * （§11.2 第 12 条：组合键事件序与队列满无独立实机判据）。
     */
    @Test
    public void bothSidesCarryTheWheelSignAndCompositeKeyGaps() throws IOException {
        String doc = String.join("\n", documentedNotImplemented());
        String java = String.join("\n", InputCapabilities.NOT_IMPLEMENTED);
        assertTrue("文档侧缺「滚轮符号未校准」", doc.contains("滚轮符号"));
        assertTrue("Java 侧缺「滚轮符号未校准」", java.contains("滚轮符号"));
        assertTrue("文档侧缺「组合键事件序与队列满」", doc.contains("组合键事件序"));
        assertTrue("Java 侧缺「组合键事件序与队列满」", java.contains("组合键事件序"));
        // 这两条都必须带「未测 ≠ 通过 / 不得据此下判据」的诚实口径
        assertTrue(java.contains("未完成") || java.contains("不得据此"));
    }

    /** 已在本批落地的项不许再留在任一侧（否则能力面与文档自相矛盾）。 */
    @Test
    public void completedItemsAreGoneFromBothSides() throws IOException {
        String doc = String.join("\n", documentedNotImplemented());
        String java = String.join("\n", InputCapabilities.NOT_IMPLEMENTED);
        for (String gone : new String[] { "五个动作均未注册", "契约版本未前进", "means 自描述字段", "GUI 截图取证面" }) {
            assertTrue("文档侧仍留在册项: " + gone, !doc.contains(gone));
            assertTrue("Java 侧仍留在册项: " + gone, !java.contains(gone));
        }
    }
}
