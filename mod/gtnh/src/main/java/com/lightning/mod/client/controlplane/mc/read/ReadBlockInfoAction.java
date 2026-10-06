package com.lightning.mod.client.controlplane.mc.read;

import net.minecraft.block.Block;
import net.minecraft.item.Item;
import net.minecraft.item.ItemStack;
import net.minecraft.tileentity.TileEntity;
import net.minecraft.world.WorldServer;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.lightning.mod.client.controlplane.core.ActionContext;
import com.lightning.mod.client.controlplane.core.ControlAction;
import com.lightning.mod.client.controlplane.core.CpException;
import com.lightning.mod.client.controlplane.core.Fields;
import com.lightning.mod.client.controlplane.core.Json;
import com.lightning.mod.client.controlplane.core.TimeSource;

/**
 * {@code read.block}（observe，同步）：方块与物品信息。
 *
 * <p>
 * 注册名、渲染类型、是否 TESR、所需工具——这些是「Agent 必须读源码或靠猜才能得知的状态」
 * 的典型（需求书 §5 的判据原文）。三选一的数据源：
 * <ul>
 * <li>{@code at:[x,y,z]}：读<b>世界里那个位置</b>的方块（含实读 meta 与方块实体信息）；</li>
 * <li>{@code block:"modid:name"}：只按注册名问注册表（不碰世界，可离线问）；</li>
 * <li>{@code item:"modid:name"}：只按注册名问物品注册表。</li>
 * </ul>
 *
 * <h2>「是否 TESR」怎么判</h2>
 * 走 {@code TileEntityRendererDispatcher.getSpecialRenderer(te)}——与渲染器实际用的是同一张表
 * （1.7.10 的 {@code mapSpecialRenderers} 逐类注册、按类层次回退）。
 * <b>不</b>靠「类名里有没有 Render 字样」这类推断：那正是需求书要禁的「靠猜」。
 *
 * <h2>「所需工具」怎么判</h2>
 * 走 {@code Block.getHarvestTool(meta)} / {@code getHarvestLevel(meta)}——GTNH 的
 * {@code isToolEffective} 会读它，原版挖掘速度判定也读它。两条一起给：
 * 矿镐等级与「该工具是否对这一格有效」是两个不同的问题（e.g. 木镐对黑曜石 level 不足）。
 *
 * <h2>为什么渲染类型给 id 也给名字</h2>
 * {@code getRenderType()} 返回 int：0=普通立方体、1=十字草、2=火把、3=流体、…
 * 名字表在 1.7.10 里是 {@code RenderBlocks} 的 switch 内联的，没有公开常量数组，
 * 因此本动作给<b>本实现口径的名字</b>并注明它是本口径（不是 MC 的公开 API）。
 */
public final class ReadBlockInfoAction implements ControlAction {

    /** 动作名。 */
    public static final String NAME = "read.block";

    @Override
    public JsonObject execute(ActionContext ctx) {
        boolean hasAt = ctx.has("at");
        boolean hasBlock = ctx.has("block");
        boolean hasItem = ctx.has("item");
        int given = (hasAt ? 1 : 0) + (hasBlock ? 1 : 0) + (hasItem ? 1 : 0);
        if (given == 0) {
            throw new CpException(
                com.lightning.mod.client.controlplane.core.ErrorCodes.VALID_PARAM,
                "缺少查询目标：at / block / item 三选一",
                Json.object("hint", "at:[x,y,z] 读世界里的方块；block:\"modid:name\" 按注册名问方块表；item:\"modid:name\" 按注册名问物品表"));
        }
        if (given > 1) {
            throw CpException.param("查询目标冲突", "at|block|item", "三者只能给一个，收到 " + given + " 个");
        }

        JsonObject o = new JsonObject();
        o.addProperty("schema", "lightning.cp-read-block/1");
        o.addProperty("action", NAME);
        o.addProperty("queryKind", hasAt ? "at" : hasBlock ? "block" : "item");

        if (hasAt) {
            o.add("block", fromWorld(ctx));
        } else if (hasBlock) {
            o.add("block", fromRegistry(ctx.requireString("block")));
        } else {
            o.add("item", itemInfo(ctx.requireString("item"), ctx.optInt("meta", 0)));
        }

        o.addProperty(
            "readAt",
            TimeSource.system()
                .isoNow());
        return o;
    }

    // ------------------------------------------------------------ 三种来源

    /** 从世界的一个位置读方块。 */
    private static JsonObject fromWorld(ActionContext ctx) {
        WorldServer world = ReadSupport.requireServerWorld(NAME);
        int[] pos = ReadInventoryAction.parseAt(ctx, "at");
        Fields fields = new Fields();
        ReadSupport.checkBounds(pos, "at", fields);
        fields.throwIfAny("坐标非法");

        Block block = world.getBlock(pos[0], pos[1], pos[2]);
        int meta = world.getBlockMetadata(pos[0], pos[1], pos[2]);
        JsonObject o = blockInfo(block, meta, world, pos);
        o.add("at", ReadSupport.posArray(pos));
        return o;
    }

    /** 从注册名问方块表（不碰世界）。 */
    private static JsonObject fromRegistry(String id) {
        Block block = ReadSupport.parseBlock(id);
        if (block == null) {
            JsonArray known = sampleRegistry();
            throw new CpException(
                com.lightning.mod.client.controlplane.core.ErrorCodes.VALID_PARAM,
                "未知方块注册名",
                Json.object(
                    "action",
                    NAME,
                    "block",
                    id,
                    "hint",
                    "须为 modid:name（裸名按 minecraft: 处理）；注册名可在场景清单 world/scene-manifest.json 的 blocks[].id 里看到",
                    "registrySample",
                    known));
        }
        return blockInfo(block, 0, null, null);
    }

    /** 物品信息（按注册名）。 */
    private static JsonObject itemInfo(String id, int meta) {
        Item item = ReadSupport.parseItem(id);
        if (item == null) {
            throw new CpException(
                com.lightning.mod.client.controlplane.core.ErrorCodes.VALID_PARAM,
                "未知物品注册名",
                Json.object("action", NAME, "item", id, "hint", "须为 modid:name（裸名按 minecraft: 处理）"));
        }
        JsonObject o = new JsonObject();
        o.addProperty("id", ReadSupport.itemId(item));
        o.addProperty("queriedId", id);
        o.addProperty("meta", Integer.valueOf(meta));
        o.addProperty(
            "class",
            item.getClass()
                .getName());
        o.addProperty("unlocalizedName", safe(() -> item.getUnlocalizedName()));
        o.addProperty("maxStackSize", Integer.valueOf(item.getItemStackLimit()));
        o.addProperty("maxDamage", Integer.valueOf(item.getMaxDamage()));
        o.addProperty("damageable", Boolean.valueOf(item.isDamageable()));
        o.addProperty("repairable", Boolean.valueOf(item.isRepairable()));
        o.addProperty("hasSubtypes", Boolean.valueOf(safeBool(() -> item.getHasSubtypes())));
        // 附魔判定的权威口是 ItemStack.isItemEnchanted()（Item 上没有对应方法）
        o.addProperty("enchanted", Boolean.valueOf(safeBool(() -> new ItemStack(item, 1, meta).isItemEnchanted())));
        JsonArray tools = new JsonArray();
        for (String t : safeToolClasses(item, meta)) {
            Json.add(tools, t);
        }
        o.add("toolClasses", tools);
        o.addProperty("displayName", safeDisplay(id, item, meta));
        o.add("asBlockPlaced", placedAs(item, meta));
        return o;
    }

    // ------------------------------------------------------------ 方块信息

    /**
     * 一个方块的全部可读信息。
     *
     * @param world 世界（{@code at} 来源时有；注册表来源时为 null，则跳过需要世界的字段）
     * @param pos   位置（同上）
     */
    static JsonObject blockInfo(Block block, int meta, WorldServer world, int[] pos) {
        JsonObject o = new JsonObject();
        if (block == null) {
            // 空气：这是合法读数（世界里那片就是空的），不是错误
            o.addProperty("id", (String) null);
            o.addProperty("blockId", 0);
            o.addProperty("meta", Integer.valueOf(meta));
            o.addProperty("air", true);
            return o;
        }
        o.addProperty("id", ReadSupport.blockId(block));
        o.addProperty("blockId", Integer.valueOf(Block.getIdFromBlock(block)));
        o.addProperty("meta", Integer.valueOf(meta));
        o.addProperty("air", false);
        o.addProperty(
            "class",
            block.getClass()
                .getName());
        o.addProperty("unlocalizedName", safe(() -> block.getUnlocalizedName()));
        o.addProperty("localizedName", safe(() -> block.getLocalizedName()));

        // ---- 渲染类型：是否 TESR / 是否 ISBRH（需求书 §5 明列的两项）
        JsonObject render = new JsonObject();
        int renderType = safeInt(() -> block.getRenderType());
        render.addProperty("renderType", Integer.valueOf(renderType));
        render.addProperty("renderTypeName", renderTypeName(renderType));
        render.addProperty("renderTypeNameScope", "本实现口径（1.7.10 的 renderType 名字表内联在 RenderBlocks，无公开常量）");
        render.addProperty("isNormalCube", Boolean.valueOf(safeBool(block::renderAsNormalBlock)));
        render.addProperty("isOpaqueCube", Boolean.valueOf(safeBool(block::isOpaqueCube)));
        render.addProperty("renderBlockPass", Integer.valueOf(safeInt(() -> block.getRenderBlockPass())));
        render.addProperty("lightValue", Integer.valueOf(safeInt(() -> block.getLightValue())));
        render.addProperty("hasTileEntity", Boolean.valueOf(safeBool(() -> block.hasTileEntity(meta))));
        render.addProperty("tickRandomly", Boolean.valueOf(safeBool(block::getTickRandomly)));

        // 是否 ISBRH：1.7.10 的 ISBRH 是「方块自己有 renderType 且不是 0」这一类，
        // 权威判定只能问渲染器；此处按「renderType != 0 且不是 TESR」给出可见结论并注明口径。
        JsonObject teInfo = tileEntityInfo(world, pos);
        render.add("tileEntity", teInfo);
        boolean tesr = Json.optBool(teInfo, "hasSpecialRenderer", false);
        render.addProperty("isTesr", Boolean.valueOf(tesr));
        render.addProperty("isIsbrh", Boolean.valueOf(!tesr && renderType != 0));
        render.addProperty(
            "isIsbrhScope",
            "本实现口径：renderType != 0 且无 TESR。1.7.10 的 ISBRH 注册在 RenderBlocks 的 renderBlockByRenderType 分派里，只能这样可见地近似");
        o.add("render", render);

        // ---- 所需工具（GTNH 的挖掘判定读它）
        JsonObject harvest = new JsonObject();
        harvest.addProperty("tool", safe(() -> block.getHarvestTool(meta)));
        harvest.addProperty("level", Integer.valueOf(safeInt(() -> block.getHarvestLevel(meta))));
        harvest
            .addProperty("scope", "按 meta 求值（同一方块不同 meta 可以是不同工具）；tool 为 null 表示不需要特定工具，此时看 material.toolNotRequired");
        o.add("harvest", harvest);

        // ---- 材质与属性（blockMaterial 是 protected：走公开的 getMaterial()）
        JsonObject material = new JsonObject();
        net.minecraft.block.material.Material mat = safeMaterial(block);
        if (mat != null) {
            material.addProperty("name", String.valueOf(mat));
            material.addProperty("liquid", Boolean.valueOf(mat.isLiquid()));
            material.addProperty("solid", Boolean.valueOf(mat.isSolid()));
            material.addProperty("opaque", Boolean.valueOf(mat.isOpaque()));
            material.addProperty("blocksGrass", Boolean.valueOf(mat.getCanBlockGrass()));
            material.addProperty("toolNotRequired", Boolean.valueOf(mat.isToolNotRequired()));
        } else {
            material.addProperty("available", false);
        }
        o.add("material", material);
        o.addProperty("hardness", Float.valueOf(safeFloat(() -> block.getBlockHardness(world, 0, 0, 0))));
        o.addProperty("hardnessScope", "无世界上下文（按注册名查询）时按 (0,0,0) 求值；getBlockHardness 的实现通常不看坐标，故这是可复算读数");
        o.addProperty(
            "resistance",
            Float.valueOf(safeFloat(() -> block.getExplosionResistance((net.minecraft.entity.Entity) null))));
        o.addProperty("slipperiness", Float.valueOf(block.slipperiness));
        o.addProperty("lightOpacity", Integer.valueOf(safeInt(() -> block.getLightOpacity())));
        o.addProperty("stepSound", block.stepSound == null ? null : block.stepSound.soundName);

        // ---- 掉落物（非权威：真正的掉落走 getDrops；这里给的是 getItem 给出的「放置物身份」）
        JsonObject drop = new JsonObject();
        int dropId = safeInt(() -> Item.getIdFromItem(block.getItemDropped(meta, new java.util.Random(0L), 0)));
        drop.addProperty("itemDroppedId", Integer.valueOf(dropId));
        Item dropped = safeItemById(dropId);
        drop.addProperty("itemDropped", ReadSupport.itemId(dropped));
        drop.addProperty(
            "quantityDropped",
            Integer.valueOf(safeInt(() -> block.quantityDropped(new java.util.Random(0L)))));
        drop.addProperty("scope", "用固定种子 Random(0) 求值（getItemDropped/quantityDropped 的签名要求 Random）；这是可复算的读数，不是真实掉落表");
        o.add("drops", drop);
        return o;
    }

    /** 方块实体信息（含是否 TESR——走渲染器自己的表，不推断）。 */
    private static JsonObject tileEntityInfo(WorldServer world, int[] pos) {
        JsonObject o = new JsonObject();
        if (world == null || pos == null) {
            o.addProperty("available", false);
            o.addProperty("note", "无世界上下文（按注册名查询）：是否 TESR 需要世界里有一个实例才能判");
            return o;
        }
        TileEntity te = world.getTileEntity(pos[0], pos[1], pos[2]);
        o.addProperty("available", true);
        o.addProperty("present", Boolean.valueOf(te != null));
        if (te == null) {
            o.addProperty("hasSpecialRenderer", false);
            return o;
        }
        o.addProperty(
            "class",
            te.getClass()
                .getName());
        try {
            net.minecraft.client.renderer.tileentity.TileEntityRendererDispatcher d = net.minecraft.client.renderer.tileentity.TileEntityRendererDispatcher.instance;
            Object renderer = d == null ? null : d.getSpecialRenderer(te);
            o.addProperty("hasSpecialRenderer", renderer != null);
            o.addProperty(
                "rendererClass",
                renderer == null ? null
                    : renderer.getClass()
                        .getName());
            o.addProperty("rendererSource", "TileEntityRendererDispatcher.mapSpecialRenderers（渲染器实际用的同一张表）");
        } catch (Throwable t) {
            o.addProperty("hasSpecialRenderer", (Boolean) null);
            o.addProperty("error", String.valueOf(t));
        }
        return o;
    }

    // ------------------------------------------------------------ 工具

    /** renderType → 人读名（本实现口径，见类注释）。 */
    static String renderTypeName(int id) {
        switch (id) {
            case 0:
                return "normalCube";
            case 1:
                return "crossedSquares";
            case 2:
                return "torch";
            case 3:
                return "fire";
            case 4:
                return "liquid";
            case 5:
                return "redstoneWire";
            case 6:
                return "crops";
            case 7:
                return "door";
            case 8:
                return "ladder";
            case 9:
                return "rail";
            case 10:
                return "stairs";
            case 11:
                return "fence";
            case 12:
                return "lever";
            case 13:
                return "cactus";
            case 14:
                return "bed";
            case 15:
                return "repeater";
            case 16:
                return "pistonBase";
            case 17:
                return "pistonExtension";
            case 18:
                return "pane";
            case 19:
                return "stem";
            case 20:
                return "vine";
            case 21:
                return "fenceGate";
            case 22:
                return "cauldron";
            case 23:
                return "portal";
            case 24:
                return "beacon";
            case 25:
                return "wall";
            case 26:
                return "dragonEgg";
            case 27:
                return "cocoa";
            case 28:
                return "tripWire";
            case 29:
                return "flowerPot";
            case 30:
                return "skull";
            case 31:
                return "anvil";
            case 32:
                return "chest";
            case 33:
                return "brewingStand";
            case 34:
                return "endPortalFrame";
            case 35:
                return "hopper";
            case 36:
                return "isbrh(36)";
            case 37:
                return "isbrh(37)";
            case 38:
                return "isbrh(38)";
            case 39:
                return "isbrh(39)";
            case 40:
                return "isbrh(40)";
            case 41:
                return "isbrh(41)";
            default:
                return id < 0 ? "none(-1)" : "isbrh(" + id + ")";
        }
    }

    /** 物品放置成方块时的信息（原版 {@code ItemBlock} 口径）；不是方块的物品返回 null。 */
    private static JsonObject placedAs(Item item, int meta) {
        try {
            if (!(item instanceof net.minecraft.item.ItemBlock)) {
                return null;
            }
            Block block = ((net.minecraft.item.ItemBlock) item).field_150939_a;
            if (block == null) {
                return null;
            }
            JsonObject o = blockInfo(block, meta, null, null);
            o.addProperty("scope", "由 ItemBlock 关联的方块；getBlockHardness 等需要世界的字段在无世界时为 0/null");
            return o;
        } catch (Throwable t) {
            return null;
        }
    }

    /** 注册表里前若干方块名（错误上下文用，帮调用方发现拼写错误）。 */
    private static JsonArray sampleRegistry() {
        JsonArray out = new JsonArray();
        try {
            for (Object o : net.minecraft.block.Block.blockRegistry) {
                if (out.size() >= 12) {
                    break;
                }
                String name = ReadSupport.blockId((Block) o);
                if (name != null) {
                    Json.add(out, name);
                }
            }
        } catch (Throwable t) {
            // 列举失败就返回空样本（错误信息本身不因此失真）
        }
        return out;
    }

    private static Item safeItemById(int id) {
        try {
            return Item.getItemById(id);
        } catch (Throwable t) {
            return null;
        }
    }

    /** 方块材质（{@code blockMaterial} 是 protected，走公开的 {@code getMaterial()}）。 */
    private static net.minecraft.block.material.Material safeMaterial(Block block) {
        try {
            return block.getMaterial();
        } catch (Throwable t) {
            return null;
        }
    }

    private static String safeDisplay(String id, Item item, int meta) {
        try {
            return new ItemStack(item, 1, meta).getDisplayName();
        } catch (Throwable t) {
            return null;
        }
    }

    private static java.util.Set<String> safeToolClasses(Item item, int meta) {
        try {
            java.util.Set<String> s = item.getToolClasses(new ItemStack(item, 1, meta));
            return s == null ? java.util.Collections.<String>emptySet() : s;
        } catch (Throwable t) {
            return java.util.Collections.<String>emptySet();
        }
    }

    // 小包装：读数异常一律退回 null/默认值（单字段读不出不该炸整次读面）
    private interface Str {

        String get();
    }

    private interface Num {

        int get();
    }

    private interface Flt {

        float get();
    }

    private interface Bln {

        boolean get();
    }

    private static String safe(Str s) {
        try {
            return s.get();
        } catch (Throwable t) {
            return null;
        }
    }

    private static int safeInt(Num n) {
        try {
            return n.get();
        } catch (Throwable t) {
            return 0;
        }
    }

    private static float safeFloat(Flt f) {
        try {
            return f.get();
        } catch (Throwable t) {
            return 0.0F;
        }
    }

    private static boolean safeBool(Bln b) {
        try {
            return b.get();
        } catch (Throwable t) {
            return false;
        }
    }
}
