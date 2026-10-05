package com.lightning.mod.client.controlplane.mc;

import net.minecraft.tileentity.TileEntity;
import net.minecraft.world.WorldServer;

import com.google.gson.JsonObject;

/**
 * 方块实体（TE）状态补全器（contract.md §6.4，基准单 #55「设」第五项）。
 *
 * <p>
 * <b>边界（必须遵守）</b>：
 * <ul>
 * <li><b>仅限场景构建期</b>、捕获开始<b>之前</b>执行；不得在任何观察/捕获路径上补状态；</li>
 * <li>必须走<b>模组自身权威同步路径</b>（如 {@code markBlockForUpdate} 触发的 S35 description
 * packet 摄取，或模组自己的 {@code initialize}/{@code addPart} 等 API）；</li>
 * <li><b>禁止</b>逐字段从静态数据推算回填——补全器不得读用例参数去拼 TE 的 NBT，
 * 那会制造「看起来对、实际从未经过模组序列化路径」的假象。</li>
 * </ul>
 *
 * <p>
 * 补全器按族注册（{@link TeCompleters}），默认实现 {@link VanillaTeCompleter} 覆盖原版 TE；
 * {@code lp-pipe}/{@code ae2-part} 属 PR-3 交付，v1 注册表里没有它们——按契约「注册表查不到
 * completer」报 {@code CP-VALID-002}（由 {@link SceneBuilder} 落实）。
 */
public interface TeCompleter {

    /** 注册表里的族名（用例文件 {@code te.completer} 字段取值）。 */
    String name();

    /**
     * 对指定位置补全一次 TE 状态。
     *
     * @param world  服务端权威世界（{@code MinecraftServer.getServer().worldServers[0]}）
     * @param x      方块 X
     * @param y      方块 Y
     * @param z      方块 Z
     * @param params 用例声明的 {@code params}（可空对象；补全器<b>不得</b>用它回填字段）
     * @return true 表示本次已补全；false 表示本 tick 还补不了（上层记入 mismatches 并在清单可见）
     */
    boolean complete(WorldServer world, int x, int y, int z, JsonObject params);

    /**
     * 默认实现：原版 TE。
     *
     * <p>
     * 只做一件事：{@code world.markBlockForUpdate(x,y,z)}。1.7.10 的 {@code World#markBlockForUpdate}
     * 会遍历 {@code worldAccesses}（WorldServer 侧即 {@code WorldManager}）向追踪该区块的玩家发送
     * {@code S23PacketBlockChange}，该包在 {@code TileEntity#canUpdate()} 为真时携带 TE 的
     * {@code writeToNBT} 结果——即 #55「设」⑤ 要求的「模组自身权威同步路径」。
     * 因此补全后的状态是「世界 + 模组序列化」共同产生的，而不是探针拼出来的。
     */
    final class VanillaTeCompleter implements TeCompleter {

        /** 注册名。 */
        public static final String NAME = "vanilla";

        @Override
        public String name() {
            return NAME;
        }

        @Override
        public boolean complete(WorldServer world, int x, int y, int z, JsonObject params) {
            if (world == null) {
                return false;
            }
            TileEntity te = world.getTileEntity(x, y, z);
            if (te == null) {
                return false; // 该位置没有 TE：由调用方记入 mismatches
            }
            world.markBlockForUpdate(x, y, z);
            return true;
        }
    }
}
