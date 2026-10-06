package com.lightning.mod.client.controlplane.mc.read;

import net.minecraft.world.WorldServer;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.lightning.mod.client.controlplane.core.ActionContext;
import com.lightning.mod.client.controlplane.core.ControlAction;
import com.lightning.mod.client.controlplane.core.Json;
import com.lightning.mod.client.controlplane.core.TimeSource;

/**
 * {@code read.blocks}（observe，同步）：区域方块读回。
 *
 * <p>
 * 读指定闭区间区域内每一格的 {@code {pos, id, blockId, meta, te}}，并给出<b>规范化哈希</b>——
 * 哈希口径是「{@code blocks} 按 {@code (x,y,z)} 升序后的 {@code {pos,blockId,meta}} 数组」
 * （{@link ReadSupport#hashSubsetOf}），与 {@code world.rebuild} 场景清单哈希的 {@code blocks} 部分
 * 逐字一致，因此两者可互算（见 {@link ReadSupport#hashSubsetOf} 的说明）。
 *
 * <h2>为什么这是只读动作仍然是安全关键</h2>
 * 「Agent 必须能看」是需求书 §5 的地基，而读动作一旦有任何副作用，「世界哈希不变」这条
 * 验收判据（B1）就会失去意义。本类只走 {@code getBlock/getBlockMetadata/getTileEntity}。
 *
 * <h2>为什么读回值要与场景清单的哈希子集分开</h2>
 * 区域读回返回的是<b>人读 + 机读的完整读数</b>（含注册名、TE 类名）；参与哈希的是<b>其中的子集</b>。
 * 两件事分开，调用方才能「用同一个哈希口径判等，同时拿到人读得懂的读数」。
 */
public final class ReadBlocksAction implements ControlAction {

    /** 动作名（自描述与注册共用，防两处写错字符串）。 */
    public static final String NAME = "read.blocks";

    @Override
    public JsonObject execute(ActionContext ctx) {
        ReadSupport.Region region = ReadSupport.requireRegion(ctx, NAME);
        WorldServer world = ReadSupport.requireServerWorld(NAME);

        boolean includeAir = ctx.optBool("includeAir", true);
        boolean includeHash = ctx.optBool("hash", true);

        JsonArray all = ReadSupport.readRegion(world, region);
        JsonArray blocks = includeAir ? all : nonAirOnly(all);
        int air = countAir(all);

        JsonObject o = new JsonObject();
        o.addProperty("schema", "lightning.cp-read-blocks/1");
        o.addProperty("action", NAME);
        o.add("region", regionJson(region));
        o.addProperty("volume", region.volume);
        o.addProperty("blockCount", blocks.size());
        // airCount = 区域里到底有多少空气（与 includeAir 无关）；
        // airSkipped = 因 includeAir=false 而被过滤掉多少。两者含义不同，都给出。
        o.addProperty("airCount", air);
        o.addProperty("airSkipped", all.size() - blocks.size());
        o.addProperty("includeAir", includeAir);
        o.addProperty("ordering", "x 外层、z 中层、y 内层（同一区域两次读回逐元素相同）");
        o.add("blocks", blocks);
        if (includeHash) {
            // 哈希<b>恒</b>对「含空气的完整区域」计算：否则 includeAir=false 的两次调用会因为
            // 「到底算不算空气」而产生两个不同的哈希，调用方无从复算（哈希必须是区域的属性，
            // 不是请求选项的属性）。这一点写进 returns 说明与返回值。
            o.addProperty("sha256", ReadSupport.regionHash(all));
            o.addProperty(
                "hashScope",
                "区域全部方块（含空气，不受 includeAir 影响）："
                    + "{\"blocks\":[{\"pos\",\"blockId\",\"meta\"}…]} 按 (x,y,z) 升序后的 canonical JSON 之 sha256；"
                    + "与 world.rebuild 场景清单哈希的 blocks 部分同一口径");
            o.add("hashInput", hashInputJson(all));
        }
        o.addProperty(
            "readAt",
            TimeSource.system()
                .isoNow());
        return o;
    }

    /** 只保留非空气方块（{@code blockId != 0}）。 */
    private static JsonArray nonAirOnly(JsonArray all) {
        JsonArray out = new JsonArray();
        for (int i = 0; i < all.size(); i++) {
            JsonObject b = all.get(i)
                .getAsJsonObject();
            if (Json.optInt(b, "blockId", 0) != 0) {
                out.add(b);
            }
        }
        return out;
    }

    /** 空气方块数（{@code blockId == 0}）。 */
    private static int countAir(JsonArray all) {
        int n = 0;
        for (int i = 0; i < all.size(); i++) {
            JsonObject b = all.get(i)
                .getAsJsonObject();
            if (Json.optInt(b, "blockId", 0) == 0) {
                n++;
            }
        }
        return n;
    }

    /** 规范化哈希输入（便于调用方自行复算；与 sha256 同源，不另起口径）。 */
    private static JsonObject hashInputJson(JsonArray blocks) {
        JsonObject o = ReadSupport.hashSubsetOf(blocks);
        return o;
    }

    /** 区域描述对象。 */
    static JsonObject regionJson(ReadSupport.Region region) {
        JsonObject r = new JsonObject();
        r.add("from", ReadSupport.posArray(region.from));
        r.add("to", ReadSupport.posArray(region.to));
        r.addProperty("volume", region.volume);
        return r;
    }
}
