package com.lightning.mod.client.controlplane.mc.input;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import com.google.gson.JsonObject;
import com.lightning.mod.client.controlplane.core.ActionDescriptor;
import com.lightning.mod.client.controlplane.core.ActionRegistry;
import com.lightning.mod.client.controlplane.core.Json;
import com.lightning.mod.client.controlplane.core.Tier;
import com.lightning.mod.client.controlplane.mc.ActionRegistrar;

/**
 * 「未实现项不得伪装成已具备」的机读防线（契约 §5.2 末条 / §11.2 第 17 条 / D-4）。
 *
 * <p>
 * 这一组断言的存在理由与 {@code ShutdownActionTest} 的定码锁同类：<b>失效模式不可逆</b>。
 * 把「文本路由没打通」写成 {@code supported:true}、把「鼠标侧无探针」写成 {@code false}、
 * 把「未注册」写成「有五个动作」，都会让调用方据此做出错误决策——而且这些默认值看起来都「正常」。
 */
public class InputCapabilitiesTest {

    /** 声明为「未实现」的东西必须真的在能力字段上体现为「未具备」。 */
    @Test
    public void unimplementedIsNotDressedUpAsAvailable() {
        assertFalse("文本路由 P0 实测未打通：不许声明 supported", InputCapabilities.TEXT_SUPPORTED);
        assertFalse(InputCapabilities.TEXT_ROUTE_WORLD);
        assertFalse(InputCapabilities.TEXT_ROUTE_GUI);
        assertEquals(
            "声明范围必须为空（不许写「全 Unicode」这类不可判定声明）",
            0,
            InputCapabilities.textRangesJson()
                .size());
        assertFalse("任何码点都不在声明范围内", InputCapabilities.inDeclaredTextRange(97));
        assertEquals("鼠标侧无公开深度探针", "unobservable", InputCapabilities.MOUSE_QUEUE_DEPTH);
        assertEquals("无世界卸载钩子", "no-hook", InputCapabilities.WORLD_UNLOAD);
        assertEquals("不承诺崩溃后清理", "not-promised", InputCapabilities.CRASH);
        assertEquals("无取消能力", "unavailable", InputCapabilities.CANCEL);
        assertTrue(InputCapabilities.POLL_SURFACE.contains("not-covered"));
    }

    /** 未实现清单非空，且逐条指名（调用方必须能仅凭它判断「做不到什么」）。 */
    @Test
    public void notImplementedListNamesEveryKnownGap() {
        assertTrue(InputCapabilities.NOT_IMPLEMENTED.size() >= 10);
        assertTrue(contains("未注册"));
        assertTrue(contains("契约版本未前进"));
        assertTrue(contains("GUI 文本路由"));
        assertTrue(contains("鼠标侧队列深度"));
        assertTrue(contains("取消"));
        assertTrue(contains("世界卸载"));
        assertTrue(contains("轮询面"));
        assertTrue(contains("relative"));
        assertTrue(contains("自校准"));
        assertTrue(
            "JSON 形态必须可用（T2-B 要直接塞进 input.state.notImplemented）",
            InputCapabilities.notImplementedJson()
                .size() == InputCapabilities.NOT_IMPLEMENTED.size());
    }

    /** 未注册 ⇒ 动作目录为空数组，**不是**五个动作名；`since` 未写入具体版本（§1.4）。 */
    @Test
    public void actionsAreNotClaimedAsRegistered() {
        assertFalse(InputCapabilities.ACTIONS_REGISTERED);
        assertEquals(
            0,
            InputCapabilities.registeredActionsJson()
                .size());
        assertTrue(
            InputCapabilities.SINCE,
            InputCapabilities.SINCE.contains("1.8") && InputCapabilities.SINCE.contains("未写入"));

        // 装配面机械核对：本单没有往注册表里塞任何东西（动作计数仍是 43）
        ActionRegistry registry = new ActionRegistry();
        ActionRegistrar.registerAll(null, registry);
        assertEquals(43, registry.size());
        assertFalse(registry.contains(InputKeyAction.NAME));
        assertFalse(registry.contains(InputTextAction.NAME));
        assertFalse(registry.contains(InputMouseAction.NAME));
        assertFalse(registry.contains(InputReleaseAction.NAME));
    }

    /** 四个动作的自描述齐备、可复制、且示例都带 {@code confirm}（可写动作照抄即能过确认门）。 */
    @Test
    public void descriptorsAreCompleteAndCopyable() {
        ActionDescriptor[] all = new ActionDescriptor[] { InputKeyAction.descriptor(), InputTextAction.descriptor(),
            InputMouseAction.descriptor(), InputReleaseAction.descriptor() };
        for (ActionDescriptor d : all) {
            assertNotNull(d);
            assertEquals("输入动作是 scene 级可写动作（必须 confirm）", Tier.SCENE, d.tier());
            assertTrue(d.writable());
            assertFalse(
                d.description(),
                d.description()
                    .trim()
                    .isEmpty());
            assertFalse(
                d.returns(),
                d.returns()
                    .trim()
                    .isEmpty());
            assertTrue(
                d.name() + " 至少给一条示例",
                d.examples()
                    .size() > 0);
            for (int i = 0; i < d.examples()
                .size(); i++) {
                JsonObject ex = Json.parseStrictObject(
                    Json.toJson(
                        d.examples()
                            .get(i)));
                assertTrue(
                    d.name() + " 示例 " + i + " 必须带 \"confirm\": true（照抄否则被 CP-CONFIRM-001 拒）",
                    Json.optBool(ex, "confirm", false));
            }
            for (ActionDescriptor.Param p : d.params()) {
                assertNotNull(p.description());
                assertFalse(
                    d.name() + "." + p.name() + " 参数说明为空",
                    p.description()
                        .trim()
                        .isEmpty());
            }
        }
    }

    /** 自述里必须写明几条**最容易误认为已具备**的边界（否则调用方只能靠散文/源码）。 */
    @Test
    public void descriptorsCarryTheDangerousBoundaries() {
        String key = InputKeyAction.descriptor()
            .description();
        assertTrue("必须写明「投递成功≠业务成功」", key.contains("投递成功≠业务成功"));
        assertTrue("必须写明组合键只保证事件序", key.contains("组合键只保证事件序"));
        assertTrue("必须写明 down 的持有会到期自动抬起", key.contains("自动抬起"));

        String mouse = InputMouseAction.descriptor()
            .description();
        assertTrue("必须写明「不先 move 就点，点到上一次的位置」", mouse.contains("上一次的位置"));
        assertTrue("必须写明 move 后须等 ≥2 tick", mouse.contains("≥2 tick"));
        assertTrue("必须写明 click 不做隐式 move", mouse.contains("隐式 move"));
        assertTrue("必须写明 relative 失焦不承诺生效", mouse.contains("失焦时不承诺生效"));

        String text = InputTextAction.descriptor()
            .description();
        assertTrue("必须写明能力未就绪时 CP-STATE-001", text.contains("CP-STATE-001"));
        assertTrue("必须写明不静默丢弃/不替换", text.contains("不静默丢弃") || text.contains("不替换"));
        assertTrue("必须写明不直接改控件值", text.contains("不 setText") || text.contains("绝不直接改控件值"));

        String release = InputReleaseAction.descriptor()
            .description();
        assertTrue("必须写明只清设施所持", release.contains("只清设施所持"));
        assertTrue("必须写明不碰轮询面", release.contains("isKeyDown"));
    }

    /** 上限与清理路径的口径逐条落常量（§3.2 / §3.4）。 */
    @Test
    public void limitsAndCleanupPathsAreFrozen() {
        assertEquals(1200, InputCapabilities.HOLD_TICKS_MAX);
        assertEquals(8, InputCapabilities.WHEEL_AMOUNT_MAX);
        assertEquals(2, InputCapabilities.MIN_SETTLE_TICKS);
        assertEquals(256, InputCapabilities.KEYBOARD_QUEUE_CAPACITY);
        assertEquals(1, InputCapabilities.KEYBOARD_SEED_BASELINE);
        assertEquals(0, InputCapabilities.KEY_CODE_MIN);
        assertEquals(255, InputCapabilities.KEY_CODE_MAX);

        assertEquals(5, InputCapabilities.CLEANUP_PATHS.size());
        assertEquals(
            "normal-completion",
            InputCapabilities.CLEANUP_PATHS.get(0)
                .id());
        assertEquals(
            "promised",
            InputCapabilities.CLEANUP_PATHS.get(0)
                .strength());
        assertEquals(
            "process-exit",
            InputCapabilities.CLEANUP_PATHS.get(4)
                .id());
        assertEquals(
            "best-effort",
            InputCapabilities.CLEANUP_PATHS.get(4)
                .strength());
        assertEquals(
            "机读形态与常量同源",
            5,
            InputCapabilities.cleanupPathsJson()
                .size());
    }

    /** 白名单五个入口与错误码清单（§1.2 / §6.1）。 */
    @Test
    public void injectorWhitelistAndErrorCodesAreListed() {
        assertEquals(5, InputCapabilities.INJECTORS.size());
        assertEquals("Keyboard.addRawKeyEvent", InputCapabilities.INJECTORS.get(0));
        assertEquals("Mouse.addWheelEvent", InputCapabilities.INJECTORS.get(4));
        assertEquals(
            5,
            InputCapabilities.errorsJson()
                .size());
        assertTrue(
            InputCapabilities.errorsJson()
                .toString()
                .contains("CP-VALID-002"));
        assertFalse(
            "本族不新增错误码",
            InputCapabilities.errorsJson()
                .toString()
                .contains("CP-INPUT"));
    }

    /** 探测面：不可用时必须给出**原因**，且逐入口状态自洽（不假装可用）。 */
    @Test
    public void injectorProbeIsHonestWhenNothingIsOnTheClasspath() {
        // 用一个「什么都找不到」的类加载器探测：离线环境（单测 JVM）没有 org.lwjglx/**
        ClassLoader empty = new ClassLoader(null) {};
        Lwjgl3ifyInjector inj = Lwjgl3ifyInjector.probe(empty);
        assertFalse(inj.available());
        assertNotNull("不可用时必须给出原因（如实暴露边界）", inj.unavailableReason());
        assertEquals(
            5,
            inj.entries()
                .size());
        for (InputSink.Entry e : inj.entries()) {
            assertFalse(e.name(), e.available());
            assertNotNull(e.name() + " 缺不可用原因", e.reason());
        }
        JsonObject probe = inj.probeJson();
        assertEquals(
            "sdl",
            probe.get("backend")
                .getAsString());
        assertFalse(
            probe.get("available")
                .getAsBoolean());
        // 不可用时写入口必须显式抛（不许静默 no-op 后返回成功）
        try {
            inj.key(17, 0, true);
            org.junit.Assert.fail("不可用的注入面必须抛 InputInjectionException");
        } catch (InputInjectionException e) {
            assertEquals(
                "能力未就绪归 CP-STATE-001（§6.1）",
                com.lightning.mod.client.controlplane.core.ErrorCodes.STATE,
                e.code());
        }
    }

    private static boolean contains(String needle) {
        for (String s : InputCapabilities.NOT_IMPLEMENTED) {
            if (s.contains(needle)) {
                return true;
            }
        }
        return false;
    }
}
