package com.lightning.mod.core.sampling.renderstate;

import net.minecraft.tileentity.TileEntity;

/**
 * 模组族「渲染状态承载」的声明式扩展点（方向 A）。
 *
 * <h2>它解决什么</h2>
 * 有些模组的方块外观由 <b>TE 里的渲染状态</b>决定，而这份状态<b>不进 NBT</b>——它只走模组自己的
 * 客户端同步包（典型：LogisticsPipes 的 {@code PipeRenderState}，连接矩阵与贴图矩阵只由
 * {@code PipeTileStatePacket} 下发）。逐格捕获走的是「按扫描 NBT 造副本 TE」的路（与
 * 活动 TE 全程零写入），副本因此拿不到这份状态，导出里就只剩下管体、没有连接臂与状态层。
 *
 * <p>
 * 本接口把「这份状态怎么采、怎么回填」声明成模组自己的事：扫描侧在<b>扫描时刻</b>用
 * {@link #write(TileEntity)} 把活动 TE 的渲染状态按<b>模组自有同步格式</b>序列化进样本；
 * 捕获侧对<b>副本 TE</b> 调 {@link #apply(TileEntity, byte[])} 原样读回。两条路径都不触碰
 * 活动 TE 的写面，也不改变「导出 = f(扫描快照)」的纯函数性（状态在扫描时刻入快照）。
 *
 * <h2>实现约束（硬）</h2>
 * <ul>
 * <li>{@link #write(TileEntity)} 只许调用<b>纯序列化</b>入口（如 {@code PipeRenderState.writeData}），
 * <b>不得</b>调用任何会置标志位、发包、重算连接或触碰世界的方法（{@code getLPDescriptionPacket} /
 * {@code sendUpdateToClient} / {@code scheduleNeighborChange} 等）；</li>
 * <li>{@link #apply(TileEntity, byte[])} 的 {@code te} 是<b>副本</b>，不得对活动世界 TE 调用；</li>
 * <li>格式串 {@link #format()} 是快照与实现之间的契约：读回时按它选提供者，对不上就不回填。</li>
 * </ul>
 */
public interface TileRenderStateProvider {

    /**
     * 状态格式标识（写进样本；读回时据此选提供者）。含实现族与格式版本，如
     * {@code logisticspipes.pipe-render-state/v1}。
     */
    String format();

    /** 该 TE 是否属于本提供者承载的模组族（{@code registryId} 是方块注册名，供按族判定时参考）。 */
    boolean matches(TileEntity te, String registryId);

    /**
     * 把活动 TE 的渲染状态按模组自有同步格式序列化；无状态/不可得时返回 {@code null}。
     *
     * <p>
     * <b>只读语义</b>：实现只许调用纯序列化入口，不得改字段、置标志、发包。
     */
    byte[] write(TileEntity te);

    /**
     * 把快照里的字节回填到<b>副本</b> TE 的渲染状态上（与模组客户端收到同步包时的摄取语义一致）。
     *
     * @return 是否回填成功；{@code false} 表示该格按「无渲染状态」渲染，绝不抛到捕获主流程外
     */
    boolean apply(TileEntity te, byte[] state);
}
