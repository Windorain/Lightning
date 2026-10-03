package com.lightning.mod.client.meshcapture.parts.probe;

import java.lang.reflect.Constructor;
import java.lang.reflect.Method;
import java.util.ArrayList;
import java.util.List;

import net.minecraft.block.Block;
import net.minecraft.entity.player.EntityPlayer;
import net.minecraft.init.Blocks;
import net.minecraft.item.Item;
import net.minecraft.item.ItemStack;
import net.minecraft.tileentity.TileEntity;
import net.minecraft.world.World;
import net.minecraft.world.WorldServer;
import net.minecraftforge.common.util.ForgeDirection;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonPrimitive;
import com.lightning.mod.client.meshcapture.parts.PartSource;

import cpw.mods.fml.relauncher.Side;
import cpw.mods.fml.relauncher.SideOnly;

/**
 * P1.8 验收测试结构建造器 —— 程序化建造八个分区的验收结构，并把每格的<strong>放置意图</strong>
 * （族/部件/物品/期望档位/盒数）同步记录为 oracle ground truth（契约
 * {@code format-parts-contract.md} §11：ground truth 是建造副产品，不靠人维护）。
 *
 * <p>
 * 放置通道与 P0.2/P1.3–P1.5 探针完全一致（各族自己的真实添加路径 + 正常同步）：
 * AE2 = {@code TileCableBus#addPart} / {@code IFacadeContainer#addFacade}；
 * EnderIO = {@code item.createConduit} + {@code TileConduitBundle#addConduit}；
 * FMP = {@code CommonMicroClass#create} + {@code setShape} + {@code TileMultipart.addPart}；
 * 原版 = {@code world.setBlock}。
 *
 * <p>
 * <strong>世界重置</strong>（跨轮幂等根因解法，照 PartsProbePlacement.placeFamilyPrep 办理）：
 * FMP 格逐部件反射 {@code remPart}（removal 包同步两端，杜绝客户端 stale tile 跨轮堆积），
 * 其余格 {@code removeTileEntity} + {@code setBlockToAir}；整个包围盒清场后再放置。
 *
 * <p>
 * 分区布局（相对基点 bx,by,bz；结构包围盒 x∈[bx+1,bx+13]、y∈{by,by+1}、z∈[bz,bz+14]）：
 *
 * <pre>
 * z+0  满方块区：石头×2 / 熔炉 / 工作台（快速否定 + 字节干净对照）
 * z+2  单盒区：下半 slab / 上半 slab / 地面火把（垫脚石在 y-1，不在结构内）/ 石柱+挂墙火把
 *             / 单箱 / 双箱（西、东）
 * z+4  单盒区·栅栏：孤立 / 东西三连（3 格全录）/ 四向十字（中心 x+12，臂 x+11、x+13、z+3、z+5）
 * z+6  AE2 区：纯线缆 / 线缆+切換总线(N)+存储总线(U) / 线缆+成型面板(N)+破坏面板(S)+终端(U)+伪装板(E)
 * z+8  EnderIO 区：5 导管束 + 邻格（能量+物品）⇒ 跨格连接段
 * z+10 FMP 区：slab+panel 主格 / 跨格对（y 层上半 slab + y+1 层下半 slab，两格各一部件）
 * z+12 叠加区（已裁决 = 最大复杂度真实格组合）：5 导管束+邻格 / AE2 facade+线缆格 / FMP 三微方块格
 * z+14 变体区：异色 AE2 玻璃线缆混放（Fluix/Red/Blue，不同 damage）
 * </pre>
 *
 * 退化区不占世界格子 = 同一建造产物在提供者开关关闭后重导出（PartsAcceptanceAutomation 编排），
 * oracle 由 {@link PartsAcceptanceOracle} 对同一意图清单做期望档位变换生成。
 */
@SideOnly(Side.CLIENT)
final class PartsAcceptanceBuilder {

    // ------------------------------------------------------------------ 意图记录（oracle 数据源）

    /** 一个部件的期望（oracle §11 cells[].parts[] 元素；boxCount=-1 / boxProvenance="*" = 退化格不校验哨兵）。 */
    static final class ExpectedPart {

        final String localId;
        final String typeKey;
        final int itemCount;
        final int boxTier;
        final int boxCount;
        final String boxProvenance;
        /** expectedCounts 的 display 来源（信息字段，不参与断言）。 */
        String display;

        ExpectedPart(String localId, String typeKey, int itemCount, int boxTier, int boxCount, String boxProvenance) {
            this.localId = localId;
            this.typeKey = typeKey;
            this.itemCount = itemCount;
            this.boxTier = boxTier;
            this.boxCount = boxCount;
            this.boxProvenance = boxProvenance;
        }
    }

    /** 一格的放置意图（oracle §11 cells[] 元素 + zone/grid 扩展字段的数据源）。 */
    static final class CellIntent {

        final String zone;
        final int x;
        final int y;
        final int z;
        boolean expectFullCube;
        String host;
        final List<ExpectedPart> parts = new ArrayList<ExpectedPart>();

        CellIntent(String zone, int x, int y, int z) {
            this.zone = zone;
            this.x = x;
            this.y = y;
            this.z = z;
        }
    }

    /** 结构包围盒（oracle root 的 gridIndex 扩展字段数据源）。 */
    static final int SIZE_X = 13; // ci = x - (bx+1)
    static final int SIZE_Y = 2; // ri = (by+1) - y（row 0 = 顶层，V2 惯例 row0=顶）
    static final int SIZE_Z = 15; // zi = z - bz

    final List<CellIntent> cells = new ArrayList<CellIntent>();
    final JsonArray buildLog = new JsonArray();
    final JsonArray errors = new JsonArray();

    // ------------------------------------------------------------------ 入口

    /**
     * 跨轮幂等清场（须在 {@link #build} 之前调用）：包围盒 x∈[bx-1,bx+16]、y∈[by-2,by+3]、
     * z∈[bz-1,bz+20]。FMP 格走 {@code remPart} 正常移除通道（同步客户端），其余 setBlockToAir。
     */
    void resetWorld(WorldServer world, int bx, int by, int bz) {
        try {
            Class<?> tMultiPartClass = PartsProbeReflect.cls("codechicken.multipart.TMultiPart");
            for (int x = bx - 1; x <= bx + 16; x++) {
                for (int y = by - 2; y <= by + 3; y++) {
                    for (int z = bz - 1; z <= bz + 20; z++) {
                        TileEntity te = world.getTileEntity(x, y, z);
                        if (te != null && te.getClass()
                            .getName()
                            .contains("TileMultipart")) {
                            // FMP 正常移除通道：逐部件 remPart（removal 包同步两端；
                            // 最后一个部件移除后 FMP 自行 setBlockToAir）
                            for (int guard = 0; guard < 64; guard++) {
                                TileEntity t = world.getTileEntity(x, y, z);
                                if (t == null || !t.getClass()
                                    .getName()
                                    .contains("TileMultipart")) {
                                    break;
                                }
                                List<?> parts = (List<?>) t.getClass()
                                    .getMethod("jPartList")
                                    .invoke(t);
                                if (parts == null || parts.isEmpty()) {
                                    break;
                                }
                                t.getClass()
                                    .getMethod("remPart", tMultiPartClass)
                                    .invoke(t, parts.get(0));
                            }
                        }
                        world.removeTileEntity(x, y, z);
                        world.setBlockToAir(x, y, z);
                    }
                }
            }
        } catch (Throwable t) {
            errors.add(new JsonPrimitive("resetWorld: " + PartsProbeReflect.describe(t)));
        }
    }

    /** 按分区放置全部验收结构并记录意图；每区独立 try/catch，一区失败不拖垮它区（细节进 errors）。 */
    void build(WorldServer world, EntityPlayer player, int bx, int by, int bz) {
        try {
            buildFullCubeZone(world, bx, by, bz);
        } catch (Throwable t) {
            errors.add(new JsonPrimitive("zone/full-cube: " + PartsProbeReflect.describe(t)));
        }
        try {
            buildSingleBoxZone(world, bx, by, bz);
        } catch (Throwable t) {
            errors.add(new JsonPrimitive("zone/single-box: " + PartsProbeReflect.describe(t)));
        }
        try {
            buildAe2Zone(world, bx, by, bz);
        } catch (Throwable t) {
            errors.add(new JsonPrimitive("zone/ae2: " + PartsProbeReflect.describe(t)));
        }
        try {
            buildEnderIoZone(world, player, bx, by, bz, "enderio");
        } catch (Throwable t) {
            errors.add(new JsonPrimitive("zone/enderio: " + PartsProbeReflect.describe(t)));
        }
        try {
            buildFmpZone(world, bx, by, bz);
        } catch (Throwable t) {
            errors.add(new JsonPrimitive("zone/fmp: " + PartsProbeReflect.describe(t)));
        }
        try {
            buildOverlayZone(world, player, bx, by, bz);
        } catch (Throwable t) {
            errors.add(new JsonPrimitive("zone/overlay: " + PartsProbeReflect.describe(t)));
        }
        try {
            buildVariantsZone(world, bx, by, bz);
        } catch (Throwable t) {
            errors.add(new JsonPrimitive("zone/variants: " + PartsProbeReflect.describe(t)));
        }
        // 宿主身份快照（放置完成后从世界读 registry:meta）
        for (CellIntent c : cells) {
            try {
                Block b = world.getBlock(c.x, c.y, c.z);
                int meta = world.getBlockMetadata(c.x, c.y, c.z);
                String reg = Block.blockRegistry.getNameForObject(b);
                c.host = (reg == null ? "<unregistered>" : reg) + ":" + meta;
            } catch (Throwable t) {
                c.host = "<host snapshot failed>";
                errors.add(new JsonPrimitive("host-snapshot: " + PartsProbeReflect.describe(t)));
            }
        }
    }

    // ------------------------------------------------------------------ 满方块区（z+0）

    private void buildFullCubeZone(World world, int bx, int by, int bz) {
        int z = bz + 0;
        world.setBlock(bx + 1, by, z, Blocks.stone, 0, 3);
        world.setBlock(bx + 2, by, z, Blocks.stone, 0, 3);
        world.setBlock(bx + 3, by, z, Blocks.furnace, 2, 3);
        world.setBlock(bx + 4, by, z, Blocks.crafting_table, 0, 3);
        fullCubeCell("full-cube", bx + 1, by, z);
        fullCubeCell("full-cube", bx + 2, by, z);
        fullCubeCell("full-cube", bx + 3, by, z);
        fullCubeCell("full-cube", bx + 4, by, z);
    }

    // ------------------------------------------------------------------ 单盒区（z+2 slab/火把/箱；z+4 栅栏）

    private void buildSingleBoxZone(World world, int bx, int by, int bz) {
        int z = bz + 2;
        world.setBlock(bx + 1, by, z, Blocks.stone_slab, 0, 3); // 下半
        world.setBlock(bx + 2, by, z, Blocks.stone_slab, 8, 3); // 上半
        world.setBlock(bx + 4, by - 1, z, Blocks.stone, 0, 3); // 火把垫脚石（结构外）
        world.setBlock(bx + 4, by, z, Blocks.torch, 5, 3); // 地面火把
        world.setBlock(bx + 5, by, z, Blocks.stone, 0, 3); // 挂墙火把承载柱（结构内满方块）
        world.setBlock(bx + 6, by, z, Blocks.torch, 1, 3); // 挂墙火把（附 x-1 柱）
        world.setBlock(bx + 8, by, z, Blocks.chest, 2, 3); // 单箱
        world.setBlock(bx + 10, by, z, Blocks.chest, 2, 3); // 双箱（西）
        world.setBlock(bx + 11, by, z, Blocks.chest, 2, 3); // 双箱（东）

        // 档 2 通用盒：1 视觉 + 1 碰撞（P0.3 §2.4 基准）
        partCell(
            "single-box",
            bx + 1,
            by,
            z,
            new ExpectedPart("generic:0", "minecraft:stone_slab:0", 1, PartSource.TIER_GENERIC, 2, "both"));
        partCell(
            "single-box",
            bx + 2,
            by,
            z,
            new ExpectedPart("generic:0", "minecraft:stone_slab:0", 1, PartSource.TIER_GENERIC, 2, "both"));
        // 火把：档 2 不产出（§7.3 退化），落档 3 inferred；p18-calib-1 实测 = 6 岛 × 1 视觉盒
        // （火把 alpha 斜面经 AlphaTightener 收紧后按面分区为 6 个各 1 盒的岛，地面/挂墙同形）
        partCell("single-box", bx + 4, by, z, torchParts());
        fullCubeCell("single-box", bx + 5, by, z); // 承载柱
        partCell("single-box", bx + 6, by, z, torchParts());
        partCell(
            "single-box",
            bx + 8,
            by,
            z,
            new ExpectedPart("generic:0", "minecraft:chest:0", 1, PartSource.TIER_GENERIC, 2, "both"));
        partCell(
            "single-box",
            bx + 10,
            by,
            z,
            new ExpectedPart("generic:0", "minecraft:chest:0", 1, PartSource.TIER_GENERIC, 2, "both"));
        partCell(
            "single-box",
            bx + 11,
            by,
            z,
            new ExpectedPart("generic:0", "minecraft:chest:0", 1, PartSource.TIER_GENERIC, 2, "both"));

        // 栅栏（邻居形态快照：孤立 / 东西三连 / 四向十字）
        int zf = bz + 4;
        world.setBlock(bx + 1, by, zf, Blocks.fence, 0, 3); // 孤立
        world.setBlock(bx + 3, by, zf, Blocks.fence, 0, 3); // 东西三连
        world.setBlock(bx + 4, by, zf, Blocks.fence, 0, 3);
        world.setBlock(bx + 5, by, zf, Blocks.fence, 0, 3);
        world.setBlock(bx + 12, by, zf, Blocks.fence, 0, 3); // 四向十字（中心）
        world.setBlock(bx + 11, by, zf, Blocks.fence, 0, 3);
        world.setBlock(bx + 13, by, zf, Blocks.fence, 0, 3);
        world.setBlock(bx + 12, by, zf - 1, Blocks.fence, 0, 3);
        world.setBlock(bx + 12, by, zf + 1, Blocks.fence, 0, 3);

        // 孤立/单向连接：视觉 1 + 碰撞多盒 1 = 2；四向中心：视觉整格 1 + 碰撞 2 杆 = 3（P0.3 §2.4）
        partCell(
            "single-box",
            bx + 1,
            by,
            zf,
            new ExpectedPart("generic:0", "minecraft:fence:0", 1, PartSource.TIER_GENERIC, 2, "both"));
        partCell(
            "single-box",
            bx + 3,
            by,
            zf,
            new ExpectedPart("generic:0", "minecraft:fence:0", 1, PartSource.TIER_GENERIC, 2, "both"));
        partCell(
            "single-box",
            bx + 4,
            by,
            zf,
            new ExpectedPart("generic:0", "minecraft:fence:0", 1, PartSource.TIER_GENERIC, 2, "both"));
        partCell(
            "single-box",
            bx + 5,
            by,
            zf,
            new ExpectedPart("generic:0", "minecraft:fence:0", 1, PartSource.TIER_GENERIC, 2, "both"));
        partCell(
            "single-box",
            bx + 12,
            by,
            zf,
            new ExpectedPart("generic:0", "minecraft:fence:0", 1, PartSource.TIER_GENERIC, 3, "both"));
        partCell(
            "single-box",
            bx + 11,
            by,
            zf,
            new ExpectedPart("generic:0", "minecraft:fence:0", 1, PartSource.TIER_GENERIC, 2, "both"));
        partCell(
            "single-box",
            bx + 13,
            by,
            zf,
            new ExpectedPart("generic:0", "minecraft:fence:0", 1, PartSource.TIER_GENERIC, 2, "both"));
        partCell(
            "single-box",
            bx + 12,
            by,
            zf - 1,
            new ExpectedPart("generic:0", "minecraft:fence:0", 1, PartSource.TIER_GENERIC, 2, "both"));
        partCell(
            "single-box",
            bx + 12,
            by,
            zf + 1,
            new ExpectedPart("generic:0", "minecraft:fence:0", 1, PartSource.TIER_GENERIC, 2, "both"));
    }

    /** 火把格期望（档 3，6 岛 × 1 视觉盒；localId = inferred:0..5 按四边形输入顺序确定性分区）。 */
    private static ExpectedPart[] torchParts() {
        ExpectedPart[] parts = new ExpectedPart[6];
        for (int i = 0; i < 6; i++) {
            parts[i] = new ExpectedPart(
                "inferred:" + i,
                "minecraft:torch:0",
                1,
                PartSource.TIER_INFERRED,
                1,
                PartSource.PROVENANCE_VISUAL_ONLY);
        }
        return parts;
    }

    // ------------------------------------------------------------------ AE2 区（z+6）

    private void buildAe2Zone(World world, int bx, int by, int bz) throws Exception {
        int z = bz + 6;
        // A：纯线缆（x+1）
        TileEntity teA = ae2CableBusCell(world, bx + 1, by, z);
        ItemStack cableA = ae2CableStack("Transparent");
        ae2AddPart(teA, cableA, ForgeDirection.UNKNOWN);
        partCell("ae2", bx + 1, by, z, ae2Part("ae2:UNKNOWN", cableA, 1, PartSource.TIER_FAMILY, 2, "both"));

        // B：线缆 + 切換总线(N) + 存储总线(U)（x+3；P0.2/P1.3 基准格）
        TileEntity teB = ae2CableBusCell(world, bx + 3, by, z);
        ItemStack cableB = ae2CableStack("Transparent");
        ItemStack toggle = ae2PartStack("toggleBus");
        ItemStack storage = ae2PartStack("storageBus");
        ae2AddPart(teB, cableB, ForgeDirection.UNKNOWN);
        ae2AddPart(teB, toggle, ForgeDirection.NORTH);
        ae2AddPart(teB, storage, ForgeDirection.UP);
        partCell(
            "ae2",
            bx + 3,
            by,
            z,
            // p18-calib-1 实测：挂接 N/U 部件后线缆芯盒带内接桩（3v+3c=6）；存储总线 3v+3c=6
            ae2Part("ae2:UNKNOWN", cableB, 1, PartSource.TIER_FAMILY, 6, "both"),
            ae2Part("ae2:NORTH", toggle, 1, PartSource.TIER_FAMILY, 2, "both"),
            ae2Part("ae2:UP", storage, 1, PartSource.TIER_FAMILY, 6, "both"));

        // C：线缆 + 成型面板(N) + 破坏面板(S) + 终端(U) + 伪装板(E)（x+5；分区表四要素全覆盖）
        TileEntity teC = ae2CableBusCell(world, bx + 5, by, z);
        ItemStack cableC = ae2CableStack("Transparent");
        ItemStack formation = ae2PartStack("formationPlane");
        ItemStack annihilation = ae2PartStack("annihilationPlane");
        ItemStack terminal = ae2PartStack("terminal");
        ae2AddPart(teC, cableC, ForgeDirection.UNKNOWN);
        ae2AddPart(teC, formation, ForgeDirection.NORTH);
        ae2AddPart(teC, annihilation, ForgeDirection.SOUTH);
        ae2AddPart(teC, terminal, ForgeDirection.UP);
        ItemStack facadeStack = ae2FacadeStack();
        ae2AddFacade(teC, facadeStack, ForgeDirection.EAST);
        partCell(
            "ae2",
            bx + 5,
            by,
            z,
            // p18-calib-1 实测：四面部件线缆芯 4v+4c=8；成型/破坏面板与终端各 2v+2c=4；伪装板 1v+1c=2
            ae2Part("ae2:UNKNOWN", cableC, 1, PartSource.TIER_FAMILY, 8, "both"),
            ae2Part("ae2:NORTH", formation, 1, PartSource.TIER_FAMILY, 4, "both"),
            ae2Part("ae2:SOUTH", annihilation, 1, PartSource.TIER_FAMILY, 4, "both"),
            ae2Part("ae2:UP", terminal, 1, PartSource.TIER_FAMILY, 4, "both"),
            ae2Part("ae2:facade:EAST", facadeStack, 1, PartSource.TIER_FAMILY, 2, "both"));
    }

    // ------------------------------------------------------------------ EnderIO 区（z+8）与叠加区束（z+12）

    private void buildEnderIoZone(World world, EntityPlayer player, int bx, int by, int bz, String zone)
        throws Exception {
        int z = bz + ("overlay".equals(zone) ? 12 : 8);
        eioBundlePair(world, player, bx + 1, by, z, zone);
    }

    /**
     * 5 导管束格 + 邻格（能量+物品）：束格能量/物品导管带 EAST 跨格连接段（P0.2 §2.6 基准：
     * 芯盒 + 臂盒，视觉=碰撞同一几何源推导，collision-derived-visual）；连接器（conduitType==null）
     * 不发射为部件 ⇒ 恰 5 部件。邻格 2 部件各带 WEST 臂。
     */
    private void eioBundlePair(World world, EntityPlayer player, int x, int y, int z, String zone) throws Exception {
        Class<?> eioClass = PartsProbeReflect.cls("crazypants.enderio.EnderIO");
        Class<?> conduitIface = PartsProbeReflect.cls("crazypants.enderio.conduit.IConduit");
        Block bundleBlock = findBlockByClass("crazypants.enderio.conduit.BlockConduitBundle");

        world.setBlock(x, y, z, bundleBlock, 0, 3);
        world.setBlock(x + 1, y, z, bundleBlock, 0, 3);
        TileEntity te = world.getTileEntity(x, y, z);
        TileEntity te2 = world.getTileEntity(x + 1, y, z);
        if (te == null || !te.getClass()
            .getName()
            .contains("TileConduitBundle")) {
            throw new IllegalStateException(
                "EnderIO tile 未按预期生成: " + (te == null ? "null"
                    : te.getClass()
                        .getName()));
        }
        Method addConduit = te.getClass()
            .getMethod("addConduit", conduitIface);

        String[][] five = { { "itemPowerConduit", "eio:IPowerConduit" }, { "itemItemConduit", "eio:IItemConduit" },
            { "itemLiquidConduit", "eio:ILiquidConduit" }, { "itemRedstoneConduit", "eio:IRedstoneConduit" },
            { "itemMEConduit", "eio:IMEConduit" } };
        List<ExpectedPart> main = new ArrayList<ExpectedPart>();
        for (String[] e : five) {
            Item item = (Item) eioClass.getField(e[0])
                .get(null);
            if (item == null) {
                throw new IllegalStateException("EnderIO 静态物品字段为 null: " + e[0]);
            }
            addConduit.invoke(te, createConduit(item, player));
            // 能量/物品导管与邻格相连 ⇒ p18-calib-1 实测：能量 3v+3c=6（芯多段+臂）、物品 2v+2c=4；
            // 其余孤立芯 = 1v+1c=2
            int boxes = "itemPowerConduit".equals(e[0]) ? 6 : ("itemItemConduit".equals(e[0]) ? 4 : 2);
            main.add(eioPart(e[1], item, boxes));
        }
        addConduit.invoke(
            te2,
            createConduit(
                (Item) eioClass.getField("itemPowerConduit")
                    .get(null),
                player));
        addConduit.invoke(
            te2,
            createConduit(
                (Item) eioClass.getField("itemItemConduit")
                    .get(null),
                player));
        world.markBlockForUpdate(x, y, z);
        world.markBlockForUpdate(x + 1, y, z);

        partCell(zone, x, y, z, main.toArray(new ExpectedPart[0]));
        partCell(
            zone,
            x + 1,
            y,
            z,
            eioPart(
                "eio:IPowerConduit",
                (Item) eioClass.getField("itemPowerConduit")
                    .get(null),
                6),
            eioPart(
                "eio:IItemConduit",
                (Item) eioClass.getField("itemItemConduit")
                    .get(null),
                4));
    }

    // ------------------------------------------------------------------ FMP 区（z+10）

    private void buildFmpZone(World world, int bx, int by, int bz) throws Exception {
        int z = bz + 10;
        FmpMats mats = fmpMaterials();
        // 主格（x+1）：底半台阶(slot0, 主材) + 顶面板(slot1, 玻璃材) —— P0.2/P1.5 基准格
        fmpAddPart(world, bx + 1, by, z, mats, 4, 0, mats.stoneId);
        fmpAddPart(world, bx + 1, by, z, mats, 2, 1, mats.altId);
        partCell(
            "fmp",
            bx + 1,
            by,
            z,
            fmpPart("fmp:slot0", 4, mats.stoneMat, 2),
            fmpPart("fmp:slot1", 2, mats.altMat, 2));
        // 跨格对：cell A（x+3, by）顶半 slab(slot1) + cell B（x+3, by+1）底半 slab(slot0)
        // —— 「一块跨格微方块」由「两格各有一个部件」表达（probe-family-apis §3.6 结论 4）
        fmpAddPart(world, bx + 3, by, z, mats, 4, 1, mats.stoneId);
        fmpAddPart(world, bx + 3, by + 1, z, mats, 4, 0, mats.stoneId);
        partCell("fmp", bx + 3, by, z, fmpPart("fmp:slot1", 4, mats.stoneMat, 2));
        partCell("fmp", bx + 3, by + 1, z, fmpPart("fmp:slot0", 4, mats.stoneMat, 2));
    }

    // ------------------------------------------------------------------ 叠加区（z+12，已裁决：最大复杂度真实格组合）

    private void buildOverlayZone(World world, EntityPlayer player, int bx, int by, int bz) throws Exception {
        int z = bz + 12;
        // ① EnderIO 5 导管束（含连接器与跨格段）——复用束对建造（x+1/x+2）
        buildEnderIoZone(world, player, bx, by, bz, "overlay");
        // ② AE2 facade+线缆格（x+4）
        TileEntity te = ae2CableBusCell(world, bx + 4, by, z);
        ItemStack cable = ae2CableStack("Transparent");
        ae2AddPart(te, cable, ForgeDirection.UNKNOWN);
        ItemStack facadeStack = ae2FacadeStack();
        ae2AddFacade(te, facadeStack, ForgeDirection.EAST);
        partCell(
            "overlay",
            bx + 4,
            by,
            z,
            ae2Part("ae2:UNKNOWN", cable, 1, PartSource.TIER_FAMILY, 2, "both"),
            ae2Part("ae2:facade:EAST", facadeStack, 1, PartSource.TIER_FAMILY, 2, "both"));
        // ③ FMP 多微方块格（x+6）：slab(slot0) + 顶面板(slot1) + 北面板(slot2)
        FmpMats mats = fmpMaterials();
        fmpAddPart(world, bx + 6, by, z, mats, 4, 0, mats.stoneId);
        fmpAddPart(world, bx + 6, by, z, mats, 2, 1, mats.altId);
        fmpAddPart(world, bx + 6, by, z, mats, 2, 2, mats.thirdId);
        partCell(
            "overlay",
            bx + 6,
            by,
            z,
            fmpPart("fmp:slot0", 4, mats.stoneMat, 2),
            fmpPart("fmp:slot1", 2, mats.altMat, 2),
            fmpPart("fmp:slot2", 2, mats.thirdMat, 2));
    }

    // ------------------------------------------------------------------ 变体区（z+14：异色线缆混放，计数键落到物品变体）

    private void buildVariantsZone(World world, int bx, int by, int bz) throws Exception {
        int z = bz + 14;
        String[] colors = { "Transparent", "Red", "Blue" };
        for (int i = 0; i < colors.length; i++) {
            int x = bx + 1 + i * 2;
            TileEntity te = ae2CableBusCell(world, x, by, z);
            ItemStack cable = ae2CableStack(colors[i]);
            ae2AddPart(te, cable, ForgeDirection.UNKNOWN);
            // typeKey 含 damage（颜色变体）：Transparent=:16 / Red=:14 / Blue=:11，由实际栈捕获
            partCell("variants", x, by, z, ae2Part("ae2:UNKNOWN", cable, 1, PartSource.TIER_FAMILY, 2, "both"));
        }
    }

    // ------------------------------------------------------------------ 意图记录小工具

    private void fullCubeCell(String zone, int x, int y, int z) {
        CellIntent c = new CellIntent(zone, x, y, z);
        c.expectFullCube = true;
        cells.add(c);
    }

    private void partCell(String zone, int x, int y, int z, ExpectedPart... parts) {
        CellIntent c = new CellIntent(zone, x, y, z);
        c.expectFullCube = false;
        for (ExpectedPart p : parts) {
            c.parts.add(p);
        }
        cells.add(c);
    }

    /** AE2 部件期望：typeKey 从实际放置栈捕获（registry:damage，含颜色/变体 damage）。 */
    private static ExpectedPart ae2Part(String localId, ItemStack stack, int itemCount, int tier, int boxCount,
        String provenance) {
        ExpectedPart p = new ExpectedPart(localId, stackTypeKey(stack), itemCount, tier, boxCount, provenance);
        p.display = safeDisplayName(stack);
        return p;
    }

    /** EnderIO 部件期望：typeKey = registry:0（导管 subtype 即物品）。 */
    private static ExpectedPart eioPart(String localId, Item item, int boxCount) {
        ItemStack stack = new ItemStack(item, 1, 0);
        ExpectedPart p = new ExpectedPart(
            localId,
            stackTypeKey(stack),
            1,
            PartSource.TIER_FAMILY,
            boxCount,
            PartSource.PROVENANCE_COLLISION_DERIVED_VISUAL);
        p.display = safeDisplayName(stack);
        return p;
    }

    /** FMP 部件期望：typeKey = microblock:<size>#mat=<材料串>（P1.5 基准）。 */
    private static ExpectedPart fmpPart(String localId, int size, String mat, int boxCount) {
        ExpectedPart p = new ExpectedPart(
            localId,
            "ForgeMicroblock:microblock:" + size + "#mat=" + mat,
            1,
            PartSource.TIER_FAMILY,
            boxCount,
            PartSource.PROVENANCE_BOTH);
        p.display = "microblock:" + size + " mat=" + mat;
        return p;
    }

    private static String stackTypeKey(ItemStack stack) {
        String reg = Item.itemRegistry.getNameForObject(stack.getItem());
        return (reg == null ? "<unregistered>" : reg) + ":" + stack.getItemDamage();
    }

    private static String safeDisplayName(ItemStack stack) {
        try {
            return stack.getDisplayName();
        } catch (Throwable t) {
            return stack.getUnlocalizedName();
        }
    }

    // ------------------------------------------------------------------ AE2 放置半环（P0.2 通道）

    private static Object ae2Defs(String group) throws Exception {
        Class<?> aeApiClass = PartsProbeReflect.cls("appeng.api.AEApi");
        Object api = aeApiClass.getMethod("instance")
            .invoke(null);
        Object defs = PartsProbeReflect.invoke(api, "definitions", new Class<?>[0]);
        return PartsProbeReflect.invoke(defs, group, new Class<?>[0]);
    }

    private static ItemStack ae2CableStack(String color) throws Exception {
        Object def = PartsProbeReflect.invoke(ae2Defs("parts"), "cableGlass", new Class<?>[0]);
        Class<?> aeColorClass = PartsProbeReflect.cls("appeng.api.util.AEColor");
        @SuppressWarnings({ "unchecked", "rawtypes" })
        Object colorEnum = Enum.valueOf((Class<? extends Enum>) aeColorClass, color);
        return (ItemStack) def.getClass()
            .getMethod("stack", aeColorClass, int.class)
            .invoke(def, colorEnum, 1);
    }

    private static ItemStack ae2PartStack(String defName) throws Exception {
        Object def = PartsProbeReflect.invoke(ae2Defs("parts"), defName, new Class<?>[0]);
        Object opt = def.getClass()
            .getMethod("maybeStack", int.class)
            .invoke(def, 1);
        // AE2 maybeStack 返回 Guava Optional（Present 是 package-private ⇒ 反射必须打在 Optional 抽象类上）
        Class<?> optionalClass = PartsProbeReflect.cls("com.google.common.base.Optional");
        if (!((Boolean) optionalClass.getMethod("isPresent")
            .invoke(opt)).booleanValue()) {
            throw new IllegalStateException("AE2 definition 无 stack: " + defName);
        }
        return (ItemStack) optionalClass.getMethod("get")
            .invoke(opt);
    }

    private static ItemStack ae2FacadeStack() throws Exception {
        Object items = ae2Defs("items");
        Object def = PartsProbeReflect.invoke(items, "facade", new Class<?>[0]);
        Object opt = def.getClass()
            .getMethod("maybeStack", int.class)
            .invoke(def, 1);
        Class<?> optionalClass = PartsProbeReflect.cls("com.google.common.base.Optional");
        if (!((Boolean) optionalClass.getMethod("isPresent")
            .invoke(opt)).booleanValue()) {
            throw new IllegalStateException("AE2 facade definition 无 stack");
        }
        ItemStack facadeItem = (ItemStack) optionalClass.getMethod("get")
            .invoke(opt);
        Object itemFacade = facadeItem.getItem();
        ItemStack stack = (ItemStack) itemFacade.getClass()
            .getMethod("createFacadeForItem", ItemStack.class, boolean.class)
            .invoke(itemFacade, new ItemStack(Blocks.stone), Boolean.FALSE);
        if (stack == null) {
            throw new IllegalStateException("createFacadeForItem(stone) 返回 null");
        }
        return stack;
    }

    private static TileEntity ae2CableBusCell(World world, int x, int y, int z) throws Exception {
        Block cableBusBlock = findBlockByClass("appeng.block.networking.BlockCableBus");
        world.setBlock(x, y, z, cableBusBlock, 0, 3);
        TileEntity te = world.getTileEntity(x, y, z);
        if (te == null || !te.getClass()
            .getName()
            .contains("TileCableBus")) {
            throw new IllegalStateException(
                "AE2 tile 未按预期生成: " + (te == null ? "null"
                    : te.getClass()
                        .getName()));
        }
        return te;
    }

    private void ae2AddPart(TileEntity te, ItemStack stack, ForgeDirection side) throws Exception {
        Object r = te.getClass()
            .getMethod("addPart", ItemStack.class, ForgeDirection.class, EntityPlayer.class)
            .invoke(te, stack, side, null);
        World world = te.getWorldObj();
        world.markBlockForUpdate(te.xCoord, te.yCoord, te.zCoord);
        JsonObject log = new JsonObject();
        log.addProperty("step", "ae2/addPart");
        log.add("stack", PartsProbeReflect.stackIdentity(stack));
        log.addProperty("side", side.name());
        log.addProperty("result", String.valueOf(r));
        buildLog.add(log);
    }

    private void ae2AddFacade(TileEntity te, ItemStack facadeStack, ForgeDirection side) throws Exception {
        Object itemFacade = facadeStack.getItem();
        Object facadePart = itemFacade.getClass()
            .getMethod("createPartFromItemStack", ItemStack.class, ForgeDirection.class)
            .invoke(itemFacade, facadeStack, side);
        if (facadePart == null) {
            throw new IllegalStateException("createPartFromItemStack 返回 null");
        }
        Object fc = te.getClass()
            .getMethod("getFacadeContainer")
            .invoke(te);
        Class<?> facadePartIface = PartsProbeReflect.cls("appeng.api.parts.IFacadePart");
        Object r = fc.getClass()
            .getMethod("addFacade", facadePartIface)
            .invoke(fc, facadePart);
        te.getWorldObj()
            .markBlockForUpdate(te.xCoord, te.yCoord, te.zCoord);
        JsonObject log = new JsonObject();
        log.addProperty("step", "ae2/addFacade");
        log.add("stack", PartsProbeReflect.stackIdentity(facadeStack));
        log.addProperty("side", side.name());
        log.addProperty("result", String.valueOf(r));
        buildLog.add(log);
    }

    // ------------------------------------------------------------------ EnderIO 放置半环（P0.2 通道）

    private static Object createConduit(Item item, EntityPlayer player) throws Exception {
        ItemStack stack = new ItemStack(item, 1, 0);
        Object conduit = item.getClass()
            .getMethod("createConduit", ItemStack.class, EntityPlayer.class)
            .invoke(item, stack, player);
        if (conduit == null) {
            throw new IllegalStateException("createConduit 返回 null: " + item.getUnlocalizedName());
        }
        return conduit;
    }

    // ------------------------------------------------------------------ FMP 放置半环（P0.2 通道）

    /** 三种材料的 id + 注册键串（mat 判别串 = idMap 元组 _1，P1.5 基准同款来源）。 */
    private static final class FmpMats {

        Class<?> mmrClass;
        Object mmr;
        Object faceClass;
        int stoneId;
        String stoneMat;
        int altId;
        String altMat;
        int thirdId;
        String thirdMat;
    }

    private FmpMats fmpMaterials() throws Exception {
        FmpMats m = new FmpMats();
        m.mmrClass = PartsProbeReflect.cls("codechicken.microblock.MicroMaterialRegistry$");
        m.mmr = m.mmrClass.getField("MODULE$")
            .get(null);
        Class<?> cmcClass = PartsProbeReflect.cls("codechicken.microblock.CommonMicroClass$");
        Object cmc = cmcClass.getField("MODULE$")
            .get(null);
        Object[] classes = (Object[]) cmcClass.getMethod("classes")
            .invoke(cmc);
        m.faceClass = classes[0]; // FaceMicroClass.register(0)
        if (m.faceClass == null) {
            throw new IllegalStateException("FMP face 微方块类未注册（CommonMicroClass.classes[0] == null）");
        }
        Object idMap = m.mmrClass.getMethod("getIdMap")
            .invoke(m.mmr);
        Object[] tuples = (Object[]) idMap;
        m.stoneId = ((Number) m.mmrClass.getMethod("materialID", String.class)
            .invoke(m.mmr, "stone")).intValue();
        m.stoneMat = String.valueOf(
            tuples[m.stoneId].getClass()
                .getMethod("_1")
                .invoke(tuples[m.stoneId]));
        m.altId = -1;
        m.thirdId = -1;
        for (int i = 0; i < tuples.length; i++) {
            if (i == m.stoneId || tuples[i] == null) {
                continue;
            }
            String key = String.valueOf(
                tuples[i].getClass()
                    .getMethod("_1")
                    .invoke(tuples[i]));
            if (m.thirdId < 0) {
                m.thirdId = i;
                m.thirdMat = key;
            }
            if (m.altId < 0 && key.toLowerCase()
                .contains("glass")) {
                m.altId = i;
                m.altMat = key;
            }
        }
        if (m.altId < 0) {
            m.altId = m.thirdId;
            m.altMat = m.thirdMat;
        }
        if (m.thirdId < 0 || m.thirdId == m.altId) {
            // 兜底：任取一个与 stone/alt 不同的
            for (int i = 0; i < tuples.length; i++) {
                if (i != m.stoneId && i != m.altId && tuples[i] != null) {
                    m.thirdId = i;
                    m.thirdMat = String.valueOf(
                        tuples[i].getClass()
                            .getMethod("_1")
                            .invoke(tuples[i]));
                    break;
                }
            }
        }
        return m;
    }

    private void fmpAddPart(World world, int x, int y, int z, FmpMats m, int size, int slot, int materialId)
        throws Exception {
        Class<?> tmpClass = PartsProbeReflect.cls("codechicken.multipart.TileMultipart$");
        Object tmp = tmpClass.getField("MODULE$")
            .get(null);
        Class<?> blockCoordClass = PartsProbeReflect.cls("codechicken.lib.vec.BlockCoord");
        Class<?> tMultiPartClass = PartsProbeReflect.cls("codechicken.multipart.TMultiPart");
        Constructor<?> posCtor = blockCoordClass.getConstructor(int.class, int.class, int.class);
        Method addPart = tmpClass.getMethod("addPart", World.class, blockCoordClass, tMultiPartClass);
        Method create = m.faceClass.getClass()
            .getMethod("create", boolean.class, int.class);
        Object part = create.invoke(m.faceClass, Boolean.FALSE, Integer.valueOf(materialId));
        part.getClass()
            .getMethod("setShape", int.class, int.class)
            .invoke(part, size, slot);
        Object pos = posCtor.newInstance(Integer.valueOf(x), Integer.valueOf(y), Integer.valueOf(z));
        addPart.invoke(tmp, world, pos, part);
        JsonObject log = new JsonObject();
        log.addProperty("step", "fmp/addPart");
        log.addProperty("pos", x + "," + y + "," + z);
        log.addProperty("size", Integer.valueOf(size));
        log.addProperty("slot", Integer.valueOf(slot));
        log.addProperty("materialId", Integer.valueOf(materialId));
        buildLog.add(log);
    }

    // ------------------------------------------------------------------ 小工具

    /** 按运行时类名在方块注册表里找方块（与 P0.2 同一判据，不依赖注册名拼写）。 */
    private static Block findBlockByClass(String className) {
        for (Object key : Block.blockRegistry.getKeys()) {
            Block b = (Block) Block.blockRegistry.getObject(key);
            if (b != null && b.getClass()
                .getName()
                .equals(className)) {
                return b;
            }
        }
        throw new IllegalStateException("注册表里找不到方块类: " + className);
    }
}
