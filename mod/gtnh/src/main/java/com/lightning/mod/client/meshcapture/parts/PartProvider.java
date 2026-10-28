package com.lightning.mod.client.meshcapture.parts;

import java.util.List;

import cpw.mods.fml.relauncher.Side;
import cpw.mods.fml.relauncher.SideOnly;

/**
 * 部件提供者（契约 {@code format-parts-contract.md} §7 的既定设计：PartProvider 接口 + Registry，
 * postrender 式合并语义）。
 *
 * <p>
 * 与既有三套 {@code *Strategy} 同形状：{@link #priority()} 升序参与检测，{@link #applies} 命中后由
 * {@link PartProviderRegistry#dispatch} 调用 {@link #collectParts}。不同处（契约 §7/§7 要求）：
 * <ul>
 * <li>同档内<strong>所有</strong> {@code applies} 为 true 的提供者<strong>全部执行、结果合并</strong>
 * （多族同格，localId 命名空间隔离，§4）；</li>
 * <li>每个提供者声明自己的档位 {@link #tier()}（1=族权威 2=通用盒 3=几何推断），三档兜底由
 * {@link PartCapturePipeline} 编排：档 1 有产出即不再执行档 2/3；</li>
 * <li>任何提供者抛异常/反射失败 ⇒ 注册表捕获、记日志、静默跳过，导出绝不中断（§7）。</li>
 * </ul>
 *
 * <p>
 * 实现者负责在自己产出的每条 {@link PartRecord} 上标记正确的来源四元组（§3 source）：
 * 族权威 = {@code fallback:false, tier:1}；generic/inferred = {@code fallback:true}。
 */
@SideOnly(Side.CLIENT)
public interface PartProvider {

    /** 数值越小越先参与同档检测（与既有 {@code *Strategy#priority()} 同一约定）。 */
    int priority();

    /**
     * 兜底档位：{@link PartSource#TIER_FAMILY}（1，族权威）/ {@link PartSource#TIER_GENERIC}（2，通用盒）/
     * {@link PartSource#TIER_INFERRED}（3，几何推断，永不当主来源）。
     */
    int tier();

    /** 族前缀（§4 localId 命名空间）：ae2 | eio | fmp | generic | inferred。 */
    String family();

    boolean applies(PartProviderContext ctx);

    /**
     * 枚举格内部件并产出部件列表；无产出（含退化情形，§7）返回空列表（不返回 null 更稳，但注册表对
     * null 也容错）。不允许抛出——抛出的后果是被注册表记录并静默跳过本提供者。
     */
    List<PartRecord> collectParts(PartProviderContext ctx);
}
