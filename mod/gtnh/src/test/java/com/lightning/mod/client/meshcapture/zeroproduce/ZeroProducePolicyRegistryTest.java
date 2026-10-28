package com.lightning.mod.client.meshcapture.zeroproduce;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.util.Collections;

import net.minecraft.tileentity.TileEntity;

import org.junit.After;
import org.junit.Before;
import org.junit.Test;

import com.lightning.mod.client.meshcapture.env.Capability;
import com.lightning.mod.client.meshcapture.env.CaptureEnvironment;
import com.lightning.mod.client.meshcapture.env.CaptureEnvironmentFacts;
import com.lightning.mod.client.meshcapture.env.CaptureEnvironmentFacts.Fact;
import com.lightning.mod.client.meshcapture.zeroproduce.ZeroProducePolicy.Decision;

/**
 * {@link ZeroProducePolicyRegistry} 的裁决语义：优先级升序、首条命中、异常隔离，
 * 以及"本表永不返回空"——没有裁决就等于把这一格退回静默空气，那是唯一不能产生的结局。
 * <p>
 * 用例不加载任何客户端状态：{@link ZeroProduceContext} 的方块与 TE 都可以为 {@code null}，
 * 策略读到的只是"有没有特殊渲染器/有没有尝试渲染/环境事实怎么说"这些显式入参。
 */
public class ZeroProducePolicyRegistryTest {

    private static final int STATIC_RENDER_TYPE = 0;

    private static final int NO_STATIC_RENDER_TYPE = -1;

    @Before
    public void setUp() {
        ZeroProducePolicyRegistry.resetPoliciesForTesting();
    }

    @After
    public void tearDown() {
        ZeroProducePolicyRegistry.resetPoliciesForTesting();
    }

    @Test
    public void plainZeroProduceCellFallsToLastResort() {
        Decision d = ZeroProducePolicyRegistry
            .decide(ctx(0, STATIC_RENDER_TYPE, null, false, false, CaptureEnvironment.allUnknown("test")));
        assertEquals(Decision.Kind.PLACEHOLDER, d.kind());
        assertEquals(LastResortPlaceholderPolicy.REASON, d.reason());
    }

    @Test
    public void tesrOnlyCellGetsTheSpecificReason() {
        Decision d = ZeroProducePolicyRegistry
            .decide(ctx(0, NO_STATIC_RENDER_TYPE, null, true, true, CaptureEnvironment.allUnknown("test")));
        assertEquals(Decision.Kind.PLACEHOLDER, d.kind());
        assertEquals(TesrOnlyBlockPlaceholderPolicy.REASON, d.reason());
    }

    @Test
    public void tesrOnlyPolicyKeepsSpecificReasonWhenNothingWasObservedEvenIfMechanismIsCapturable() {
        CaptureEnvironmentFacts facts = new CaptureEnvironmentFacts();
        facts.setCapability(Fact.MODEL_RENDERER_GEOMETRY, Capability.CAN_CAPTURE);
        Decision d = ZeroProducePolicyRegistry
            .decide(ctx(0, NO_STATIC_RENDER_TYPE, null, 0, true, true, facts.toEnvironment(1L)));
        // 全局"机制可用"推不出"这一格经过它"：一个动态顶点都没收到（几何只在显示列表/缓存网格里）
        // 仍然要给"读不到几何"的具体原因，而不是含糊的 zero_produce
        assertEquals(Decision.Kind.PLACEHOLDER, d.kind());
        assertEquals(TesrOnlyBlockPlaceholderPolicy.REASON, d.reason());
    }

    @Test
    public void tesrOnlyPolicyStepsAsideOnlyWhenDynamicVerticesWereObservedButNoQuadClosed() {
        CaptureEnvironmentFacts facts = new CaptureEnvironmentFacts();
        facts.setCapability(Fact.MODEL_RENDERER_GEOMETRY, Capability.CAN_CAPTURE);
        Decision d = ZeroProducePolicyRegistry
            .decide(ctx(0, NO_STATIC_RENDER_TYPE, null, 12, true, true, facts.toEnvironment(1L)));
        // 顶点进来过、却没闭合成面：这是真正的零产出异常，交给兜底给 zero_produce
        assertEquals(Decision.Kind.PLACEHOLDER, d.kind());
        assertEquals(LastResortPlaceholderPolicy.REASON, d.reason());
    }

    @Test
    public void cellWithoutCopyTileEntityIsNeverDeclaredEmpty() {
        // 没有副本 TE 就没有状态可判：不得据此宣布"合法空"
        Decision d = ZeroProducePolicyRegistry
            .decide(ctx(0, NO_STATIC_RENDER_TYPE, null, true, true, CaptureEnvironment.allUnknown("test")));
        assertFalse(d.kind() == Decision.Kind.DECLARED_EMPTY);
    }

    @Test
    public void lowerPriorityPolicyWinsOverBuiltIns() {
        ZeroProducePolicyRegistry.register(new ZeroProducePolicy() {

            @Override
            public int priority() {
                return 500;
            }

            @Override
            public boolean applies(ZeroProduceContext ctx) {
                return ctx.quadCount() == 0;
            }

            @Override
            public Decision decide(ZeroProduceContext ctx) {
                return Decision.declaredEmpty("custom_declaration");
            }
        });
        Decision d = ZeroProducePolicyRegistry
            .decide(ctx(0, NO_STATIC_RENDER_TYPE, null, true, true, CaptureEnvironment.allUnknown("test")));
        assertEquals(Decision.Kind.DECLARED_EMPTY, d.kind());
        assertEquals("custom_declaration", d.reason());
    }

    @Test
    public void throwingPolicyDoesNotSwallowTheCell() {
        ZeroProducePolicyRegistry.register(new ZeroProducePolicy() {

            @Override
            public int priority() {
                return 10;
            }

            @Override
            public boolean applies(ZeroProduceContext ctx) {
                throw new IllegalStateException("applies blew up");
            }

            @Override
            public Decision decide(ZeroProduceContext ctx) {
                throw new IllegalStateException("decide must not be reached");
            }
        });
        Decision d = ZeroProducePolicyRegistry
            .decide(ctx(0, STATIC_RENDER_TYPE, null, false, false, CaptureEnvironment.allUnknown("test")));
        assertEquals(LastResortPlaceholderPolicy.REASON, d.reason());
    }

    @Test
    public void registryNeverReturnsNullEvenWhenNothingApplies() {
        Decision d = ZeroProducePolicyRegistry.decide(null);
        assertEquals(Decision.Kind.PLACEHOLDER, d.kind());
        assertEquals(ZeroProducePolicyRegistry.REASON_NO_POLICY_APPLIED, d.reason());
        // 有几何的格本不该走到裁决，但即使走到了，也不得出现"没有裁决"
        Decision withQuads = ZeroProducePolicyRegistry
            .decide(ctx(3, STATIC_RENDER_TYPE, null, false, false, CaptureEnvironment.allUnknown("test")));
        assertEquals(ZeroProducePolicyRegistry.REASON_NO_POLICY_APPLIED, withQuads.reason());
    }

    @Test
    public void tesrBackedCellGetsTheSpecificReasonEvenWhenBlockReportsAStaticRenderType() {
        // 原版箱子报告 renderType 0，却没有静态几何：不能被"静态渲染类型"这个标记挡在门外
        Decision d = ZeroProducePolicyRegistry
            .decide(ctx(0, STATIC_RENDER_TYPE, null, true, true, CaptureEnvironment.allUnknown("test")));
        assertEquals(TesrOnlyBlockPlaceholderPolicy.REASON, d.reason());
    }

    @Test
    public void declaredEmptyIsEvaluatedBeforePlaceholderPolicies() {
        // 名单必须排在占位策略之前，否则合法为空的格会先被判成占位、名单永远轮不到
        assertTrue(new DeclaredEmptyPolicy().priority() < new TesrOnlyBlockPlaceholderPolicy().priority());
        assertTrue(new DeclaredEmptyPolicy().priority() < new LastResortPlaceholderPolicy().priority());
    }

    @Test
    public void builtInPoliciesAreAllRegistered() {
        assertTrue(ZeroProducePolicyRegistry.policyCount() >= 3);
    }

    /** 只填裁决需要的入参；方块与 TE 一律 null（用例不加载客户端状态）。 */
    private static ZeroProduceContext ctx(int quadCount, int renderType, TileEntity te, boolean specialRendererPresent,
        boolean tesrAttempted, CaptureEnvironment env) {
        return ctx(quadCount, renderType, te, 0, specialRendererPresent, tesrAttempted, env);
    }

    private static ZeroProduceContext ctx(int quadCount, int renderType, TileEntity te, int dynamicVertexCount,
        boolean specialRendererPresent, boolean tesrAttempted, CaptureEnvironment env) {
        return new ZeroProduceContext(
            0,
            0,
            0,
            100,
            64,
            200,
            null,
            0,
            "minecraft:chest",
            renderType,
            te,
            quadCount,
            Collections.<String, Integer>emptyMap(),
            dynamicVertexCount,
            tesrAttempted,
            specialRendererPresent,
            env);
    }
}
