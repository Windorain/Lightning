package com.lightning.mod.client.controlplane.mc.read;

import net.minecraft.tileentity.TileEntity;
import net.minecraft.world.WorldServer;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.lightning.mod.client.controlplane.core.ActionContext;
import com.lightning.mod.client.controlplane.core.ControlAction;
import com.lightning.mod.client.controlplane.core.CpException;
import com.lightning.mod.client.controlplane.core.CriteriaEngine;
import com.lightning.mod.client.controlplane.core.ErrorCodes;
import com.lightning.mod.client.controlplane.core.Fields;
import com.lightning.mod.client.controlplane.core.Json;
import com.lightning.mod.client.controlplane.core.ObservationRecord;
import com.lightning.mod.client.controlplane.core.TimeSource;
import com.lightning.mod.client.controlplane.mc.ModTeFamilies;
import com.lightning.mod.client.controlplane.mc.SceneManifest;
import com.lightning.mod.client.controlplane.mc.TeDescribers;

/**
 * {@code read.te}（observe，同步）：方块实体（TE）状态读回。
 *
 * <h2>读哪一份状态</h2>
 * 两轨并给，缺一不可：
 * <ol>
 * <li><b>权威族状态</b>（{@code families[]}）：经 {@link TeDescribers} 的族描述器读——与
 * {@code te-state-equals} 判据、观测记录 {@code runtimeReads} <b>同一个读取口</b>。
 * 因此「判据断言的值」与「本动作返回的值」不可能不一致（分叉是这类设施最贵的一类缺陷）。</li>
 * <li><b>通用 TE 事实</b>（{@code tile}）：类名、NBT 摘要、是否已在位——与族注册表无关，
 * 因此<b>任何</b> TE（含没有描述器的原版/模组 TE）都有读数。没有这一份，
 * 「整合包里没有 LP/AE2 就不能读 TE」会变成隐性的能力缺口。</li>
 * </ol>
 *
 * <h2>为什么把 {@code families} 的缺席写成显式 null 而不是省略</h2>
 * 「该位置没有描述器认领」与「该族缺席（模组没装）」是两件事：前者是场景问题，
 * 后者是环境问题。响应里两者分别落在 {@code families[]}（逐族，未认领者 {@code state:null}）
 * 与 {@code absentFamilies}（族名 → 缺席原因，来自 {@link ModTeFamilies#absences()}）。
 */
public final class ReadTeAction implements ControlAction {

    /** 动作名。 */
    public static final String NAME = "read.te";

    /** 单次读面最多读的位置数（防一次调用变成全图扫描）。 */
    public static final int MAX_POSITIONS = 4096;

    @Override
    public JsonObject execute(ActionContext ctx) {
        WorldServer world = ReadSupport.requireServerWorld(NAME);
        int[][] positions = positionsOf(ctx);
        boolean includeNbt = ctx.optBool("includeNbt", true);

        JsonObject o = new JsonObject();
        o.addProperty("schema", "lightning.cp-read-te/1");
        o.addProperty("action", NAME);
        o.addProperty("count", Integer.valueOf(positions.length));
        o.add("familiesRegistered", ReadSupport.familyNames(TeDescribers.names()));

        JsonObject absent = new JsonObject();
        for (java.util.Map.Entry<String, String> e : ReadSupport.absences()
            .entrySet()) {
            absent.addProperty(e.getKey(), e.getValue());
        }
        o.add("absentFamilies", absent);

        JsonArray tiles = new JsonArray();
        for (int[] pos : positions) {
            tiles.add(readOne(world, pos, includeNbt));
        }
        o.add("tiles", tiles);

        // 逐位置的可断言读数索引：把用户用例里最常用的「族描述器输出」也摊平一层，
        // 判据可用 json-field 直接指到 /tiles/0/families/0/state/connections/UP，
        // 不必先知道哪个族认领了它。
        o.addProperty("pointerHint", "族状态在 /tiles/<i>/families/<j>/state（RFC 6901 指针，与 te-state-equals 的 key 同一棵树）");
        o.addProperty(
            "readAt",
            TimeSource.system()
                .isoNow());
        return o;
    }

    // ------------------------------------------------------------ 单个位置

    /** 读一个位置：通用事实 + 逐族描述器输出。 */
    private static JsonObject readOne(WorldServer world, int[] pos, boolean includeNbt) {
        JsonObject o = new JsonObject();
        o.add("pos", ReadSupport.posArray(pos));

        TileEntity te = world.getTileEntity(pos[0], pos[1], pos[2]);
        JsonObject tile = new JsonObject();
        tile.addProperty("present", te != null);
        tile.addProperty("blockId", ReadSupport.blockId(world.getBlock(pos[0], pos[1], pos[2])));
        tile.addProperty("meta", Integer.valueOf(world.getBlockMetadata(pos[0], pos[1], pos[2])));
        if (te != null) {
            tile.addProperty(
                "class",
                te.getClass()
                    .getName());
            tile.addProperty("superclass", superclassOf(te));
            tile.addProperty("blockMetadata", Integer.valueOf(te.getBlockMetadata()));
            if (includeNbt) {
                tile.add("nbt", nbtOf(te));
            }
        }
        o.add("tile", tile);

        // 逐族描述器：注册表里的每个族都问一遍，未认领者写 state:null（见类注释）
        JsonArray families = new JsonArray();
        for (String family : TeDescribers.names()) {
            JsonObject f = new JsonObject();
            f.addProperty("family", family);
            JsonObject state = null;
            if (te != null) {
                state = TeDescribers.describeByFamily(family, world, pos[0], pos[1], pos[2]);
            }
            if (state == null) {
                f.addProperty("state", (String) null);
                f.addProperty(
                    "note",
                    te == null ? "该位置没有方块实体"
                        : "族 " + family
                            + " 的描述器未认领该位置的 TE（类 "
                            + te.getClass()
                                .getName()
                            + "）");
            } else {
                f.add("state", state);
                f.addProperty("sha256", ObservationRecord.hashSummary(state));
            }
            families.add(f);
        }
        // 探测式描述（第一个认领者胜出，与 te-state-equals 判据同一入口）
        CriteriaEngine.RuntimeTeSource.TeState claimed = te == null ? null
            : TeDescribers.describe(world, pos[0], pos[1], pos[2]);
        if (claimed != null) {
            o.addProperty("claimedFamily", claimed.family);
            o.add("claimedState", claimed.state);
        } else {
            o.addProperty("claimedFamily", (String) null);
            o.addProperty("claimedState", (String) null);
        }
        o.add("families", families);
        return o;
    }

    private static String superclassOf(TileEntity te) {
        Class<?> c = te.getClass()
            .getSuperclass();
        return c == null ? null : c.getName();
    }

    /**
     * TE 的 NBT 摘要。
     *
     * <p>
     * <b>纪律</b>：这里读 NBT 是为了「如实留痕」（摘要 + 哈希），<b>不是</b>为了让判据去断言它——
     * 判据该断言的是族描述器的运行期状态（{@code TeDescriber} 的实现纪律明写「不猜 NBT」）。
     * 因此本字段在使用上与 {@code families[].state} 分开看待。
     */
    private static JsonObject nbtOf(TileEntity te) {
        try {
            net.minecraft.nbt.NBTTagCompound tag = new net.minecraft.nbt.NBTTagCompound();
            te.writeToNBT(tag);
            return ReadSupport.nbtSummary(tag);
        } catch (Throwable t) {
            JsonObject err = new JsonObject();
            err.addProperty("error", String.valueOf(t));
            return err;
        }
    }

    // ------------------------------------------------------------ 参数

    /**
     * 解析位置列表：{@code at:[x,y,z]} 或 {@code at:[[x,y,z],…]} 或 {@code from/to} 区域。
     *
     * <p>
     * 三种写法覆盖三种用法：单点核对、按清单核对（场景清单的位置集合直接喂进来）、区域普查。
     */
    static int[][] positionsOf(ActionContext ctx) {
        com.google.gson.JsonElement at = ctx.param("at");
        if (at != null) {
            if (at.isJsonArray() && at.getAsJsonArray()
                .size() > 0
                && at.getAsJsonArray()
                    .get(0)
                    .isJsonArray()) {
                JsonArray arr = at.getAsJsonArray();
                int[][] out = new int[arr.size()][];
                Fields fields = new Fields();
                for (int i = 0; i < arr.size(); i++) {
                    out[i] = ReadSupport.coords(arr.get(i), "at[" + i + "]");
                    ReadSupport.checkBounds(out[i], "at[" + i + "]", fields);
                }
                fields.throwIfAny("位置清单非法");
                if (out.length > MAX_POSITIONS) {
                    throw CpException.param("位置过多", "at", out.length + " 个位置 > 上限 " + MAX_POSITIONS);
                }
                return out;
            }
            int[] one = ReadSupport.coords(at, "at");
            Fields fields = new Fields();
            ReadSupport.checkBounds(one, "at", fields);
            fields.throwIfAny("坐标非法");
            return new int[][] { one };
        }
        if (ctx.has("from") || ctx.has("to") || ctx.has("region")) {
            ReadSupport.Region region = ReadSupport.requireRegion(ctx, NAME);
            if (region.volume > MAX_POSITIONS) {
                throw CpException
                    .param("区域过大", "region", "体积 " + region.volume + " > 上限 " + MAX_POSITIONS + "（逐个读 TE 的代价远高于读方块）");
            }
            java.util.List<int[]> list = new java.util.ArrayList<int[]>();
            for (int x = region.from[0]; x <= region.to[0]; x++) {
                for (int z = region.from[2]; z <= region.to[2]; z++) {
                    for (int y = region.from[1]; y <= region.to[1]; y++) {
                        list.add(new int[] { x, y, z });
                    }
                }
            }
            return list.toArray(new int[0][]);
        }
        throw new CpException(
            ErrorCodes.VALID_PARAM,
            "缺少位置参数：at 或 from/to 二选一",
            Json.object(
                "fields",
                Json.array(),
                "hint",
                "at:[x,y,z] 单点；at:[[x,y,z],…] 位置清单；from/to 区域普查（体积 ≤ " + MAX_POSITIONS + "）"));
    }

    /** 场景清单的位置集合（供调用方把 {@code world.rebuild} 的清单直接喂给本动作）。 */
    public static JsonArray positionsFromManifest(JsonObject manifest) {
        JsonArray out = new JsonArray();
        JsonArray blocks = manifest == null ? null : Json.optArray(manifest, "blocks");
        for (int i = 0; blocks != null && i < blocks.size(); i++) {
            int[] pos = SceneManifest.posOf(blocks.get(i));
            out.add(ReadSupport.posArray(pos));
        }
        return out;
    }
}
