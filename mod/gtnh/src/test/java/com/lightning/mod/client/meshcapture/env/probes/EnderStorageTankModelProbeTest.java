package com.lightning.mod.client.meshcapture.env.probes;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import com.lightning.mod.client.meshcapture.env.CaptureEnvironmentFacts;
import com.lightning.mod.client.meshcapture.env.CaptureProbeContext;
import com.lightning.mod.client.meshcapture.env.ModelAccessPresence;

/**
 * {@link EnderStorageTankModelProbe}：注册契约、访问面核对的每一处缺口，以及"读不出来不等于不在场"。
 * <p>
 * 用例用自己的一组同名形状的夹具类代替真模组类，因此不依赖测试 classpath 上有没有那个模组；真实运行里的读数由
 * 实机验收的环境事实快照给出。
 */
public class EnderStorageTankModelProbeTest {

    private static final long TEST_SESSION = 1L;

    @Test
    public void priorityAndTargetsContract() {
        EnderStorageTankModelProbe probe = new EnderStorageTankModelProbe();
        assertEquals(700, probe.priority());
        assertFalse("空上下文不跑", probe.applies(null));
        assertTrue(probe.applies(CaptureProbeContext.forTesting(TEST_SESSION)));
        assertEquals(
            "codechicken.enderstorage.storage.liquid.EnderTankRenderer",
            EnderStorageTankModelProbe.RENDERER_CLASS);
        assertEquals("codechicken.lib.render.CCModel", EnderStorageTankModelProbe.MODEL_CLASS);
        assertEquals("codechicken.lib.render.Vertex5", EnderStorageTankModelProbe.VERTEX_CLASS);
        assertEquals(3, EnderStorageTankModelProbe.MODEL_FIELDS.length);
    }

    @Test
    public void presentWhenEveryAccessPointMatches() {
        CaptureEnvironmentFacts facts = new CaptureEnvironmentFacts();
        fixtureProbe(FixtureRenderer.class, FixtureModel.class, FixtureVertex.class)
            .probe(CaptureProbeContext.forTesting(TEST_SESSION), facts);
        assertEquals(ModelAccessPresence.PRESENT, facts.tankModelAccess());
    }

    @Test
    public void absentWhenTargetClassMissing() {
        CaptureEnvironmentFacts facts = new CaptureEnvironmentFacts();
        fixtureProbe("no.such.Renderer", FixtureModel.class, FixtureVertex.class)
            .probe(CaptureProbeContext.forTesting(TEST_SESSION), facts);
        assertEquals(ModelAccessPresence.ABSENT, facts.tankModelAccess());
        assertNoted(facts);
    }

    @Test
    public void absentWhenOneModelFieldIsMissing() {
        CaptureEnvironmentFacts facts = new CaptureEnvironmentFacts();
        fixtureProbe(FixtureRendererNoValve.class, FixtureModel.class, FixtureVertex.class)
            .probe(CaptureProbeContext.forTesting(TEST_SESSION), facts);
        assertEquals(ModelAccessPresence.ABSENT, facts.tankModelAccess());
        assertNoted(facts);
    }

    @Test
    public void absentWhenModelFieldIsNotStatic() {
        CaptureEnvironmentFacts facts = new CaptureEnvironmentFacts();
        fixtureProbe(FixtureRendererInstanceField.class, FixtureModel.class, FixtureVertex.class)
            .probe(CaptureProbeContext.forTesting(TEST_SESSION), facts);
        assertEquals(ModelAccessPresence.ABSENT, facts.tankModelAccess());
        assertNoted(facts);
    }

    @Test
    public void absentWhenVertsIsNotAnArrayOfTheVertexType() {
        CaptureEnvironmentFacts facts = new CaptureEnvironmentFacts();
        fixtureProbe(FixtureRendererBadVerts.class, FixtureModelBadVerts.class, FixtureVertex.class)
            .probe(CaptureProbeContext.forTesting(TEST_SESSION), facts);
        assertEquals(ModelAccessPresence.ABSENT, facts.tankModelAccess());
        assertNoted(facts);
    }

    @Test
    public void absentWhenVertexLacksTheUvComponents() {
        CaptureEnvironmentFacts facts = new CaptureEnvironmentFacts();
        fixtureProbe(FixtureRendererBadVertex.class, FixtureModelBadVertex.class, FixtureVertexBadUv.class)
            .probe(CaptureProbeContext.forTesting(TEST_SESSION), facts);
        assertEquals(ModelAccessPresence.ABSENT, facts.tankModelAccess());
        assertNoted(facts);
    }

    @Test
    public void unreadableClassLoadingYieldsUnknownNotNullPresent() {
        CaptureEnvironmentFacts facts = new CaptureEnvironmentFacts();
        ClassLoader broken = new ClassLoader(null) {

            @Override
            protected Class<?> loadClass(String name, boolean resolve) {
                throw new IllegalStateException("boom: " + name);
            }
        };
        new EnderStorageTankModelProbe(
            FixtureRenderer.class.getName(),
            FixtureModel.class.getName(),
            FixtureVertex.class.getName(),
            broken).probe(CaptureProbeContext.forTesting(TEST_SESSION), facts);
        assertEquals(ModelAccessPresence.UNKNOWN, facts.tankModelAccess());
        assertNoted(facts);
    }

    private static EnderStorageTankModelProbe fixtureProbe(Class<?> renderer, Class<?> model, Class<?> vertex) {
        return fixtureProbe(renderer.getName(), model, vertex);
    }

    private static EnderStorageTankModelProbe fixtureProbe(String rendererName, Class<?> model, Class<?> vertex) {
        return new EnderStorageTankModelProbe(
            rendererName,
            model.getName(),
            vertex.getName(),
            EnderStorageTankModelProbeTest.class.getClassLoader());
    }

    private static void assertNoted(CaptureEnvironmentFacts facts) {
        boolean noted = false;
        for (String note : facts.notes()) {
            if (note.startsWith("enderstorage_tank_model: ")) {
                noted = true;
            }
        }
        assertTrue("降级必须留下可解释的读数", noted);
    }

    /** 与真渲染器同形状：三份静态模型字段（按钮是数组）。 */
    public static final class FixtureRenderer {

        private static final FixtureModel tankModel = null;
        private static final FixtureModel valveModel = null;
        private static final FixtureModel[] buttons = null;
    }

    public static final class FixtureRendererNoValve {

        private static final FixtureModel tankModel = null;
        private static final FixtureModel[] buttons = null;
    }

    public static final class FixtureRendererInstanceField {

        private static final FixtureModel tankModel = null;
        private static final FixtureModel[] buttons = null;
        private final FixtureModel valveModel = null;
    }

    /** 与真模型同形状：顶点数组 + 顶点模式。 */
    public static final class FixtureModel {

        public final int vertexMode = 4;
        public FixtureVertex[] verts = new FixtureVertex[0];
    }

    public static final class FixtureModelBadVerts {

        public final int vertexMode = 4;
        public Object[] verts = new Object[0];
    }

    public static final class FixtureModelBadVertex {

        public final int vertexMode = 4;
        public FixtureVertexBadUv[] verts = new FixtureVertexBadUv[0];
    }

    /** 与真顶点同形状：坐标三元组 + UV 二元组（都是 public double）。 */
    public static final class FixtureVertex {

        public FixtureVec3 vec = new FixtureVec3();
        public FixtureUv uv = new FixtureUv();
    }

    public static final class FixtureVertexBadUv {

        public FixtureVec3 vec = new FixtureVec3();
        public Object uv = new Object();
    }

    public static final class FixtureVec3 {

        public double x;
        public double y;
        public double z;
    }

    public static final class FixtureUv {

        public double u;
        public double v;
    }

    public static final class FixtureRendererBadVerts {

        private static final FixtureModelBadVerts tankModel = null;
        private static final FixtureModelBadVerts valveModel = null;
        private static final FixtureModelBadVerts[] buttons = null;
    }

    public static final class FixtureRendererBadVertex {

        private static final FixtureModelBadVertex tankModel = null;
        private static final FixtureModelBadVertex valveModel = null;
        private static final FixtureModelBadVertex[] buttons = null;
    }
}
