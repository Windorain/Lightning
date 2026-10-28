package com.lightning.mod.client.controlplane.mc.cmd;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import java.util.Arrays;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;

import org.junit.Test;

import com.lightning.mod.client.controlplane.core.Tier;

/**
 * {@link SdeCommandWhitelist} 的白名单边界锁（白名单边界）。
 *
 * <p>
 * <b>为什么值得单测</b>：白名单是安全边界，它的失效形态是「静默放行」——没有异常、没有日志，
 * 只有一条本不该跑的命令跑掉了。这类缺陷靠实机很难发现（要恰好想到去试那条命令），
 * 靠代码评审也容易漏（表是数据，不是逻辑）。因此这里把三条不变式钉成断言：
 *
 * <ol>
 * <li><b>准入集与任务单逐字一致</b>：15 条，一个不多一个不少——「多」意味着越权，「少」意味着缺能力；</li>
 * <li><b>排除集与理由齐备</b>：{@code web}/{@code webstop}/{@code hajimi}/{@code hjm} 必须在排除表里
 * <b>且</b>带非空理由（含糊的拒绝理由等于没有理由，失败必须显式）；</li>
 * <li><b>未登记即拒绝</b>：任何不在两张表里的子命令（含 {@code /sde} 未来新增的）走
 * {@code NOT_WHITELISTED}，<b>绝不</b>默认放行。这是「显式枚举」相对「排除法默认放行」的全部价值所在。</li>
 * </ol>
 *
 * <p>
 * 本类不触碰 MC，纯表逻辑，因此可在无渲染环境的单测里跑（与 core 层同款约束）。
 */
public class SdeCommandWhitelistTest {

    /** 15 条准入子命令（逐字白名单）。 */
    private static final List<String> EXPECTED_ALLOWED = Arrays.asList(
        "pos1",
        "pos2",
        "hpos1",
        "hpos2",
        "sel",
        "start",
        "end",
        "setname",
        "setframe",
        "setstructureid",
        "record",
        "export",
        "multiblock",
        "dump",
        "status");

    /** 4 条排除子命令（逐字白名单）。 */
    private static final List<String> EXPECTED_EXCLUDED = Arrays.asList("web", "webstop", "hajimi", "hjm");

    @Test
    public void allowedSetMatchesTaskCardExactly() {
        Set<String> actual = new LinkedHashSet<String>(SdeCommandWhitelist.allowedSubcommands());
        assertEquals("白名单准入集必须与契约 §7.6 白名单逐字一致（增删都算验收不符）", new LinkedHashSet<String>(EXPECTED_ALLOWED), actual);
        assertEquals(
            "准入条数",
            EXPECTED_ALLOWED.size(),
            SdeCommandWhitelist.allowedSubcommands()
                .size());
    }

    @Test
    public void excludedSetMatchesTaskCardAndEveryReasonIsNonEmpty() {
        assertEquals(
            "排除集必须与契约 §7.6 白名单一致",
            new LinkedHashSet<String>(EXPECTED_EXCLUDED),
            new LinkedHashSet<String>(SdeCommandWhitelist.excludedSubcommands()));
        for (String sub : EXPECTED_EXCLUDED) {
            String reason = SdeCommandWhitelist.exclusionReason(sub);
            assertNotNull("被排除子命令必须给出理由: " + sub, reason);
            assertTrue(
                "排除理由不得为空: " + sub,
                reason.trim()
                    .length() > 10);
            assertEquals(
                "被排除子命令的判定必须是 EXCLUDED",
                SdeCommandWhitelist.Decision.EXCLUDED,
                SdeCommandWhitelist.classify("sde", sub));
        }
    }

    @Test
    public void everyAllowedSubcommandClassifiesAsAllowedWithEntry() {
        for (String sub : EXPECTED_ALLOWED) {
            SdeCommandWhitelist.Decision d = SdeCommandWhitelist.classify("sde", sub);
            assertEquals("应放行: " + sub, SdeCommandWhitelist.Decision.ALLOWED, d);
            SdeCommandWhitelist.Entry e = SdeCommandWhitelist.entry(sub);
            assertNotNull("放行条目必须有自描述: " + sub, e);
            assertEquals("条目名应与子命令一致", sub, e.sub());
            assertNotNull("条目必须有权限级: " + sub, e.tier());
            assertNotNull("条目必须有语义摘要: " + sub, e.summary());
            assertFalse(
                "条目摘要不得为空: " + sub,
                e.summary()
                    .trim()
                    .isEmpty());
        }
    }

    /** 未登记即拒绝：白名单机制的**全部价值**——新子命令不登记时默认是「拒」，不是「放」。 */
    @Test
    public void unregisteredSubcommandIsRejectedNotAllowed() {
        assertEquals(
            "未登记子命令必须判 NOT_WHITELISTED（默认放行是安全缺陷）",
            SdeCommandWhitelist.Decision.NOT_WHITELISTED,
            SdeCommandWhitelist.classify("sde", "futureSubcommandNobodyRegistered"));
        assertNull("未登记子命令不得有白名单条目", SdeCommandWhitelist.entry("futureSubcommandNobodyRegistered"));
        assertNull(
            "未登记子命令不得有排除理由（它是「没登记」而不是「被排除」）",
            SdeCommandWhitelist.exclusionReason("futureSubcommandNobodyRegistered"));
    }

    /** 裸 {@code /sde}（无子命令）也是未登记，必须拒。 */
    @Test
    public void bareSdeWithNoSubcommandIsRejected() {
        assertEquals(SdeCommandWhitelist.Decision.NOT_WHITELISTED, SdeCommandWhitelist.classify("sde", null));
        assertEquals(SdeCommandWhitelist.Decision.NOT_WHITELISTED, SdeCommandWhitelist.classify("sde", ""));
        assertEquals(SdeCommandWhitelist.Decision.NOT_WHITELISTED, SdeCommandWhitelist.classify("sde", "   "));
    }

    /** 任意非 /sde 根命令一律 NOT_SDE（白名单只覆盖一个根命令）。 */
    @Test
    public void nonSdeRootCommandIsNotSde() {
        for (String root : Arrays.asList("op", "give", "tp", "time", "gamemode", "sde2", "")) {
            assertEquals(
                "非 /sde 根命令必须判 NOT_SDE: " + root,
                SdeCommandWhitelist.Decision.NOT_SDE,
                SdeCommandWhitelist.classify(root, "status"));
        }
        assertEquals(
            "null 根命令也必须判 NOT_SDE（不是 null、更不是放行）",
            SdeCommandWhitelist.Decision.NOT_SDE,
            SdeCommandWhitelist.classify(null, "status"));
    }

    /** 大小写与首尾空白不构成绕过通道（命令本身大小写不敏感，判定必须同口径）。 */
    @Test
    public void classificationIsCaseAndWhitespaceInsensitive() {
        for (String variant : Arrays.asList("SDE", "sde", "Sde", " sde ", "\tsde")) {
            assertEquals(
                "根命令变体应等价: " + variant,
                SdeCommandWhitelist.Decision.ALLOWED,
                SdeCommandWhitelist.classify(variant, "status"));
        }
        for (String variant : Arrays.asList("STATUS", "Status", " status ", "sTaTus")) {
            assertEquals(
                "子命令变体应等价: " + variant,
                SdeCommandWhitelist.Decision.ALLOWED,
                SdeCommandWhitelist.classify("sde", variant));
        }
        // 排除项同样不因大小写而放行——这是最可能被「顺手写成 contains」而破防的一处
        for (String variant : Arrays.asList("WEB", "Web", " web ", "HAJIMI", "Hjm")) {
            SdeCommandWhitelist.Decision d = SdeCommandWhitelist.classify("sde", variant);
            assertEquals("排除项大小写变体必须仍被排除: " + variant, SdeCommandWhitelist.Decision.EXCLUDED, d);
        }
    }

    /** 权限级定级：只有 status 是纯只读，其余准入项都是可写级（scene）。 */
    @Test
    public void tierAssignmentIsObserveOnlyForStatusAndSceneForTheRest() {
        assertEquals(
            Tier.OBSERVE,
            SdeCommandWhitelist.entry("status")
                .tier());
        for (String sub : EXPECTED_ALLOWED) {
            if ("status".equals(sub)) {
                continue;
            }
            Tier t = SdeCommandWhitelist.entry(sub)
                .tier();
            assertEquals("准入项应登记为 scene: " + sub, Tier.SCENE, t);
            assertTrue("scene 是可写级 ⇒ 契约 §2 第 4 条自动要求 confirm: " + sub, t.isWritable());
        }
        assertFalse("observe 不是可写级 ⇒ status 不需要 confirm", Tier.OBSERVE.isWritable());
    }

    /** 已知子命令集 = 准入 + 排除（供动作区分「没登记」与「被排除」两类拒绝）。 */
    @Test
    public void knownSubcommandsIsUnionOfBothTables() {
        Set<String> known = SdeCommandWhitelist.knownSubcommands();
        assertTrue(known.containsAll(EXPECTED_ALLOWED));
        assertTrue(known.containsAll(EXPECTED_EXCLUDED));
        assertEquals(EXPECTED_ALLOWED.size() + EXPECTED_EXCLUDED.size(), known.size());
    }
}
