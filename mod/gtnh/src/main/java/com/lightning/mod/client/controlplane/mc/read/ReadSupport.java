package com.lightning.mod.client.controlplane.mc.read;

import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

import net.minecraft.block.Block;
import net.minecraft.item.Item;
import net.minecraft.item.ItemStack;
import net.minecraft.nbt.NBTBase;
import net.minecraft.nbt.NBTTagCompound;
import net.minecraft.nbt.NBTTagList;
import net.minecraft.tileentity.TileEntity;
import net.minecraft.world.WorldServer;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.lightning.mod.client.controlplane.core.CpException;
import com.lightning.mod.client.controlplane.core.Fields;
import com.lightning.mod.client.controlplane.core.Json;
import com.lightning.mod.client.controlplane.mc.ModReflect;

/**
 * 读面（观察面，{@code client/controlplane/mc/read/}）共用的读取原语。
 *
 * <h2>为什么独立成类</h2>
 * 七个读面动作读的是同一批东西（区域方块网格、物品栈、NBT 摘要、服务端权威世界句柄），
 * 复制七份会让「同一个量在两处读法不同」这种最难的缺陷有藏身之处。因此：
 * <ul>
 * <li>{@code id}（注册名）只有 {@link #blockId}/{@link #itemId} 两个定义点；</li>
 * <li>NBT 摘要只有 {@link #nbtSummary} 一个定义点；</li>
 * <li>「世界不可用」只有 {@link #requireServerWorld}/{@link #requireClientWorld} 两个定义点。</li>
 * </ul>
 *
 * <h2>只读纪律（issue #98 验收 B1）</h2>
 * 本类的全部方法<b>只调用读接口</b>（{@code getBlock/getBlockMetadata/getTileEntity/读取字段}）。
 * 「只读」不是靠约定，而是靠本类<b>没有</b>任何写接口可达：不出现 {@code setBlock}/{@code markBlockForUpdate}/
 * {@code initialize}/{@code addPart} 等写方法的调用点。B1 的实测口径是「调用前后世界清单哈希不变」。
 *
 * <h2>gson 2.2.4 纪律</h2>
 * 运行期 FML 实载 gson 2.2.4，因此本类一律经 {@link Json} 的包装：不调 {@code JsonParser.parseString}、
 * 不调 {@code JsonObject.keySet()/size()}，数组元素一律 {@code Json.add(arr, ...)}。
 */
public final class ReadSupport {

    /** 单个区域请求的方块数上限（{@code 48×48×48} = 110592，序列化后约数 MB）。 */
    public static final int MAX_REGION_BLOCKS = 48 * 48 * 48;

    /** 1.7.10 世界高度范围（与 {@code CaseValidator} 同口径）。 */
    public static final int MIN_Y = 0;

    /** 见 {@link #MIN_Y}。 */
    public static final int MAX_Y = 255;

    /** 水平坐标绝对值上限（与原版世界边界一致）。 */
    public static final int MAX_HORIZONTAL = 30000000;

    /** 1.7.10 方块 meta 取值上限。 */
    public static final int MAX_META = 15;

    /** 方位顺序（读面输出的 {@code facing} 口径；与 MC 的 yaw 归一化一致）。 */
    public static final String[] FACINGS = { "south", "west", "north", "east" };

    private ReadSupport() {}

    // ------------------------------------------------------------ 世界句柄

    /**
     * 服务端权威世界（只读动作的唯一世界来源）。
     *
     * <p>
     * 与场景构建同口径：{@code MinecraftServer.getServer().worldServers[0]} 才是权威侧。
     * 客户端 {@code WorldClient} 的 {@code saveHandler} 是占位实现（目录名恒 {@code "none"}），
     * 用它读回会把托管世界描述错。取不到即 {@code CP-STATE-001}，带上下文说明该怎么补救——
     * 「没有世界」是本类唯一允许的失败形态，绝不静默返回空结果（那会变成空转绿）。
     *
     * @param action 调用动作名（写进错误上下文，便于定位是哪个读面报告的世界缺失）
     */
    public static WorldServer requireServerWorld(String action) {
        WorldServer world = com.lightning.mod.client.controlplane.mc.WorldRuntime.serverWorld();
        if (world == null) {
            throw worldUnavailable(action);
        }
        return world;
    }

    /** 世界不可用（{@code CP-STATE-001}）：上下文给足，调用方不必翻日志就知道差什么。 */
    public static CpException worldUnavailable(String action) {
        return new CpException(
            com.lightning.mod.client.controlplane.core.ErrorCodes.STATE,
            "服务端权威世界不可用（未进入世界或集成服未起）",
            Json.object(
                "action",
                action,
                "hint",
                "先进世界：world.rebuild {folder:\"cp_…\",seed:<整数>,void:true,confirm:true}，或 case.run 的 world 段",
                "worldLoaded",
                Boolean.valueOf(isClientWorldLoaded())));
    }

    private static boolean isClientWorldLoaded() {
        try {
            net.minecraft.client.Minecraft mc = com.lightning.mod.client.controlplane.mc.WorldRuntime.mc();
            return mc != null && mc.theWorld != null;
        } catch (Throwable t) {
            return false;
        }
    }

    // ------------------------------------------------------------ 坐标与区域

    /** 一个半开区间区域 {@code [from, to]}（闭区间，逐轴 from ≤ to）。 */
    public static final class Region {

        /** 区域。 */
        public final int[] from;
        /** 区域。 */
        public final int[] to;
        /** 方块总数。 */
        public final long volume;

        Region(int[] from, int[] to, long volume) {
            this.from = from;
            this.to = to;
            this.volume = volume;
        }
    }

    /**
     * 解析区域参数（二选一形态，见各动作自描述的 {@code region}/{@code from}/{@code to}）。
     *
     * <p>
     * 支持两种写法：{@code region:{"from":[x,y,z],"to":[x,y,z]}} 或平铺的 {@code from}/{@code to}。
     * 两种都给且不一致时报 {@code CP-VALID-002}（不猜调用方想用哪个）。
     *
     * @param ctx    动作参数
     * @param action 动作名（错误上下文）
     * @return 规范化区域
     * @throws CpException CP-VALID-002：坐标非法、from &gt; to、体积超限
     */
    public static Region requireRegion(com.lightning.mod.client.controlplane.core.ActionContext ctx, String action) {
        JsonObject region = ctx.optObject("region");
        int[] from = ctx.has("from") ? coords(ctx.param("from"), "from") : null;
        int[] to = ctx.has("to") ? coords(ctx.param("to"), "to") : null;
        if (region != null) {
            int[] rf = coords(Json.get(region, "from"), "region.from");
            int[] rt = coords(Json.get(region, "to"), "region.to");
            if (rf == null || rt == null) {
                throw CpException.param("region 形态非法", "region", "须为 {from:[x,y,z], to:[x,y,z]}（三个整数）");
            }
            if (from != null && !same(from, rf) || to != null && !same(to, rt)) {
                throw CpException.param("区域参数冲突", "region", "region 与平铺的 from/to 同时给出且不一致，请只写一种");
            }
            from = rf;
            to = rt;
        }
        Fields fields = new Fields();
        if (from == null) {
            fields.add("from", "必填（[x,y,z] 三个整数），或用 region:{from,to}");
        }
        if (to == null) {
            fields.add("to", "必填（[x,y,z] 三个整数），或用 region:{from,to}");
        }
        if (!fields.isEmpty()) {
            throw new CpException(
                com.lightning.mod.client.controlplane.core.ErrorCodes.VALID_PARAM,
                "区域参数缺失或非法（" + fields.size() + " 处）" + fields.summary(),
                fields.toContext());
        }
        for (int i = 0; i < 3; i++) {
            if (from[i] > to[i]) {
                fields.add(
                    "region",
                    "第 " + "xyz".charAt(i) + " 轴 from " + from[i] + " > to " + to[i] + "（须逐轴 from ≤ to）");
            }
        }
        checkBounds(from, "from", fields);
        checkBounds(to, "to", fields);
        if (!fields.isEmpty()) {
            throw new CpException(
                com.lightning.mod.client.controlplane.core.ErrorCodes.VALID_PARAM,
                "区域参数非法（" + fields.size() + " 处）" + fields.summary(),
                fields.toContext());
        }
        long volume = 1L;
        for (int i = 0; i < 3; i++) {
            volume *= (long) to[i] - (long) from[i] + 1L;
        }
        if (volume > MAX_REGION_BLOCKS) {
            throw CpException
                .param("区域过大", "region", "体积 " + volume + " 方块 > 上限 " + MAX_REGION_BLOCKS + "（约 48³）；请分块读或缩小范围");
        }
        return new Region(from, to, volume);
    }

    /** 解析一个坐标三元组。 */
    public static int[] coords(JsonElement e, String field) {
        if (e == null || !e.isJsonArray()
            || e.getAsJsonArray()
                .size() != 3) {
            throw CpException.param("坐标非法", field, "须为 [x,y,z] 三个整数");
        }
        JsonArray a = e.getAsJsonArray();
        int[] out = new int[3];
        for (int i = 0; i < 3; i++) {
            JsonElement v = a.get(i);
            if (v == null || !v.isJsonPrimitive()
                || !v.getAsJsonPrimitive()
                    .isNumber()) {
                throw CpException.param("坐标分量非法", field + "[" + i + "]", "须为整数");
            }
            String s = v.getAsString();
            if (s.indexOf('.') >= 0 || s.indexOf('e') >= 0 || s.indexOf('E') >= 0) {
                throw CpException.param("坐标分量非法", field + "[" + i + "]", "须为整数，收到 " + s);
            }
            out[i] = v.getAsInt();
        }
        return out;
    }

    /** 坐标边界校验（世界高度与水平边界）。 */
    public static void checkBounds(int[] v, String field, Fields fields) {
        if (v[1] < MIN_Y || v[1] > MAX_Y) {
            fields.add(field, "y 须在 " + MIN_Y + ".." + MAX_Y + "，收到 " + v[1]);
        }
        for (int k = 0; k < 3; k += 2) {
            if (v[k] < -MAX_HORIZONTAL || v[k] > MAX_HORIZONTAL) {
                fields.add(field, "水平坐标超出世界边界: " + v[k]);
                break;
            }
        }
    }

    private static boolean same(int[] a, int[] b) {
        return a[0] == b[0] && a[1] == b[1] && a[2] == b[2];
    }

    /** {@code [x,y,z]} 整数数组。 */
    public static JsonArray posArray(int... pos) {
        JsonArray a = new JsonArray();
        for (int v : pos) {
            Json.add(a, Integer.valueOf(v));
        }
        return a;
    }

    // ------------------------------------------------------------ 方块与物品身份

    /** 方块注册名（{@code modid:name}）；取不到返回 null。 */
    public static String blockId(Block block) {
        if (block == null) {
            return null;
        }
        try {
            Object name = Block.blockRegistry.getNameForObject(block);
            String s = name == null ? null : String.valueOf(name);
            return s == null || s.isEmpty() || "null".equals(s) ? null : s;
        } catch (Throwable t) {
            return null;
        }
    }

    /** 物品注册名（{@code modid:name}）；取不到返回 null。 */
    public static String itemId(Item item) {
        return ModReflect.itemId(item);
    }

    /** 物品栈的注册名（meta 非 0 时补 {@code @meta}），与 {@code ModReflect} 同口径。 */
    public static String stackId(ItemStack stack) {
        return ModReflect.itemId(stack);
    }

    /** 从注册名解析方块；{@code modid:name} 或裸名（按 {@code minecraft:} 处理）；找不到返回 null。 */
    public static Block parseBlock(String id) {
        if (id == null) {
            return null;
        }
        String s = id.trim();
        if (s.isEmpty()) {
            return null;
        }
        try {
            if (s.indexOf(':') < 0) {
                s = "minecraft:" + s;
            }
            return Block.getBlockFromName(s);
        } catch (Throwable t) {
            return null;
        }
    }

    /** 从注册名解析物品；{@code modid:name} 或裸名；找不到返回 null。 */
    public static Item parseItem(String id) {
        if (id == null) {
            return null;
        }
        String s = id.trim();
        if (s.isEmpty()) {
            return null;
        }
        try {
            if (s.indexOf(':') < 0) {
                s = "minecraft:" + s;
            }
            // Item.itemRegistry 是 FML 的 RegistryNamespaced：getObject(name) 是它的公开查法
            Object o = Item.itemRegistry.getObject(s);
            return o instanceof Item ? (Item) o : null;
        } catch (Throwable t) {
            return null;
        }
    }

    /**
     * 一个位置的方块读数（读面输出的最小单元，与 {@code world.rebuild} 场景清单同一批字段）。
     *
     * <p>
     * 返回对象含 {@code pos}/{@code blockId}/{@code meta}/{@code id}，外加 {@code te}（该位置方块实体
     * 的类名，没有时为 null）。<b>参与哈希的子集不含 {@code te} 与 {@code id}</b>——
     * 见 {@link #hashSubsetOf}。
     */
    public static JsonObject readBlock(WorldServer world, int x, int y, int z) {
        Block b = world.getBlock(x, y, z);
        int id = b == null ? 0 : Block.getIdFromBlock(b);
        int meta = b == null ? 0 : world.getBlockMetadata(x, y, z);
        JsonObject o = new JsonObject();
        o.add("pos", posArray(x, y, z));
        o.addProperty("blockId", id);
        o.addProperty("meta", meta);
        o.addProperty("id", blockId(b));
        TileEntity te = world.getTileEntity(x, y, z);
        o.addProperty(
            "te",
            te == null ? null
                : te.getClass()
                    .getName());
        return o;
    }

    /**
     * 逐格读一个区域（{@code (x,z,y)} 字典序，即「先列后行再层」）。
     *
     * <p>
     * 顺序固定是<b>可复算</b>的前提：同一区域两次读出的 {@code blocks} 数组逐元素相同，
     * {@link #regionHash} 才有意义。
     */
    public static JsonArray readRegion(WorldServer world, Region region) {
        JsonArray out = new JsonArray();
        // 维度顺序 (x, z, y)：与体素数据「逐层平面」的惯用序一致，也让同一 y 层的读数连续落盘
        for (int x = region.from[0]; x <= region.to[0]; x++) {
            for (int z = region.from[2]; z <= region.to[2]; z++) {
                for (int y = region.from[1]; y <= region.to[1]; y++) {
                    out.add(readBlock(world, x, y, z));
                }
            }
        }
        return out;
    }

    /**
     * 区域方块网格的规范化哈希子集：{@code {blocks:[{pos,blockId,meta}…]}}，按 {@code (x,y,z)} 升序。
     *
     * <h2>与场景清单哈希互算</h2>
     * {@code world.rebuild} 的场景清单哈希口径（{@code docs/control-plane/case-file.md} §8.7）覆盖
     * {@code {blocks:[{pos,blockId,meta}], tileEntities:[{pos,class}]}}，其中 {@code blocks} 按
     * {@code (x,y,z)} 升序。<b>区域读回刻意不含 {@code tileEntities}</b>：
     * 含了它，「同一区域在两次重建之间读回同不同」就混进了「该不该在这一格有 TE」这个额外变量；
     * 而该变量由 {@code te.read} 与场景清单各自独立回答。
     *
     * <p>
     * 因此两者的关系是<b>可互算</b>而不是恒等：
     * 读回整片区域并把结果排序后作为 {@code blocks}、附上同一批位置的 {@code tileEntities}，
     * 即得场景清单的哈希子集；这是验收 B1 的对照口径，写在
     * {@code temp/cp-read/evidence/} 的证据文件里。
     */
    public static JsonObject hashSubsetOf(JsonArray blocks) {
        List<JsonObject> list = new ArrayList<JsonObject>();
        if (blocks != null) {
            for (int i = 0; i < blocks.size(); i++) {
                JsonElement e = blocks.get(i);
                if (e == null || !e.isJsonObject()) {
                    continue;
                }
                JsonObject b = e.getAsJsonObject();
                JsonObject n = new JsonObject();
                n.add("pos", Json.copy(Json.get(b, "pos")));
                n.addProperty("blockId", Json.optInt(b, "blockId", 0));
                n.addProperty("meta", Json.optInt(b, "meta", 0));
                list.add(n);
            }
        }
        sortByPos(list);
        JsonArray arr = new JsonArray();
        for (JsonObject o : list) {
            arr.add(o);
        }
        JsonObject out = new JsonObject();
        out.add("blocks", arr);
        return out;
    }

    /** 区域哈希：{@code sha256(canonical(hashSubsetOf(blocks)))}（同一口径只有一个定义点）。 */
    public static String regionHash(JsonArray blocks) {
        return com.lightning.mod.client.controlplane.core.Hashing.sha256HexUtf8(Json.canonical(hashSubsetOf(blocks)));
    }

    /** 规范化哈希文本（便于调用方自行复算与审计）。 */
    public static String canonicalHashInput(JsonArray blocks) {
        return Json.canonical(hashSubsetOf(blocks));
    }

    private static void sortByPos(List<JsonObject> list) {
        list.sort((a, b) -> {
            int[] pa = posOf(a);
            int[] pb = posOf(b);
            for (int i = 0; i < 3; i++) {
                int c = Integer.compare(pa[i], pb[i]);
                if (c != 0) {
                    return c;
                }
            }
            return 0;
        });
    }

    /** 取 {@code pos} 三元组；缺失返回全 0。 */
    public static int[] posOf(JsonObject o) {
        JsonArray a = Json.optArray(o, "pos");
        int[] out = new int[3];
        if (a == null || a.size() != 3) {
            return out;
        }
        for (int i = 0; i < 3; i++) {
            JsonElement v = a.get(i);
            if (v != null && v.isJsonPrimitive()) {
                try {
                    out[i] = v.getAsInt();
                } catch (RuntimeException ignored) {
                    out[i] = 0;
                }
            }
        }
        return out;
    }

    // ------------------------------------------------------------ 物品栈与 NBT

    /**
     * 一个物品槽位的读数：{@code {slot, empty, id, meta, count, maxStackSize, damage, maxDamage,
     * displayName, nbt}}。
     *
     * <p>
     * 空槽返回 {@code {slot, empty:true}}（<b>不给</b> {@code id:null}——空槽与「已解析但身份未知」
     * 要分得开；后者是 {@code empty:false} + {@code id:null}）。
     */
    public static JsonObject readSlot(String slotName, int slot, ItemStack stack) {
        JsonObject o = new JsonObject();
        if (slotName != null) {
            o.addProperty(slotName, Integer.valueOf(slot));
        } else {
            o.addProperty("slot", Integer.valueOf(slot));
        }
        if (stack == null) {
            o.addProperty("empty", true);
            return o;
        }
        o.addProperty("empty", false);
        o.addProperty("id", stackId(stack));
        o.addProperty("meta", stack.getItemDamage());
        o.addProperty("count", stack.stackSize);
        o.addProperty("maxStackSize", stack.getMaxStackSize());
        o.addProperty(
            "damage",
            stack.isItemStackDamageable() ? Integer.valueOf(stack.getItemDamage()) : (Integer) null);
        o.addProperty(
            "maxDamage",
            stack.isItemStackDamageable() ? Integer.valueOf(stack.getMaxDamage()) : (Integer) null);
        o.addProperty("displayName", safeDisplayName(stack));
        o.add("nbt", nbtSummary(stack.getTagCompound()));
        return o;
    }

    private static String safeDisplayName(ItemStack stack) {
        try {
            return stack.getDisplayName();
        } catch (Throwable t) {
            return null;
        }
    }

    /**
     * NBT 摘要（深度受限、长度受限的结构化形态，<b>不是</b>原文）。
     *
     * <h2>为什么要摘要而不是原文</h2>
     * 1.7.10 的 mod 会把整棵世界状态塞进物品 NBT（AE2 的格子内容、GT 的机器数据），
     * 原样输出会把一次读面变成几十 MB 的响应，且把「这个 NBT 有多大」这件事藏起来。
     * 摘要给出：{@code type}（NBT 类型 id 与人读名）、{@code size}（复合/列表的成员数）、
     * {@code truncated}（是否因深度/条数上限被截断）、{@code sha256}（<b>完整</b> NBT 的
     * {@code toString()} 哈希——摘要被截断也仍然可判等）。
     *
     * <p>
     * 哈希取 {@code toString()} 的 UTF-8 字节：1.7.10 的 {@code NBTTagCompound.toString()} 是
     * 稳定的花括号写法，同内容同序即同串（成员序由底层 {@code HashMap} 决定，因此
     * <b>同一次会话内</b>可判等；这是摘要，不是跨会话的规范化哈希口径，已在返回值里写明）。
     */
    public static JsonObject nbtSummary(NBTTagCompound tag) {
        if (tag == null) {
            return null;
        }
        JsonObject o = new JsonObject();
        o.addProperty("type", Integer.valueOf(tag.getId()));
        o.addProperty("typeName", nbtTypeName(tag.getId()));
        o.addProperty("size", Integer.valueOf(nbtKeys(tag).size()));
        o.addProperty("sha256", com.lightning.mod.client.controlplane.core.Hashing.sha256HexUtf8(nbtRaw(tag)));
        o.addProperty("hashScope", "value.toString() 的 utf-8 字节（会话内可判等；成员序不跨会话保证）");
        JsonObject value = nbtValue(tag, 0, NBT_MAX_ENTRIES);
        o.add("value", value);
        o.addProperty("truncated", Json.optBool(value, "truncated", false));
        return o;
    }

    /** NBT 原文（{@code toString()}）；异常时返回空串（不吞掉哈希字段，宁可为空串也不给假哈希）。 */
    private static String nbtRaw(NBTBase tag) {
        try {
            return String.valueOf(tag);
        } catch (Throwable t) {
            return "";
        }
    }

    /** NBT 摘要的深度上限。 */
    public static final int NBT_MAX_DEPTH = 3;

    /** 每个复合/列表在摘要里的成员数上限。 */
    public static final int NBT_MAX_ENTRIES = 24;

    /**
     * NBT 摘要的结构化部分（深度与条数都受限）。
     *
     * <p>
     * 原语节点给 {@code value}；复合给 {@code members}；列表给 {@code items}。
     * 超过 {@code maxEntries} 或 {@code NBT_MAX_DEPTH} 时置 {@code truncated:true}——
     * <b>截断是显式的</b>，调用方永远知道手里的摘要是全的还是缺的。
     */
    private static JsonObject nbtValue(NBTBase tag, int depth, int maxEntries) {
        JsonObject o = new JsonObject();
        if (tag == null) {
            o.addProperty("type", 0);
            o.addProperty("typeName", nbtTypeName(0));
            return o;
        }
        int type = safeTypeId(tag);
        o.addProperty("type", Integer.valueOf(type));
        o.addProperty("typeName", nbtTypeName(type));
        if (tag instanceof NBTTagCompound) {
            List<String> keys = nbtKeys((NBTTagCompound) tag);
            o.addProperty("size", Integer.valueOf(keys.size()));
            if (depth >= NBT_MAX_DEPTH) {
                if (keys.size() > 0) {
                    o.addProperty("truncated", true);
                }
                return o;
            }
            JsonObject members = new JsonObject();
            int n = 0;
            for (String k : keys) {
                if (n++ >= maxEntries) {
                    o.addProperty("truncated", true);
                    break;
                }
                NBTBase child = null;
                try {
                    child = ((NBTTagCompound) tag).getTag(k);
                } catch (Throwable ignored) {
                    // 单成员读取失败不升级成整次读面失败；该键以 null 类型出现（可见而非静默消失）
                }
                members.add(k, nbtValue(child, depth + 1, maxEntries));
            }
            o.add("members", members);
            return o;
        }
        if (tag instanceof NBTTagList) {
            NBTTagList l = (NBTTagList) tag;
            int count = safeListCount(l);
            o.addProperty("size", Integer.valueOf(count));
            o.addProperty("elementType", Integer.valueOf(safeListElementType(l)));
            o.addProperty("elementTypeName", nbtTypeName(safeListElementType(l)));
            if (depth >= NBT_MAX_DEPTH) {
                if (count > 0) {
                    o.addProperty("truncated", true);
                }
                return o;
            }
            JsonArray items = new JsonArray();
            int n = 0;
            for (int i = 0; i < count; i++) {
                if (n++ >= maxEntries) {
                    o.addProperty("truncated", true);
                    break;
                }
                // 1.7.10 的 NBTTagList 只有 getCompoundTagAt（非复合元素会得到空复合），
                // 因此非复合元素退化为「类型 + 文本」的一条读数，不假装是复合。
                int et = safeListElementType(l);
                if (et == 10) {
                    NBTTagCompound c = null;
                    try {
                        c = l.getCompoundTagAt(i);
                    } catch (Throwable ignored) {
                        // 留空复合
                    }
                    items.add(nbtValue(c, depth + 1, maxEntries));
                } else {
                    JsonObject item = new JsonObject();
                    item.addProperty("type", Integer.valueOf(et));
                    item.addProperty("typeName", nbtTypeName(et));
                    String text = null;
                    try {
                        if (et == 8) {
                            text = l.getStringTagAt(i);
                        }
                    } catch (Throwable ignored) {
                        // 非字符串元素没有直接的取值口；见下方 note
                    }
                    if (text != null) {
                        item.addProperty("value", text);
                    } else {
                        item.addProperty("note", "非复合/非字符串的列表元素在 1.7.10 没有公开的按下标取值口；" + "该元素的内容只体现在列表根的 sha256 里");
                    }
                    items.add(item);
                }
            }
            o.add("items", items);
            return o;
        }
        // 原语：值本身可读，且短
        String s = nbtRaw(tag);
        o.addProperty("value", s.length() > 200 ? s.substring(0, 200) : s);
        if (s.length() > 200) {
            o.addProperty("truncated", true);
        }
        return o;
    }

    /** NBT 类型 id（取不到返回 0）。 */
    private static int safeTypeId(NBTBase tag) {
        try {
            return tag.getId();
        } catch (Throwable t) {
            return 0;
        }
    }

    /** 列表元素数（取不到返回 0）。 */
    private static int safeListCount(NBTTagList list) {
        try {
            return list.tagCount();
        } catch (Throwable t) {
            return 0;
        }
    }

    /** 列表元素的 NBT 类型 id（{@code func_150303_d}；取不到返回 0）。 */
    private static int safeListElementType(NBTTagList list) {
        try {
            Object t = ModReflect.call(list, "func_150303_d");
            return t instanceof Number ? ((Number) t).intValue() : 0;
        } catch (Throwable ignored) {
            return 0;
        }
    }

    /** 复合标签的键（按键名字典序，保证摘要可复算）。 */
    public static List<String> nbtKeys(NBTTagCompound tag) {
        List<String> out = new ArrayList<String>();
        if (tag == null) {
            return out;
        }
        try {
            // func_150296_c 是 1.7.10 的「取键集合」（NBTTagCompound.java:62）；键是 String 类型
            Object keys = tag.func_150296_c();
            if (keys instanceof Iterable) {
                for (Object k : (Iterable<?>) keys) {
                    if (k != null) {
                        out.add(String.valueOf(k));
                    }
                }
            }
        } catch (Throwable t) {
            return out;
        }
        Collections.sort(out);
        return out;
    }

    /** NBT 类型 id → 人读名（1.7.10 的取值表）。 */
    public static String nbtTypeName(int id) {
        switch (id) {
            case 0:
                return "end";
            case 1:
                return "byte";
            case 2:
                return "short";
            case 3:
                return "int";
            case 4:
                return "long";
            case 5:
                return "float";
            case 6:
                return "double";
            case 7:
                return "byteArray";
            case 8:
                return "string";
            case 9:
                return "list";
            case 10:
                return "compound";
            case 11:
                return "intArray";
            default:
                return "unknown(" + id + ")";
        }
    }

    // ------------------------------------------------------------ 方位与枚举名

    /** yaw（度）→ 主方位；与 MC 的 {@code MathHelper.floor_double(yaw*4/360+0.5) & 3} 同口径。 */
    public static String facingOf(float yaw) {
        int idx = net.minecraft.util.MathHelper.floor_double(yaw * 4.0F / 360.0F + 0.5D) & 3;
        return FACINGS[idx];
    }

    /** 枚举常量的 {@code name()}；为 null 返回 null。 */
    public static String enumName(Object o) {
        return o instanceof Enum ? ((Enum<?>) o).name() : null;
    }

    /** 取模组注册的族名列表（读面自描述里用它回答「有哪些族可用」）。 */
    public static JsonArray familyNames(List<String> names) {
        JsonArray a = new JsonArray();
        for (String s : names) {
            Json.add(a, s);
        }
        return a;
    }

    /** 只读视图：族名 → 缺席原因。 */
    public static Map<String, String> absences() {
        try {
            return new LinkedHashMap<String, String>(com.lightning.mod.client.controlplane.mc.ModTeFamilies.absences());
        } catch (Throwable t) {
            return new LinkedHashMap<String, String>();
        }
    }

    /** 小写化（Locale 固定，防土耳其语 i 类事故）。 */
    public static String lower(String s) {
        return s == null ? null : s.toLowerCase(Locale.ROOT);
    }
}
