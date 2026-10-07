package com.lightning.mod.client.controlplane.mc.export;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import com.lightning.mod.client.controlplane.core.ActionDescriptor;
import com.lightning.mod.client.controlplane.core.ActionRegistry;
import com.lightning.mod.client.controlplane.core.Contract;
import com.lightning.mod.client.controlplane.mc.ActionRegistrar;
import com.lightning.mod.core.session.ExportSceneWriter;

/**
 * 导出族三动作的自述与版本（Gitea #102 收口T5；D1/D3 自检的机械面）。
 *
 * <p>
 * 本测试把「自述必须与行为一致」里<b>可静态判定</b>的部分钉死：
 *
 * <ol>
 * <li><b>契约版本 1.7</b>（收口批次裁决：#100=1.4、#101=1.5、#103=1.6，本单与 #114/#122/#123 同批取 1.7）：
 * {@code Contract.VERSION} 与三个动作的 {@code since} 都必须是 1.7；</li>
 * <li><b>D3 默认值可见</b>：预算与形态参数必须带字面默认值（缺 default 的 optional 参数
 * 会让调用方只能靠试错）；</li>
 * <li><b>D1 自述完备</b>：名称/权限级/说明/返回结构/示例/since 齐备，
 * 且示例里含 {@code confirm:true}（scene 级动作的调用体必须带它）；</li>
 * <li><b>D2 适用范围（裁决 X-11）</b>：只有这三条有命令孪生，自述必须点名孪生命令——
 * 这条是「D2 只适用 /sde 承重族」的可审面。</li>
 * </ol>
 */
public class ExportActionsDescriptorTest {

    /** 三个导出动作（Gitea #102）。 */
    public static final String[] EXPORT_ACTIONS = { ExportSceneAction.NAME, ExportRegistryAction.NAME,
        ExportMultiblockAction.NAME };

    private static ActionRegistry registry() {
        ActionRegistry r = new ActionRegistry();
        ActionRegistrar.registerAll(null, r);
        return r;
    }

    /** 契约版本 1.7，且三个动作的 since 都是 1.7。 */
    @Test
    public void exportActionsAreSince17() {
        assertEquals("收口批次裁决：#102 取 1.7（#100=1.4、#101=1.5、#103=1.6 已占）", "1.7", Contract.VERSION);
        ActionRegistry r = registry();
        for (String name : EXPORT_ACTIONS) {
            ActionDescriptor d = r.descriptor(name);
            assertNotNull("动作必须已注册: " + name, d);
            assertEquals(name + " since 应为 1.7（#102 引入）", "1.7", d.since());
        }
    }

    /** 契约版本不变式：VERSION ≥ 每个动作的 since（含本次新增的三个）。 */
    @Test
    public void contractVersionCoversEveryActionSince() {
        ActionRegistry r = registry();
        double contract = Double.parseDouble(Contract.VERSION);
        for (String name : r.names()) {
            ActionDescriptor d = r.descriptor(name);
            double since = Double.parseDouble(d.since());
            assertTrue("动作 " + name + " 的 since=" + d.since() + " 高于契约版本 " + Contract.VERSION, since <= contract);
        }
    }

    /** 三个动作都是 scene 级（可写 ⇒ 必须 confirm）。 */
    @Test
    public void exportActionsAreSceneTierAndWritable() {
        ActionRegistry r = registry();
        for (String name : EXPORT_ACTIONS) {
            ActionDescriptor d = r.descriptor(name);
            assertTrue(name + " 必须是可写动作", d.writable());
            assertEquals(
                name + " 是 scene 级（导出件是场景数据，不是取证材料）",
                "scene",
                d.tier()
                    .id());
            assertTrue(
                name + " 必须是步进动作（跨 tick 且要 run 目录）",
                r.lookup(name)
                    .isStepping());
        }
    }

    /**
     * D3：预算与形态参数的默认值必须可见（字面出现在自述里）。
     *
     * <p>
     * 「默认值可见」的反面不是「没写默认值」，而是「默认值写在代码里、自述里只写了个类型」
     * ——调用方于是只能靠试错推断帧预算上限。
     */
    @Test
    public void budgetAndShapeDefaultsAreVisible() {
        ActionDescriptor scene = registry().descriptor(ExportSceneAction.NAME);
        assertParamDefault(scene, "shape", ExportSceneWriterShapeWorld());
        assertParamDefault(scene, "maxFrames", Integer.valueOf(ExportSceneAction.DEFAULT_MAX_FRAMES));
        assertParamDefault(scene, "maxCells", Long.valueOf(ExportSceneAction.DEFAULT_MAX_CELLS));
        assertParamDefault(scene, "includeFrames", Boolean.TRUE);
        assertParamDefault(scene, "raw", Boolean.FALSE);

        ActionDescriptor multi = registry().descriptor(ExportMultiblockAction.NAME);
        assertParamDefault(multi, "limit", Integer.valueOf(0));
        assertParamDefault(multi, "structuralOnly", Boolean.FALSE);
        assertParamDefault(multi, "keepDataset", Boolean.TRUE);
        assertParamDefault(multi, "dryRun", Boolean.FALSE);
        assertParamDefault(multi, "dataset", ExportMultiblockAction.DatasetMode.MANIFEST_ONLY.id());

        ActionDescriptor reg = registry().descriptor(ExportRegistryAction.NAME);
        assertParamDefault(reg, "waitTicks", Integer.valueOf(ExportRegistryAction.DEFAULT_WAIT_TICKS));
    }

    private static String ExportSceneWriterShapeWorld() {
        return ExportSceneWriter.Shape.WORLD.id();
    }

    private static void assertParamDefault(ActionDescriptor d, String param, Object expected) {
        ActionDescriptor.Param found = null;
        for (ActionDescriptor.Param p : d.params()) {
            if (param.equals(p.name())) {
                found = p;
                break;
            }
        }
        assertNotNull(d.name() + " 缺少参数 " + param, found);
        assertFalse(d.name() + "." + param + " 必须带字面默认值（D3 默认值可见）", found.required());
        assertNotNull(d.name() + "." + param + " 默认值为 null（等于没写默认值）", found.defaultValue());
        assertEquals(
            d.name() + "." + param + " 默认值必须是 " + expected,
            String.valueOf(expected),
            found.defaultValue()
                .getAsString());
    }

    /** D1：六要素齐备 + 示例含 confirm（scene 级调用体的硬要求）。 */
    @Test
    public void descriptorsAreComplete() {
        ActionRegistry r = registry();
        for (String name : EXPORT_ACTIONS) {
            ActionDescriptor d = r.descriptor(name);
            assertNotNull(name + " name", d.name());
            assertNotNull(name + " tier", d.tier());
            assertNotNull(name + " description", d.description());
            assertTrue(
                name + " 说明过短（自述要能独立支撑一次调用）",
                d.description()
                    .length() > 80);
            assertNotNull(name + " returns", d.returns());
            assertTrue(
                name + " returns 必须写明结构",
                d.returns()
                    .length() > 40);
            assertTrue(
                name + " 必须有示例",
                d.examples()
                    .size() > 0);
            boolean anyConfirm = false;
            for (int i = 0; i < d.examples()
                .size(); i++) {
                String ex = d.examples()
                    .get(i)
                    .toString();
                if (ex.contains("\"confirm\":true")) {
                    anyConfirm = true;
                }
            }
            assertTrue(name + " 至少一个示例必须含 \"confirm\":true（scene 级必填）", anyConfirm);
        }
    }

    /**
     * D2 适用范围（补充裁决 X-11）：只有这三条有命令孪生，自述必须点名——这是可审面。
     *
     * <p>
     * 「D2 只适用于有命令孪生的 /sde 承重族动作」若只在评论里说，复核者无法从产物侧核对；
     * 写进自述后，{@code GET /cp/v1/actions} 一步可查。
     */
    @Test
    public void descriptorsNameTheirCommandTwin() {
        assertTrue(
            "export.scene 必须点名与 /sde export 共用写入器",
            registry().descriptor(ExportSceneAction.NAME)
                .description()
                .contains("/sde export"));
        assertTrue(
            "export.registry 必须点名与 /sde dump 共用写出体",
            registry().descriptor(ExportRegistryAction.NAME)
                .description()
                .contains("/sde dump"));
        assertTrue(
            "export.multiblock 必须点名与 /sde multiblock 共用执行体",
            registry().descriptor(ExportMultiblockAction.NAME)
                .description()
                .contains("/sde multiblock"));
    }

    /** C6：帧预算的绝对上限也必须在自述里可见（否则调用方不知道「能不能调高」）。 */
    @Test
    public void budgetHardLimitsAreVisible() {
        ActionDescriptor scene = registry().descriptor(ExportSceneAction.NAME);
        String maxFramesDoc = paramDoc(scene, "maxFrames");
        assertTrue(
            "maxFrames 自述必须写出绝对上限 " + ExportSceneAction.HARD_MAX_FRAMES + ": " + maxFramesDoc,
            maxFramesDoc.contains(String.valueOf(ExportSceneAction.HARD_MAX_FRAMES)));
        assertTrue("maxFrames 自述必须写明「不静默截断」", maxFramesDoc.contains("不静默截断"));
    }

    /** C3：expectFrames 必须出现在自述里并说明它是 C3 判据。 */
    @Test
    public void expectFramesIsSelfDescribedAsC3Criterion() {
        String doc = paramDoc(registry().descriptor(ExportSceneAction.NAME), "expectFrames");
        assertTrue("expectFrames 自述必须点名 C3", doc.contains("C3"));
        assertTrue("expectFrames 不符的错误码必须在自述里", doc.contains("CP-STATE-001"));
        assertTrue("必须写明它拦的是跨会话拼接", doc.contains("拼接"));
    }

    /** 导出动作总数：新增三个后 registry 必须含它们（防注册遗漏）。 */
    @Test
    public void allThreeExportActionsAreRegistered() {
        ActionRegistry r = registry();
        for (String name : EXPORT_ACTIONS) {
            assertTrue("未注册: " + name, r.contains(name));
        }
        assertTrue("动作总数应 ≥ 40（#102 合流后）", r.size() >= 40);
    }

    private static String paramDoc(ActionDescriptor d, String param) {
        for (ActionDescriptor.Param p : d.params()) {
            if (param.equals(p.name())) {
                return p.description() == null ? "" : p.description();
            }
        }
        org.junit.Assert.fail(d.name() + " 缺少参数 " + param);
        return "";
    }
}
