package com.lightning.mod.client.controlplane.mc;

import net.minecraft.world.WorldServer;

import com.google.gson.JsonObject;

/**
 * 方块实体（TE）运行期状态<b>描述器</b>（contract.md §6.5 的补全器对偶，case-file.md §5 的运行期轨）。
 *
 * <h2>与 {@link TeCompleter} 的分工</h2>
 * <ul>
 * <li>{@link TeCompleter}：场景构建期<b>写</b>——经模组自身放置/同步 API 让 TE 变成该有的样子；</li>
 * <li>{@code TeDescriber}：任意时刻<b>只读</b>——把 TE 的权威运行期状态导出成 JSON，供
 * {@code te-state-equals} 判据比较、并进观测记录 {@code runtimeReads}（{@code te.*} 条目）。</li>
 * </ul>
 *
 * <p>
 * 两者<b>按族同名注册</b>（{@link TeCompleters} / {@link TeDescribers} 的 {@code name()} 相同，
 * 如 {@code lp-pipe} / {@code ae2-part}），这样「补全器放出来的状态」与「描述器读出来的状态」
 * 天然是同一个族的两个视角。
 *
 * <h2>实现纪律（必须遵守）</h2>
 * <ol>
 * <li><b>只读</b>：不得调用任何写世界/写 TE 的方法（{@code markBlockForUpdate}/{@code setBlock}/
 * {@code initialize}/{@code addPart} 等一律禁止）。描述器跑在判据段与观测采集路径上，
 * 一次写入就会污染被判据断言的世界；</li>
 * <li><b>不猜 NBT</b>：只读模组自己的运行期 API（字段/方法），不读 {@code NBT} 反推、不做
 * 「从方块 meta 推状态」这类推算——理由同 §6.4：推算出来的值与渲染器实际用的值可以不一致；</li>
 * <li><b>缺席用显式 {@code null}</b>：某面没有部件/某字段不适用时写 JSON {@code null} 而非省略键，
 * 否则 {@code expect: null} 这类断言会与「键名写错」混淆（求值侧把「键不存在」判红）；</li>
 * <li><b>认领与不认领</b>：只描述本族的 TE；位置上的 TE 不是本族时返回 {@code null}
 * （{@link TeDescribers#describe} 据此继续问下一个描述器）。</li>
 * </ol>
 */
public interface TeDescriber {

    /** 注册表里的族名（与同族 {@link TeCompleter#name()} 一致）。 */
    String name();

    /**
     * 读取指定位置的 TE 运行期状态（<b>只读</b>）。
     *
     * @param world 服务端权威世界（{@code MinecraftServer.getServer().worldServers[0]}）
     * @param x     方块 X
     * @param y     方块 Y
     * @param z     方块 Z
     * @return 状态对象；该位置不是本族 TE（或世界不可用）时返回 {@code null}
     */
    JsonObject describe(WorldServer world, int x, int y, int z);
}
