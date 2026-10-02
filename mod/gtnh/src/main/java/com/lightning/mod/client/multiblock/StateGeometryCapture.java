package com.lightning.mod.client.multiblock;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Base64;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.TreeMap;
import java.util.TreeSet;

import net.minecraft.block.Block;
import net.minecraft.client.Minecraft;
import net.minecraft.client.renderer.RenderBlocks;
import net.minecraft.client.renderer.Tessellator;
import net.minecraft.client.renderer.texture.TextureMap;
import net.minecraft.init.Blocks;

import org.lwjgl.opengl.GL11;

import com.lightning.mod.client.meshcapture.MaterialKeyResolver;
import com.lightning.mod.client.meshcapture.TessellatorCaptureState;
import com.lightning.mod.client.meshcapture.TessellatorCaptureState.CapturedBlockInstance;
import com.lightning.mod.client.meshcapture.TessellatorCaptureState.CapturedQuad;
import com.lightning.mod.client.meshcapture.TessellatorCaptureState.CapturedVertex;
import com.lightning.mod.client.meshcapture.postrender.MeshCaptureBlockPostRenderContext;
import com.lightning.mod.client.meshcapture.postrender.MeshCaptureBlockPostRenderRegistry;
import com.lightning.mod.client.meshcapture.primary.BlockPrimaryCaptureContext;
import com.lightning.mod.client.meshcapture.primary.BlockPrimaryCaptureRegistry;

import cpw.mods.fml.common.registry.GameRegistry;
import cpw.mods.fml.relauncher.Side;
import cpw.mods.fml.relauncher.SideOnly;

/**
 * 一个「运行态」的烘焙几何快照，以及两态之间的内容签名比对。
 * <p>
 * 复用 {@code MeshCaptureService} 的捕获原语（{@link TessellatorCaptureState} + 主批次/后渲染注册表 +
 * {@link MaterialKeyResolver#applySpriteLocalToQuad}）与同一套量化口径（坐标/UV 保留 4 位小数、四边形内顶点排序、
 * 四边形之间排序、SHA-256），但**不依赖它的文件级流程**：{@code MeshCaptureService} 的
 * {@code finalizeSingleStructure} 硬编码 {@code Minecraft.theWorld}，而探针要求的世界是
 * {@link ProbeDummyWorld}；其签名方法为 private，故此处按同一算法重写并在报告中标注（移交 T1.3 时建议把签名机制提升为 public 工具）。
 * <p>
 * 与 {@code MeshCaptureService} 的唯一实质差异：签名里用「材质定位串({@code materialKey}) + 顶点当时 bind 的贴图
 * ({@code bindTextureHint})」代替它的「{@code materialIndex}」——探针还没有 materialPalette，用定位串更直接可比。
 */
@SideOnly(Side.CLIENT)
public final class StateGeometryCapture {

    private static final int SAMPLE_LIMIT = 12;

    public static final class StateCapture {

        public String name;
        public boolean activeRequested;
        public boolean activeObserved;
        public int blockCount;
        public int quadCount;
        public int dynamicExtensionQuads;
        public String signature;
        /** 位置 → (四边形内容键 → 数量)，用于两态逐格比对。 */
        public final Map<String, Map<String, Integer>> positionQuadCounts = new TreeMap<String, Map<String, Integer>>();
        /** 材质定位串 → 四边形数。 */
        public final Map<String, Integer> materialQuadCounts = new TreeMap<String, Integer>();
        /** 顶点 bind 的贴图（domain:path）→ 四边形数。 */
        public final Map<String, Integer> bindHintQuadCounts = new TreeMap<String, Integer>();
        /** 控制器所在格的四边形内容键样本。 */
        public final List<String> controllerSamples = new ArrayList<String>();
        public final List<String> errors = new ArrayList<String>();
    }

    public static final class Diff {

        public int quadCountIdle;
        public int quadCountActive;
        public int addedQuads;
        public int removedQuads;
        public int differingQuads;
        public int changedPositions;
        public boolean signaturesIdentical;
        public final List<String> onlyIdleMaterials = new ArrayList<String>();
        public final List<String> onlyActiveMaterials = new ArrayList<String>();
        public final List<String> changedPositionDetails = new ArrayList<String>();
    }

    private StateGeometryCapture() {}

    // ------------------------------------------------------------------ capture

    public static StateCapture capture(ProbeDummyWorld world, String name, boolean activeObserved, int controllerX,
        int controllerY, int controllerZ, net.minecraft.entity.EntityLivingBase renderInfoFallback) {
        StateCapture out = new StateCapture();
        out.name = name;
        out.activeObserved = activeObserved;

        // TESR 补画路径（TileEntitySpecialRendererPostRenderStrategy）会调
        // TileEntityRendererDispatcher#cacheActiveRenderInfo(..., renderViewEntity, ...)，而 1.7.10 的实现会
        // 解引用该实体（prevRotationYaw/rotationYaw/...）。主菜单态 mc.renderViewEntity 为 null → NPE → 整条 TESR
        // 补画被吞掉。因此捕获期间临时挂上假玩家，结束后立刻还原（这是「让既有捕获管线在主菜单态也能跑 TESR」的唯一改动）。
        Minecraft mc = Minecraft.getMinecraft();
        net.minecraft.entity.EntityLivingBase previousViewEntity = mc.renderViewEntity;
        if (previousViewEntity == null && renderInfoFallback != null) {
            mc.renderViewEntity = renderInfoFallback;
        }
        try {
            return captureInternal(out, world, controllerX, controllerY, controllerZ);
        } finally {
            mc.renderViewEntity = previousViewEntity;
        }
    }

    private static StateCapture captureInternal(StateCapture out, ProbeDummyWorld world, int controllerX,
        int controllerY, int controllerZ) {
        TextureMap textureMap = Minecraft.getMinecraft()
            .getTextureMapBlocks();
        RenderBlocks rb = new RenderBlocks(world);
        rb.renderAllFaces = true;

        List<int[]> positions = world.placedPositions();
        List<String> allQuadKeys = new ArrayList<String>();
        String controllerKey = controllerX + "," + controllerY + "," + controllerZ;

        for (int[] p : positions) {
            int wx = p[0];
            int wy = p[1];
            int wz = p[2];
            Block block = world.getBlock(wx, wy, wz);
            if (block == null || block == Blocks.air) {
                continue;
            }
            out.blockCount++;
            int meta = world.getBlockMetadata(wx, wy, wz);
            String registryId = registryIdOf(block);
            CapturedBlockInstance inst = new CapturedBlockInstance();
            boolean started = false;
            try {
                TessellatorCaptureState
                    .beginBlock(wx, wy, wz, registryId, wx, wy, wz, block, meta, block.getRenderType(), registryId);
                Tessellator tess = Tessellator.instance;
                tess.startDrawingQuads();
                started = true;
                BlockPrimaryCaptureRegistry
                    .dispatch(new BlockPrimaryCaptureContext(world, wx, wy, wz, block, meta, rb, 0.0F));
                tess.draw();
                started = false;
                MeshCaptureBlockPostRenderRegistry
                    .dispatch(new MeshCaptureBlockPostRenderContext(world, wx, wy, wz, block, meta, rb, 0.0F));
                int quadsBefore = TessellatorCaptureState.currentBlockRecordedQuadCount();
                try {
                    tess.draw();
                    started = false;
                } catch (Throwable ignored) {
                    started = false;
                }
                if (quadsBefore == 0) {
                    GL11.glPushMatrix();
                    try {
                        rb.renderBlockAsItem(block, meta, 1.0F);
                    } catch (Throwable ignored) {
                        // 少数方块在库存路径下可能抛错
                    } finally {
                        GL11.glPopMatrix();
                    }
                }
            } catch (Throwable t) {
                out.errors.add("(" + wx + "," + wy + "," + wz + ") " + registryId + " -> " + describe(t));
            } finally {
                if (started) {
                    try {
                        Tessellator.instance.draw();
                    } catch (Throwable ignored) {
                        // 半开批次丢弃
                    }
                }
                TessellatorCaptureState.endBlock(inst);
            }

            String posKey = wx + "," + wy + "," + wz;
            Map<String, Integer> perPos = new TreeMap<String, Integer>();
            for (CapturedQuad q : inst.quads) {
                String materialKey = MaterialKeyResolver.applySpriteLocalToQuad(q, textureMap);
                String bind = q.bindTextureHint == null ? "" : q.bindTextureHint;
                String key = quadKey(q, materialKey, bind);
                allQuadKeys.add(key);
                Integer c = perPos.get(key);
                perPos.put(key, Integer.valueOf(c == null ? 1 : c.intValue() + 1));
                bump(out.materialQuadCounts, materialKey);
                bump(out.bindHintQuadCounts, bind);
                if (q.fromDynamicExtensionPass) {
                    out.dynamicExtensionQuads++;
                }
            }
            out.quadCount += inst.quads.size();
            out.positionQuadCounts.put(posKey, perPos);
            if (controllerKey.equals(posKey)) {
                for (String k : perPos.keySet()) {
                    if (out.controllerSamples.size() >= SAMPLE_LIMIT) {
                        break;
                    }
                    out.controllerSamples.add(k);
                }
            }
        }

        Collections.sort(allQuadKeys);
        out.signature = sha256Base64(join(allQuadKeys, "\n"));
        return out;
    }

    // ------------------------------------------------------------------ signature / diff

    public static Diff diff(StateCapture idle, StateCapture active) {
        Diff d = new Diff();
        d.quadCountIdle = idle.quadCount;
        d.quadCountActive = active.quadCount;
        d.signaturesIdentical = idle.signature != null && idle.signature.equals(active.signature);

        TreeSet<String> positions = new TreeSet<String>();
        positions.addAll(idle.positionQuadCounts.keySet());
        positions.addAll(active.positionQuadCounts.keySet());
        for (String pos : positions) {
            Map<String, Integer> a = idle.positionQuadCounts.get(pos);
            Map<String, Integer> b = active.positionQuadCounts.get(pos);
            if (a == null) a = Collections.emptyMap();
            if (b == null) b = Collections.emptyMap();
            TreeSet<String> keys = new TreeSet<String>();
            keys.addAll(a.keySet());
            keys.addAll(b.keySet());
            int added = 0;
            int removed = 0;
            for (String k : keys) {
                int ca = a.containsKey(k) ? a.get(k)
                    .intValue() : 0;
                int cb = b.containsKey(k) ? b.get(k)
                    .intValue() : 0;
                if (cb > ca) added += cb - ca;
                if (ca > cb) removed += ca - cb;
            }
            if (added + removed > 0) {
                d.changedPositions++;
                d.addedQuads += added;
                d.removedQuads += removed;
                if (d.changedPositionDetails.size() < 16) {
                    d.changedPositionDetails.add(pos + " (+" + added + "/-" + removed + ")");
                }
            }
        }
        d.differingQuads = d.addedQuads + d.removedQuads;

        for (Map.Entry<String, Integer> e : idle.materialQuadCounts.entrySet()) {
            if (!active.materialQuadCounts.containsKey(e.getKey())) {
                d.onlyIdleMaterials.add(e.getKey() + " x" + e.getValue());
            }
        }
        for (Map.Entry<String, Integer> e : active.materialQuadCounts.entrySet()) {
            if (!idle.materialQuadCounts.containsKey(e.getKey())) {
                d.onlyActiveMaterials.add(e.getKey() + " x" + e.getValue());
            }
        }
        return d;
    }

    // ------------------------------------------------------------------ helpers

    /**
     * 单四边形内容键：材质定位串 + 顶点录制时的 bind + 动态扩展标记 + 排序后的顶点串。
     * 顶点分量与 {@code MeshCaptureService#geometrySignature} 同口径（4 位小数、亮度、颜色）。
     */
    static String quadKey(CapturedQuad q, String materialKey, String bindHint) {
        List<String> verts = new ArrayList<String>(q.vertices.size());
        for (CapturedVertex v : q.vertices) {
            verts.add(
                String.format(
                    Locale.ROOT,
                    "%.4f,%.4f,%.4f,%.4f,%.4f,%d,%d",
                    Double.valueOf(v.x),
                    Double.valueOf(v.y),
                    Double.valueOf(v.z),
                    Double.valueOf(v.u),
                    Double.valueOf(v.v),
                    Integer.valueOf(v.brightness),
                    Integer.valueOf(v.colorArgb)));
        }
        Collections.sort(verts);
        StringBuilder sb = new StringBuilder();
        sb.append(materialKey == null ? "?" : materialKey)
            .append('|')
            .append(bindHint == null ? "" : bindHint)
            .append('|')
            .append(q.fromDynamicExtensionPass ? "dyn" : "static")
            .append('|');
        for (String s : verts) {
            sb.append(s)
                .append(';');
        }
        return sb.toString();
    }

    private static void bump(Map<String, Integer> map, String key) {
        Integer c = map.get(key);
        map.put(key, Integer.valueOf(c == null ? 1 : c.intValue() + 1));
    }

    private static String registryIdOf(Block block) {
        GameRegistry.UniqueIdentifier uid = GameRegistry.findUniqueIdentifierFor(block);
        return uid == null ? block.getUnlocalizedName() : uid.toString();
    }

    private static String join(List<String> parts, String sep) {
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < parts.size(); i++) {
            if (i > 0) {
                sb.append(sep);
            }
            sb.append(parts.get(i));
        }
        return sb.toString();
    }

    static String sha256Base64(String input) {
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            byte[] digest = md.digest(input.getBytes(StandardCharsets.UTF_8));
            return Base64.getEncoder()
                .encodeToString(digest);
        } catch (Exception e) {
            return "sha256-error";
        }
    }

    private static String describe(Throwable t) {
        String msg = t.getMessage();
        return t.getClass()
            .getSimpleName() + (msg == null ? "" : ": " + msg);
    }

    static Map<String, Integer> sortedCopy(Map<String, Integer> in) {
        return new LinkedHashMap<String, Integer>(new TreeMap<String, Integer>(in));
    }
}
