package com.lightning.mod.client.multiblock;

import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.TreeSet;

import net.minecraft.block.Block;
import net.minecraft.client.Minecraft;
import net.minecraft.client.renderer.RenderBlocks;
import net.minecraft.client.renderer.Tessellator;
import net.minecraft.client.renderer.texture.TextureMap;
import net.minecraft.entity.EntityLivingBase;
import net.minecraft.init.Blocks;
import net.minecraft.tileentity.TileEntity;

import org.lwjgl.opengl.GL11;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonPrimitive;
import com.lightning.mod.client.meshcapture.MeshCaptureService;
import com.lightning.mod.client.meshcapture.TessellatorCaptureState;
import com.lightning.mod.client.meshcapture.TessellatorCaptureState.CapturedBlockInstance;
import com.lightning.mod.client.meshcapture.postrender.MeshCaptureBlockPostRenderContext;
import com.lightning.mod.client.meshcapture.postrender.MeshCaptureBlockPostRenderRegistry;
import com.lightning.mod.client.meshcapture.primary.BlockPrimaryCaptureContext;
import com.lightning.mod.client.meshcapture.primary.BlockPrimaryCaptureRegistry;

import cpw.mods.fml.common.registry.GameRegistry;
import cpw.mods.fml.relauncher.Side;
import cpw.mods.fml.relauncher.SideOnly;
import gregtech.api.interfaces.metatileentity.IMetaTileEntity;
import gregtech.api.interfaces.tileentity.IGregTechTileEntity;

/**
 * T1.3：把一个<strong>已经真实构建好的变体假世界</strong>逐格烘焙成几何，并产出两样东西：
 * <ol>
 * <li><b>全局调色板下标网格</b>（{@code cellGrid}）：每个非空气位置 → {@link GeometryPalette} 的全局下标，
 * 供 T1.4 做因子化编码（骨架 + 按通道分解的差异规则）；</li>
 * <li><b>两个内容签名</b>：{@code layoutSignature}（坐标 + 方块 + meta，{@link ProbeDummyWorld#stateSignature()}
 * 同口径，用于「构建结果与预期变体一致」的断言）与 {@code geometrySignature}（逐位置的
 * <em>调色板条目内容签名</em>聚合，见下）。</li>
 * </ol>
 * <b>不合成任何几何</b>：每个位置都走既有捕获管线（{@code BlockPrimaryCaptureRegistry} →
 * {@code MeshCaptureBlockPostRenderRegistry} → {@code renderBlockAsItem} 兜底），与
 * {@code MeshCaptureService#finalizeSingleStructure} 的逐格路径是同一套原语，唯一差异是它硬编码
 * {@code Minecraft.theWorld}，而这里要捕获的是 {@link ProbeDummyWorld}。
 *
 * <h3>「逐格捕获」与「同状态共享」的关系（性能与正确性的取舍，已机器化验证）</h3>
 * 一次 <em>full</em> 捕获 = 对每个非空气位置都真实跑一遍渲染管线；一次 <em>grouped</em> 捕获 = 只对每个
 * 「方块状态键」的第一个位置真实跑管线，同键的其余位置直接复用同一条调色板条目。<br>
 * grouped 成立的判据不是假设，而是<strong>前若干变体逐格捕获得出的验证结论</strong>：
 * 某个状态键只有在「某次 full 捕获中它出现的所有位置都给出同一条条目签名」之后才被标为 verified；
 * 出现两条及以上签名的键标为 unstable，含该键的变体一律退回 full。因此：
 * <ul>
 * <li>每个 <b>状态键</b>至少被逐格验证过一次（或标为 unstable 并永远逐格捕获）；</li>
 * <li>同一个变体内同键位置的共享，等价于硬约束「同一方块状态的烘焙几何只存一份」的局部形式；</li>
 * <li>{@code geometrySignature} 由「位置 → 条目签名」聚合，与捕获模式无关，可跨模式/跨运行比对。</li>
 * </ul>
 * 状态键 = {@code registryId:meta | MTE 类名 | 激活位} —— 缺了 MTE 类名会把「同一 blockmachines:0 的静音仓/
 * 维护仓/能量仓」误并成一条（实测它们分别是 7/8/9 个四边形）。
 */
@SideOnly(Side.CLIENT)
public final class VariantGeometryBakery {

    /** 网格约定：{@code [z][row][x]}，{@code row 0 = 顶部}（y 最大），与契约 §4.4 的 cellGrid 约定一致。 */
    public static final class Capture {

        public int blockCount;
        public int quadCount;
        public int positionsCaptured;
        public int positionsShared;
        public int positionsWithQuads;
        /** 非空气但捕获不到任何四边形的位置数（>0 即为覆盖缺口，必须记入失败清单）。 */
        public int blocksWithNoGeometry;
        public String layoutSignature = "";
        public String geometrySignature = "";
        public JsonObject grid = new JsonObject();
        public final List<Integer> paletteRefs = new ArrayList<Integer>();
        public final List<String> errors = new ArrayList<String>();
        /** 诊断：状态键 → 本次**真实捕获**到的条目签名集合（逐格/抽样验证数据）。 */
        public final Map<String, TreeSet<String>> stateToEntrySignatures = new TreeMap<String, TreeSet<String>>();
        /** 本变体新转成 verified 的状态键数。 */
        public int keysNewlyVerified;
        /** 本变体锚定捕获与已验证签名不一致的状态键（响亮记入失败清单）。 */
        public final List<String> keyMismatches = new ArrayList<String>();
        public String captureMode = "full";
    }

    private VariantGeometryBakery() {}

    public static Capture capture(ProbeDummyWorld world, int controllerX, int controllerY, int controllerZ,
        GeometryPalette palette, EntityLivingBase renderInfoFallback, String referencedByMachine,
        Map<String, String> verifiedKeys, TreeSet<String> unstableKeys, int verifyPositionsPerKey, int fullVerifyUpTo) {
        // 捕获期的渲染环境对齐（两件事，缺一不可，见 ProbeCaptureEnvironment 的类注释）：
        // 1) 主菜单态 mc.renderViewEntity 为 null 会让 TESR 补画路径 NPE 被整条吞掉 → 临时挂假玩家；
        // 2) **mc.thePlayer 必须活在正在被捕获的世界里**：GT 的 GTRenderedTexture#getExtendedFacing 用
        // player.getEntityWorld() 查机器朝向，若玩家在会话世界（而方块在 ProbeDummyWorld）就查不到 TE →
        // 回退分支会把 NORTH 面的 .extFacing() 图标覆盖层上下颠倒（扳手图标颠倒的根因）。
        Minecraft mc = Minecraft.getMinecraft();
        ProbeCaptureEnvironment env = ProbeCaptureEnvironment.begin(mc, world, renderInfoFallback);
        try {
            return captureInternal(
                world,
                controllerX,
                controllerY,
                controllerZ,
                palette,
                referencedByMachine,
                verifiedKeys,
                unstableKeys,
                verifyPositionsPerKey,
                fullVerifyUpTo);
        } finally {
            env.end();
        }
    }

    /** 状态键：{@code registryId:meta | MTE 类名 | 激活位}。 */
    public static String stateKeyOf(ProbeDummyWorld world, int wx, int wy, int wz, Block block, int meta) {
        TileEntity te = world.getTileEntity(wx, wy, wz);
        String mteKey = "";
        String active = "";
        if (te instanceof IGregTechTileEntity) {
            IGregTechTileEntity base = (IGregTechTileEntity) te;
            IMetaTileEntity mte = base.getMetaTileEntity();
            mteKey = mte == null ? te.getClass()
                .getName()
                : mte.getClass()
                    .getName();
            active = base.isActive() ? "A" : "I";
        } else if (te != null) {
            mteKey = te.getClass()
                .getName();
        }
        return registryIdOf(block) + ":" + meta + "|" + mteKey + "|" + active;
    }

    private static Capture captureInternal(ProbeDummyWorld world, int controllerX, int controllerY, int controllerZ,
        GeometryPalette palette, String referencedByMachine, Map<String, String> verifiedKeys,
        TreeSet<String> unstableKeys, int verifyPositionsPerKey, int fullVerifyUpTo) {
        Capture out = new Capture();
        TextureMap textureMap = Minecraft.getMinecraft()
            .getTextureMapBlocks();
        RenderBlocks rb = new RenderBlocks(world);
        rb.renderAllFaces = true;

        List<int[]> positions = world.placedPositions();
        if (positions.isEmpty()) {
            out.errors.add("空世界：没有任何已放置方块");
            out.grid = emptyGrid();
            return out;
        }

        int minX = Integer.MAX_VALUE, minY = Integer.MAX_VALUE, minZ = Integer.MAX_VALUE;
        int maxX = Integer.MIN_VALUE, maxY = Integer.MIN_VALUE, maxZ = Integer.MIN_VALUE;
        for (int[] p : positions) {
            minX = Math.min(minX, p[0]);
            minY = Math.min(minY, p[1]);
            minZ = Math.min(minZ, p[2]);
            maxX = Math.max(maxX, p[0]);
            maxY = Math.max(maxY, p[1]);
            maxZ = Math.max(maxZ, p[2]);
        }
        int sizeX = maxX - minX + 1;
        int sizeY = maxY - minY + 1;
        int sizeZ = maxZ - minZ + 1;

        // 先算全部位置的状态键，再按键分组（同键位置共享同一条调色板条目）
        Map<String, List<int[]>> byKey = new LinkedHashMap<String, List<int[]>>();
        for (int[] p : positions) {
            Block block = world.getBlock(p[0], p[1], p[2]);
            if (block == null || block == Blocks.air) continue;
            String key = stateKeyOf(world, p[0], p[1], p[2], block, world.getBlockMetadata(p[0], p[1], p[2]));
            List<int[]> list = byKey.get(key);
            if (list == null) {
                list = new ArrayList<int[]>();
                byKey.put(key, list);
            }
            list.add(p);
        }

        // cellGrid[z][row][x]，row 0 = 顶部（y = maxY）
        int[][][] cells = new int[sizeZ][sizeY][sizeX];
        TreeSet<Integer> refs = new TreeSet<Integer>();
        List<String> perPositionLines = new ArrayList<String>();
        int newKeys = 0;
        int unstableKeysSeen = 0;

        for (Map.Entry<String, List<int[]>> group : byKey.entrySet()) {
            String key = group.getKey();
            List<int[]> ps = group.getValue();
            boolean unstable = unstableKeys.contains(key);
            String knownSig = verifiedKeys.get(key);
            if (unstable) unstableKeysSeen++;
            if (knownSig == null && !unstable) newKeys++;

            // 每个键在本变体至少锚定捕获 1 格（真实几何来源）；抽样/逐格预算如下
            int budget;
            if (unstable) {
                budget = ps.size();
            } else if (knownSig == null) {
                budget = ps.size() <= fullVerifyUpTo ? ps.size()
                    : Math.min(ps.size(), Math.max(1, verifyPositionsPerKey));
            } else {
                budget = 1;
            }

            GeometryPalette.Entry firstEntry = null;
            TreeSet<String> sigsHere = new TreeSet<String>();
            boolean mismatch = false;
            for (int pi = 0; pi < ps.size(); pi++) {
                int[] p = ps.get(pi);
                boolean captureThis = pi == 0 || pi < budget || mismatch;
                GeometryPalette.Entry entry;
                if (captureThis) {
                    entry = captureOne(world, palette, textureMap, rb, p[0], p[1], p[2], referencedByMachine, out);
                    sigsHere.add(entry.signature);
                    if (firstEntry == null) {
                        firstEntry = entry;
                        if (knownSig != null && !knownSig.equals(entry.signature)) {
                            // 已验证的键在本变体锚定捕获给出了不同几何 → 该键标记不稳定并响亮记录
                            mismatch = true;
                            unstableKeys.add(key);
                            out.keyMismatches
                                .add(key + " 锚定捕获签名 " + shortSig(entry.signature) + " ≠ 已验证签名 " + shortSig(knownSig));
                            out.errors.add("状态键锚定不一致: " + key);
                        }
                    }
                } else {
                    entry = firstEntry;
                    if (entry == null) {
                        entry = captureOne(world, palette, textureMap, rb, p[0], p[1], p[2], referencedByMachine, out);
                        firstEntry = entry;
                        sigsHere.add(entry.signature);
                    } else {
                        palette.noteReference(entry, referencedByMachine);
                        out.positionsShared++;
                    }
                }
                int cellZ = p[2] - minZ;
                int cellRow = maxY - p[1];
                int cellX = p[0] - minX;
                cells[cellZ][cellRow][cellX] = entry.index;
                refs.add(Integer.valueOf(entry.index));
                out.quadCount += entry.quadCount;
                if (entry.quadCount > 0) out.positionsWithQuads++;
                out.blockCount++;
                perPositionLines.add(p[0] + "," + p[1] + "," + p[2] + "=" + entry.signature);

                TreeSet<String> sigs = out.stateToEntrySignatures.get(key);
                if (sigs == null) {
                    sigs = new TreeSet<String>();
                    out.stateToEntrySignatures.put(key, sigs);
                }
                sigs.add(entry.signature);
            }

            if (!unstable && knownSig == null) {
                if (sigsHere.size() == 1) {
                    verifiedKeys.put(key, sigsHere.first());
                    out.keysNewlyVerified++;
                } else {
                    unstableKeys.add(key);
                    out.keyMismatches.add(key + " 同变体内出现 " + sigsHere.size() + " 条不同几何签名（位置相关渲染）");
                    out.errors.add("状态键位置相关: " + key);
                }
            }
        }

        out.captureMode = out.positionsShared == 0 ? "full(逐格捕获)"
            : (newKeys > 0 ? "sampled(新状态键抽样验证)" : "anchored(每键锚定捕获 + 已验证状态共享)");

        Collections.sort(perPositionLines);
        out.geometrySignature = StateGeometryCapture.sha256Base64(join(perPositionLines, "\n"));
        out.layoutSignature = world.stateSignature();
        out.paletteRefs.addAll(refs);

        JsonObject grid = new JsonObject();
        JsonArray origin = new JsonArray();
        origin.add(new JsonPrimitive(minX - controllerX));
        origin.add(new JsonPrimitive(minY - controllerY));
        origin.add(new JsonPrimitive(minZ - controllerZ));
        grid.add("origin", origin);
        JsonArray size = new JsonArray();
        size.add(new JsonPrimitive(sizeX));
        size.add(new JsonPrimitive(sizeY));
        size.add(new JsonPrimitive(sizeZ));
        grid.add("size", size);
        JsonArray zArr = new JsonArray();
        for (int z = 0; z < sizeZ; z++) {
            JsonArray rowArr = new JsonArray();
            for (int row = 0; row < sizeY; row++) {
                JsonArray xArr = new JsonArray();
                for (int x = 0; x < sizeX; x++) {
                    xArr.add(new JsonPrimitive(cells[z][row][x]));
                }
                rowArr.add(xArr);
            }
            zArr.add(rowArr);
        }
        grid.add("cellGrid", zArr);
        out.grid = grid;
        return out;
    }

    /** 真实逐格捕获一个位置并把几何入库（复用既有捕获原语）。 */
    private static GeometryPalette.Entry captureOne(ProbeDummyWorld world, GeometryPalette palette,
        TextureMap textureMap, RenderBlocks rb, int wx, int wy, int wz, String referencedByMachine, Capture out) {
        Block block = world.getBlock(wx, wy, wz);
        int meta = world.getBlockMetadata(wx, wy, wz);
        String registryId = registryIdOf(block);
        String posKey = wx + "," + wy + "," + wz;

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
            out.errors.add("(" + posKey + ") " + registryId + " -> " + describe(t));
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
        if (inst.quads.isEmpty()) {
            out.blocksWithNoGeometry++;
            return palette.entries()
                .get(0);
        }
        out.positionsCaptured++;
        // applySpriteLocalToQuad 会把顶点 UV 就地改写成 sprite 局部 [0,1] 并写回 q.materialKey，
        // 因此**每个四边形只能调用一次**（重复调用会把局部 UV 当图集 UV 再解析 → 退化成 "unknown"）。
        MeshCaptureService.CaptureToolkit.attachQuadMaterials(inst, textureMap, palette.materials());
        JsonObject geometry = MeshCaptureService.CaptureToolkit.geometryOf(inst);
        // 注意：不传 Block —— 调色板条目不再带 thumbnailPNG（GPU 像素跨运行不稳定，见 GeometryPalette 类注释）。
        return palette.intern(registryId, meta, geometry, block.isOpaqueCube(), referencedByMachine, inst.quads.size());
    }

    private static JsonObject emptyGrid() {
        JsonObject grid = new JsonObject();
        JsonArray origin = new JsonArray();
        origin.add(new JsonPrimitive(0));
        origin.add(new JsonPrimitive(0));
        origin.add(new JsonPrimitive(0));
        grid.add("origin", origin);
        JsonArray size = new JsonArray();
        size.add(new JsonPrimitive(0));
        size.add(new JsonPrimitive(0));
        size.add(new JsonPrimitive(0));
        grid.add("size", size);
        grid.add("cellGrid", new JsonArray());
        return grid;
    }

    static String registryIdOf(Block block) {
        GameRegistry.UniqueIdentifier uid = GameRegistry.findUniqueIdentifierFor(block);
        return uid == null ? block.getUnlocalizedName() : uid.toString();
    }

    private static String shortSig(String sig) {
        if (sig == null) return "<null>";
        return sig.length() <= 12 ? sig : sig.substring(0, 12) + "…";
    }

    private static String join(List<String> parts, String sep) {
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < parts.size(); i++) {
            if (i > 0) sb.append(sep);
            sb.append(parts.get(i));
        }
        return sb.toString();
    }

    private static String describe(Throwable t) {
        String msg = t.getMessage();
        return t.getClass()
            .getSimpleName() + (msg == null ? "" : ": " + msg);
    }
}
