package com.lightning.mod.client.meshcapture.postrender;

import java.nio.FloatBuffer;
import java.util.Collections;
import java.util.LinkedHashSet;
import java.util.Locale;
import java.util.Set;

import net.minecraft.client.renderer.tileentity.TileEntityRendererDispatcher;
import net.minecraft.tileentity.TileEntity;
import net.minecraft.tileentity.TileEntityMobSpawner;
import net.minecraft.tileentity.TileEntitySign;
import net.minecraft.tileentity.TileEntitySkull;
import net.minecraft.world.World;

import org.lwjgl.BufferUtils;
import org.lwjgl.opengl.GL11;
import org.lwjgl.util.vector.Matrix4f;

import com.lightning.mod.client.meshcapture.TessellatorCaptureState;
import com.lightning.mod.client.meshcapture.vanilla.VanillaTileEntityRenderEnvironment;

import cpw.mods.fml.common.registry.GameRegistry;
import cpw.mods.fml.relauncher.Side;
import cpw.mods.fml.relauncher.SideOnly;

/**
 * 补捕获原版/模组 {@link net.minecraft.client.renderer.tileentity.TileEntitySpecialRenderer}：在静态
 * {@link net.minecraft.client.renderer.RenderBlocks} 批次已 {@code draw} 之后执行，顶点仍由
 * {@link TessellatorCaptureState} 录制。
 * <p>
 * JVM：{@code -Dsde.tesrCapture=off}关闭；{@code all}（默认）对凡有 TESR 的 TE 尝试渲染，但排除
 * {@linkplain #isDeniedTileEntityClass(Class) 拒绝列表}；{@code allowlist} 仅当方块注册名在
 * {@code -Dsde.tesrCapture.allowlist=modid:name,...} 中时为真。
 */
@SideOnly(Side.CLIENT)
public final class TileEntitySpecialRendererPostRenderStrategy implements MeshCaptureBlockPostRenderStrategy {

    public static final int DEFAULT_PRIORITY = 2000;

    private static final String MODE = System.getProperty("sde.tesrCapture", "all")
        .trim()
        .toLowerCase(Locale.ROOT);
    private static final Set<String> ALLOWLIST = parseCsvAllowlist(System.getProperty("sde.tesrCapture.allowlist", ""));

    @Override
    public int priority() {
        return DEFAULT_PRIORITY;
    }

    @Override
    public boolean applies(MeshCaptureBlockPostRenderContext ctx) {
        if ("off".equals(MODE)) {
            return false;
        }
        TileEntity te = ctx.getTileEntity();
        if (te == null) {
            return false;
        }
        /* 与 {@link ForgeMultipartDynamicPostRenderStrategy} 链式并存：multipart 由 FMP 策略独占 */
        if ("codechicken.multipart.TileMultipart".equals(
            te.getClass()
                .getName())) {
            return false;
        }
        if (isDeniedTileEntityClass(te.getClass())) {
            return false;
        }
        if (!TileEntityRendererDispatcher.instance.hasSpecialRenderer(te)) {
            return false;
        }
        if ("allowlist".equals(MODE)) {
            return allowlistContainsBlock(ctx);
        }
        if ("all".equals(MODE) || MODE.isEmpty()) {
            return true;
        }
        /* 未知模式：保守关闭 */
        return false;
    }

    @Override
    public void renderPostMainBlock(MeshCaptureBlockPostRenderContext ctx) {
        TileEntity te = ctx.getTileEntity();
        if (te == null) {
            return;
        }
        World world = ctx.getWorld();
        int wx = ctx.getWx();
        int wy = ctx.getWy();
        int wz = ctx.getWz();
        float pt = ctx.getPartialTicks();

        double spx = TileEntityRendererDispatcher.staticPlayerX;
        double spy = TileEntityRendererDispatcher.staticPlayerY;
        double spz = TileEntityRendererDispatcher.staticPlayerZ;
        try {
            TileEntityRendererDispatcher.staticPlayerX = wx;
            TileEntityRendererDispatcher.staticPlayerY = wy;
            TileEntityRendererDispatcher.staticPlayerZ = wz;

            VanillaTileEntityRenderEnvironment.bindDispatcherWorld(world);
            VanillaTileEntityRenderEnvironment.cacheActiveRenderInfo(pt);
            VanillaTileEntityRenderEnvironment.applyBlockLightmap(world, te);

            FloatBuffer mv0 = BufferUtils.createFloatBuffer(16);
            GL11.glGetFloat(GL11.GL_MODELVIEW_MATRIX, mv0);
            mv0.rewind();
            Matrix4f mAtEntry = new Matrix4f();
            mAtEntry.load(mv0);
            Matrix4f invEntry = new Matrix4f();
            if (Matrix4f.invert(mAtEntry, invEntry) != null) {
                FloatBuffer invBuf = BufferUtils.createFloatBuffer(16);
                invEntry.store(invBuf);
                invBuf.rewind();
                float[] snapInv = new float[16];
                invBuf.get(snapInv);
                TessellatorCaptureState.armDynamicPassModelViewBaselineInverse(snapInv);
            }
            TessellatorCaptureState.beginDynamicExtensionVertexPhase();
            try {
                TileEntityRendererDispatcher.instance.renderTileEntityAt(
                    te,
                    (double) te.xCoord - TileEntityRendererDispatcher.staticPlayerX,
                    (double) te.yCoord - TileEntityRendererDispatcher.staticPlayerY,
                    (double) te.zCoord - TileEntityRendererDispatcher.staticPlayerZ,
                    pt);
            } finally {
                TessellatorCaptureState.endDynamicExtensionVertexPhase();
            }
        } finally {
            TileEntityRendererDispatcher.staticPlayerX = spx;
            TileEntityRendererDispatcher.staticPlayerY = spy;
            TileEntityRendererDispatcher.staticPlayerZ = spz;
        }
    }

    private static boolean allowlistContainsBlock(MeshCaptureBlockPostRenderContext ctx) {
        if (ALLOWLIST.isEmpty()) {
            return false;
        }
        GameRegistry.UniqueIdentifier uid = GameRegistry.findUniqueIdentifierFor(ctx.getBlock());
        String key = uid == null ? ""
            : uid.toString()
                .toLowerCase(Locale.ROOT);
        return key.length() > 0 && ALLOWLIST.contains(key);
    }

    private static Set<String> parseCsvAllowlist(String raw) {
        if (raw == null || raw.isEmpty()) {
            return Collections.emptySet();
        }
        Set<String> out = new LinkedHashSet<>();
        for (String part : raw.split(",")) {
            String t = part.trim()
                .toLowerCase(Locale.ROOT);
            if (!t.isEmpty()) {
                out.add(t);
            }
        }
        return out.isEmpty() ? Collections.emptySet() : Collections.unmodifiableSet(out);
    }

    private static boolean isDeniedTileEntityClass(Class<? extends TileEntity> c) {
        return TileEntitySign.class.isAssignableFrom(c) || TileEntityMobSpawner.class.isAssignableFrom(c)
            || TileEntitySkull.class.isAssignableFrom(c);
    }
}
