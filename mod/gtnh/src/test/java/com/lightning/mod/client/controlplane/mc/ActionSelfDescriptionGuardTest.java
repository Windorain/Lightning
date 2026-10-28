package com.lightning.mod.client.controlplane.mc;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import com.lightning.mod.client.controlplane.core.ActionDescriptor;
import com.lightning.mod.client.controlplane.core.ActionRegistry;

/**
 * **自描述漂移**守卫（实机验收 L-W6b / L-W7a；同一族失效模式）。
 *
 * <h2>它防的是什么</h2>
 * 「无先验知识的调用方仅凭 {@code GET /cp/v1/actions} 就能完成调用」是本项目的验收锚之一。
 * 有两类漂移会让它**静默**失效，而且两类都不会让任何既有断言变红：
 * <ol>
 * <li><b>实现读了自描述没声明的参数</b>：{@code shot.multi} 的实现读 {@code params.gui}，
 * 而自描述压根没这个参数 ⇒ {@code caller.mjs} 这类「只按自描述构造调用」的调用方**开不了 GUI 实拍**
 * （实测：GUI 实拍判据因此不可达，只能靠 {@code --allow-unknown-params} 直传绕过，
 * 而绕过就等于放弃了「无先验知识」这条验收锚）。</li>
 * <li><b>返回值形态与自描述不符</b>：{@code input.mouse} 的 {@code returns} 是**全族**口径并写了
 * {@code hitSet}，但实现只在 {@code op=move} 分支返回它 ⇒ 调用方在 {@code down}/{@code click} 上
 * 读不到命中集状态，只能靠源码猜。</li>
 * </ol>
 *
 * <p>
 * 两条都在 {@code ActionRegistrar} 里断言——因为「自描述与行为同步」这件事的唯一装配点就是那里。
 * 判据刻意写得**具体**（点名参数、默认值、关键词），否则一个空转的「字段存在」断言拦不住漂移。
 */
public class ActionSelfDescriptionGuardTest {

    private static ActionRegistry registry() {
        ActionRegistry r = new ActionRegistry();
        ActionRegistrar.registerAll(null, r);
        return r;
    }

    /**
     * W7a：{@code shot.multi} 必须**声明** {@code gui} 参数，且默认值为 {@code none}。
     *
     * <p>
     * 实机后果（若不声明）：调用方按自描述构造的请求里永远不会出现 {@code gui}，
     * 于是「GUI 实拍」这条能力对无先验调用方**不可达**——而实现明明支持它。
     */
    @Test
    public void shotMultiDeclaresTheGuiParameterItActuallyReads() {
        ActionDescriptor d = registry().descriptor("shot.multi");
        assertNotNull("shot.multi 必须已注册", d);

        ActionDescriptor.Param gui = null;
        for (ActionDescriptor.Param p : d.params()) {
            if ("gui".equals(p.name())) {
                gui = p;
                break;
            }
        }
        assertNotNull("shot.multi 的实现读 params.gui，自描述就必须声明它（否则无先验调用方开不了 GUI 实拍）", gui);
        assertFalse("gui 应是可选参数", gui.required());
        assertNotNull("gui 必须有可见的默认值（调用方要能判断「不写会发生什么」）", gui.defaultValue());
        assertEquals(
            "默认必须是 none（默认路径逐字节可比）",
            "none",
            gui.defaultValue()
                .getAsString());

        String desc = gui.description();
        assertNotNull(desc);
        assertTrue("说明必须给出 screen 这个取值", desc.contains("screen"));
        assertTrue("说明必须点名产物差异 guiHidden", desc.contains("guiHidden"));
        assertTrue("说明必须点名产物差异 guiCapture", desc.contains("guiCapture"));
        assertTrue("说明必须写明「开了它 meta 的 sha 会变」——否则会被当成回归", desc.contains("sha"));

        String returns = d.returns();
        assertTrue("返回值说明里必须出现 gui 模式", returns.contains("gui"));
        assertTrue("返回值说明里必须出现 guiCapture", returns.contains("guiCapture"));
        assertTrue("返回值说明里必须出现 guiHidden", returns.contains("guiHidden"));
    }

    /**
     * W6b：{@code input.mouse} 的返回值说明必须把 {@code hitSet} 的**适用 op** 写清楚，
     * 且实现必须在 move 之外也真的给（实现侧由实机判据 W6b 覆盖）。
     */
    @Test
    public void inputMouseDescribesHitSetForEveryOperationThatReturnsIt() {
        ActionDescriptor d = registry().descriptor("input.mouse");
        assertNotNull("input.mouse 必须已注册", d);
        String returns = d.returns();
        assertTrue("必须声明 hitSet", returns.contains("hitSet"));
        assertTrue("必须声明 hitSet 的 appliesTo（区分「本次 move」与「此前那次 move」）", returns.contains("appliesTo"));
        assertTrue(
            "必须点名非 move 的那种口径 preceding-move，否则 down/click 的读数会被误读成「本动作自己已校准」",
            returns.contains("preceding-move"));
        assertTrue("必须写明哪些 op 带 hitSet", returns.contains("move/down/up/click/wheel"));
        assertTrue("relative 无命中集这件事要写明，否则调用方会一直等这个字段", returns.contains("relative"));
    }
}
