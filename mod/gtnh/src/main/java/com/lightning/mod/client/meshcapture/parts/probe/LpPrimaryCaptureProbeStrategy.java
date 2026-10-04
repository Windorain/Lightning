package com.lightning.mod.client.meshcapture.parts.probe;

import net.minecraft.block.Block;
import net.minecraft.client.renderer.RenderBlocks;
import net.minecraft.tileentity.TileEntity;

import com.google.gson.JsonObject;
import com.lightning.mod.client.meshcapture.TessellatorCaptureState;
import com.lightning.mod.client.meshcapture.primary.BlockPrimaryCaptureContext;
import com.lightning.mod.client.meshcapture.primary.BlockPrimaryCaptureRegistry;
import com.lightning.mod.client.meshcapture.primary.BlockPrimaryCaptureStrategy;

import cpw.mods.fml.relauncher.Side;
import cpw.mods.fml.relauncher.SideOnly;

/**
 * Gitea issue #12 验证回路的<strong>诊断</strong>策略（只读观测 + 原样委派，不改变捕获行为）。
 *
 * <p>
 * 注册在 {@link BlockPrimaryCaptureRegistry} 的优先级最前（{@code priority}=1，默认兜底是 10000），
 * 因此它会在系统的默认主路径之前被调用；它记录「进入主批次时/委派默认路径后」的已录四边形数，
 * 再原样调用默认兜底 {@code renderBlockByRenderType}，从而<strong>不改变任何渲染语义</strong>。
 *
 * <p>
 * 用途：定位 LP 管道几何在导出产物里为空（issue #12 探针断言 3 红）的成因 ——
 * 是主批次渲染没产出顶点，还是方块根本没有可用的 ISBRH（{@code getRenderType()} 的 id 未注册）。
 */
@SideOnly(Side.CLIENT)
public final class LpPrimaryCaptureProbeStrategy implements BlockPrimaryCaptureStrategy {

    private LpPrimaryCaptureProbeStrategy() {}

    private static LpPrimaryCaptureProbeStrategy instance;
    private static boolean registered;

    private boolean recording;
    private JsonObject current;

    /** 对 {@code blockClass} 的方块开启逐格记录（同轮只记录目标方块，避免噪声）。 */
    public static void begin(String targetBlockClass) {
        ensureRegistered();
        if (instance == null) {
            return;
        }
        instance.recording = true;
        instance.targetBlockClass = targetBlockClass;
        instance.records = new com.google.gson.JsonArray();
    }

    /** 结束记录并返回逐格记录数组。 */
    public static com.google.gson.JsonArray end() {
        if (instance == null) {
            return new com.google.gson.JsonArray();
        }
        instance.recording = false;
        instance.targetBlockClass = null;
        return instance.records == null ? new com.google.gson.JsonArray() : instance.records;
    }

    private static void ensureRegistered() {
        if (registered) {
            return;
        }
        instance = new LpPrimaryCaptureProbeStrategy();
        BlockPrimaryCaptureRegistry.register(instance);
        registered = true;
    }

    private String targetBlockClass;
    private com.google.gson.JsonArray records;

    @Override
    public int priority() {
        return 1;
    }

    @Override
    public boolean applies(BlockPrimaryCaptureContext ctx) {
        return recording && ctx != null
            && ctx.getBlock() != null
            && ctx.getBlock()
                .getClass()
                .getName()
                .equals(targetBlockClass);
    }

    @Override
    public void renderPrimary(BlockPrimaryCaptureContext ctx) {
        JsonObject o = new JsonObject();
        Block b = ctx.getBlock();
        o.addProperty(
            "blockClass",
            b.getClass()
                .getName());
        o.addProperty("registryId", String.valueOf(Block.blockRegistry.getNameForObject(b)));
        int renderType = -999;
        try {
            renderType = b.getRenderType();
        } catch (Throwable t) {
            o.addProperty("renderTypeError", String.valueOf(t));
        }
        o.addProperty("renderType", Integer.valueOf(renderType));
        TileEntity te = ctx.getWorld()
            .getTileEntity(ctx.getWx(), ctx.getWy(), ctx.getWz());
        o.addProperty(
            "worldTileEntityClass",
            te == null ? "<null>"
                : te.getClass()
                    .getName());
        o.addProperty("w", ctx.getWx());
        o.addProperty("h", ctx.getWy());
        o.addProperty("d", ctx.getWz());
        o.addProperty("quadsAtEntry", Integer.valueOf(TessellatorCaptureState.currentBlockRecordedQuadCount()));

        // 与自带默认路径完全相同的调用（本策略只观测，不替代）
        RenderBlocks rb = ctx.getRenderBlocks();
        try {
            rb.renderBlockByRenderType(b, ctx.getWx(), ctx.getWy(), ctx.getWz());
            o.addProperty("delegated", "renderBlockByRenderType");
        } catch (Throwable t) {
            o.addProperty("delegateError", PartsProbeReflect.describe(t));
        }
        o.addProperty("quadsAfterPrimary", Integer.valueOf(TessellatorCaptureState.currentBlockRecordedQuadCount()));
        // 只在默认路径**没有**产出顶点时才补一次 FML 自己的 ISBRH 分派（纯诊断；否则会重复渲染）
        if (TessellatorCaptureState.currentBlockRecordedQuadCount() == 0) {
            try {
                Object isbrh = findIsbrh(renderType);
                o.addProperty(
                    "isbrhClass",
                    isbrh == null ? "<none-for-renderType>"
                        : isbrh.getClass()
                            .getName());
                int before = TessellatorCaptureState.currentBlockRecordedQuadCount();
                boolean handled = invokeRenderWorldBlock(
                    null,
                    rb,
                    ctx.getWorld(),
                    ctx.getWx(),
                    ctx.getWy(),
                    ctx.getWz(),
                    b,
                    renderType);
                o.addProperty("fmlRenderWorldBlockHandled", Boolean.valueOf(handled));
                o.addProperty(
                    "quadsIsbrhDelta",
                    Integer.valueOf(TessellatorCaptureState.currentBlockRecordedQuadCount() - before));
            } catch (Throwable t) {
                o.addProperty("isbrhProbeError", PartsProbeReflect.describe(t));
            }
        } else {
            o.addProperty("isbrhClass", "<skipped-primary-produced-quads>");
        }
        if (records != null) {
            records.add(o);
        }
    }

    /** 通过 {@code RenderBlocks.renderBlockByRenderType} 的注册表拿 ISBRH（反射，避免编译期耦合）。 */
    private static Object findIsbrh(int renderType) {
        try {
            Class<?> handlerClass = Class.forName(
                "cpw.mods.fml.client.registry.RenderingRegistry",
                false,
                LpPrimaryCaptureProbeStrategy.class.getClassLoader());
            java.lang.reflect.Field f = handlerClass.getDeclaredField("blockRenderers");
            f.setAccessible(true);
            Object map = f.get(null);
            if (map instanceof java.util.Map) {
                return ((java.util.Map<?, ?>) map).get(Integer.valueOf(renderType));
            }
        } catch (Throwable ignored) {
            // 名称/可见性不同则放弃这条对照
        }
        return null;
    }

    /**
     * 直接用 <strong>FML 自己的 ISBRH 分派入口</strong>再渲染一次（纯诊断对照）：
     * {@code RenderingRegistry.instance().renderWorldBlock(rb, world, x, y, z, block, renderType)}
     * —— 与 {@code RenderBlocks.renderBlockByRenderType} 内部走的同一条注册表分派。
     */
    private static boolean invokeRenderWorldBlock(Object ignoredIsbrh, RenderBlocks rb,
        net.minecraft.world.IBlockAccess world, int x, int y, int z, Block b, int renderType) throws Exception {
        Class<?> reg = Class.forName(
            "cpw.mods.fml.client.registry.RenderingRegistry",
            false,
            LpPrimaryCaptureProbeStrategy.class.getClassLoader());
        Object inst = reg.getMethod("instance")
            .invoke(null);
        java.lang.reflect.Method m = reg.getMethod(
            "renderWorldBlock",
            RenderBlocks.class,
            net.minecraft.world.IBlockAccess.class,
            int.class,
            int.class,
            int.class,
            Block.class,
            int.class);
        return Boolean.TRUE.equals(
            m.invoke(
                inst,
                rb,
                world,
                Integer.valueOf(x),
                Integer.valueOf(y),
                Integer.valueOf(z),
                b,
                Integer.valueOf(renderType)));
    }
}
