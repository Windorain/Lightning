package com.lightning.mod.client.meshcapture.env;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

import org.junit.After;
import org.junit.Before;
import org.junit.Test;

import com.lightning.mod.client.meshcapture.env.CaptureEnvironmentFacts.Fact;

/**
 * {@link CaptureEnvironmentRegistry}：与三张捕获策略表同构的那几条纪律——优先级升序、{@code applies} 过滤、
 * 逐条异常隔离、快照缓存与失效，以及"没跑过探测就一律保守 UNKNOWN"。
 * <p>
 * 这些用例不渲染任何东西：上下文一律 {@link CaptureProbeContext#forTesting(long)}（GL 不可用），
 * 内置自证探针因此在第一道判断就写 UNKNOWN 返回，不触碰客户端状态。
 */
public class CaptureEnvironmentRegistryTest {

    private static final long TEST_SESSION = 7L;

    /** 本用例实例的执行顺序记录（探针持有所属用例实例的引用，不会串到别的用例）。 */
    private final List<String> order = new ArrayList<String>();

    @Before
    public void setUp() {
        // 注册表是全局的：每个用例都从内置探针集合重新出发，避免用例之间互相污染
        CaptureEnvironmentRegistry.resetProbesForTesting();
        order.clear();
    }

    @After
    public void tearDown() {
        CaptureEnvironmentRegistry.resetCacheForTesting();
    }

    @Test
    public void probeNeverRanStaysConservativeUnknown() {
        CaptureEnvironment env = CaptureEnvironmentRegistry.current();
        assertEquals(Capability.UNKNOWN, env.tessellatorVertices());
        assertEquals(Capability.UNKNOWN, env.modelRendererGeometry());
        assertEquals(Capability.UNKNOWN, env.directTessellatorVertices());
        assertEquals(TogglePresence.UNKNOWN, env.angelicaTesrChestCacheToggle());
        assertEquals(ModelAccessPresence.UNKNOWN, env.tankModelAccess());
        assertNull("未采集时必须与\"采集到空集\"区分开", env.handlers());
        assertEquals(0L, env.generation());
        assertTrue(
            env.notes()
                .contains("probe_never_ran"));
    }

    @Test
    public void snapshotIsCachedUntilInvalidatedOrForced() {
        CaptureEnvironment first = CaptureEnvironmentRegistry
            .snapshot(CaptureProbeContext.forTesting(TEST_SESSION), false);
        assertEquals(1L, first.generation());
        CaptureEnvironment second = CaptureEnvironmentRegistry
            .snapshot(CaptureProbeContext.forTesting(TEST_SESSION), false);
        assertEquals("未要求重跑时必须复用同一份快照", 1L, second.generation());
        assertTrue(first == second);

        CaptureEnvironmentRegistry.invalidate("test-invalidate");
        CaptureEnvironment third = CaptureEnvironmentRegistry
            .snapshot(CaptureProbeContext.forTesting(TEST_SESSION), false);
        assertEquals("失效之后下一次探测必须重跑", 2L, third.generation());

        CaptureEnvironment fourth = CaptureEnvironmentRegistry
            .snapshot(CaptureProbeContext.forTesting(TEST_SESSION), true);
        assertEquals("显式诊断请求无视缓存", 3L, fourth.generation());
    }

    @Test
    public void builtInSelfProofProbesDegradeToUnknownWithoutGlContext() {
        CaptureEnvironment env = CaptureEnvironmentRegistry
            .snapshot(CaptureProbeContext.forTesting(TEST_SESSION), true);
        assertEquals(Capability.UNKNOWN, env.tessellatorVertices());
        assertEquals(Capability.UNKNOWN, env.modelRendererGeometry());
        boolean sawSkipNote = false;
        boolean sawBatchingNote = false;
        for (String note : env.notes()) {
            if (note.startsWith("tessellator_vertices: skipped")) {
                sawSkipNote = true;
            }
            if (note.startsWith("tesr_batching:")) {
                sawBatchingNote = true;
            }
        }
        assertTrue("GL 不可用必须留下可解释的说明，而不是静默 UNKNOWN", sawSkipNote);
        assertTrue("批处理标签是无条件的只读事实，必须留下读数", sawBatchingNote);
        assertTrue(CaptureEnvironmentRegistry.probeCount() >= 5);
    }

    @Test
    public void probesRunInPriorityOrderAndSkippedProbesDoNotRun() {
        CaptureEnvironmentRegistry.register(new RecordingProbe(50));
        CaptureEnvironmentRegistry.register(new SkippedProbe());
        CaptureEnvironmentRegistry.register(new RecordingProbe(6000));

        CaptureEnvironmentRegistry.snapshot(CaptureProbeContext.forTesting(TEST_SESSION), true);
        assertEquals("数值小的先跑", Arrays.asList("p50", "p6000"), order);
        assertFalse("applies 为 false 的探针不得执行", order.contains("skipped"));
    }

    @Test
    public void laterProbeOverridesFactWrittenEarlier() {
        CaptureEnvironmentRegistry
            .register(new FactWritingProbe(600, Fact.TESSELLATOR_VERTICES, Capability.CAN_CAPTURE));
        CaptureEnvironmentRegistry
            .register(new FactWritingProbe(700, Fact.MODEL_RENDERER_GEOMETRY, Capability.CANNOT_CAPTURE));

        CaptureEnvironment env = CaptureEnvironmentRegistry
            .snapshot(CaptureProbeContext.forTesting(TEST_SESSION), true);
        assertEquals(Capability.CAN_CAPTURE, env.tessellatorVertices());
        assertEquals(Capability.CANNOT_CAPTURE, env.modelRendererGeometry());
    }

    @Test
    public void throwingProbeOnlyDegradesItsOwnFact() {
        CaptureEnvironmentRegistry.register(new ThrowingProbe());
        CaptureEnvironmentRegistry
            .register(new FactWritingProbe(700, Fact.DIRECT_TESSELLATOR_VERTICES, Capability.CAN_CAPTURE));

        CaptureEnvironment env = CaptureEnvironmentRegistry
            .snapshot(CaptureProbeContext.forTesting(TEST_SESSION), true);
        assertEquals(Capability.CAN_CAPTURE, env.directTessellatorVertices());
        boolean sawFailure = false;
        for (String note : env.notes()) {
            if (note.startsWith("probe_failed:")) {
                sawFailure = true;
            }
        }
        assertTrue("探针抛错必须留痕，且只降级它自己写的事实", sawFailure);
    }

    @Test
    public void handlersNullMeansNotCollected() {
        CaptureEnvironmentFacts facts = new CaptureEnvironmentFacts();
        assertNull(facts.handlers());
        facts.setHandlers(new ArrayList<String>());
        assertEquals(
            0,
            facts.handlers()
                .size());
        CaptureEnvironment env = facts.toEnvironment(9L);
        assertEquals(
            0,
            env.handlers()
                .size());
        assertEquals(Capability.UNKNOWN, env.get(Fact.MODEL_RENDERER_HANDLERS));
    }

    /** 只记录执行顺序，不写事实。 */
    private final class RecordingProbe implements CaptureEnvironmentProbe {

        private final int priority;

        RecordingProbe(int priority) {
            this.priority = priority;
        }

        @Override
        public int priority() {
            return priority;
        }

        @Override
        public boolean applies(CaptureProbeContext ctx) {
            return true;
        }

        @Override
        public void probe(CaptureProbeContext ctx, CaptureEnvironmentFacts out) {
            order.add("p" + priority);
        }
    }

    private static final class FactWritingProbe implements CaptureEnvironmentProbe {

        private final int priority;
        private final Fact fact;
        private final Capability value;

        FactWritingProbe(int priority, Fact fact, Capability value) {
            this.priority = priority;
            this.fact = fact;
            this.value = value;
        }

        @Override
        public int priority() {
            return priority;
        }

        @Override
        public boolean applies(CaptureProbeContext ctx) {
            return true;
        }

        @Override
        public void probe(CaptureProbeContext ctx, CaptureEnvironmentFacts out) {
            out.setCapability(fact, value);
        }
    }

    private static final class SkippedProbe implements CaptureEnvironmentProbe {

        @Override
        public int priority() {
            return 60;
        }

        @Override
        public boolean applies(CaptureProbeContext ctx) {
            return false;
        }

        @Override
        public void probe(CaptureProbeContext ctx, CaptureEnvironmentFacts out) {
            out.note("skipped");
        }
    }

    private static final class ThrowingProbe implements CaptureEnvironmentProbe {

        @Override
        public int priority() {
            return 200;
        }

        @Override
        public boolean applies(CaptureProbeContext ctx) {
            return true;
        }

        @Override
        public void probe(CaptureProbeContext ctx, CaptureEnvironmentFacts out) {
            throw new IllegalStateException("probe blew up on purpose");
        }
    }
}
