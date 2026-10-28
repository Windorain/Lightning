/**
 * BlockRegistry 客户端 dump
 * 策略：{@link com.lightning.mod.client.registry.BlockRegistryPolicy}（matches、sample、writeBlockRegistryEntry），
 * 有序注册 {@link com.lightning.mod.client.registry.BlockRegistryPolicies}。未命中策略时
 * {@link com.lightning.mod.core.registry.BlockRegistryJson#writeUnknownEntry}。
 * <p>
 * 对 {@code gregtech:gt.blockmachines}，全量 dump 的
 * {@link com.lightning.mod.client.registry.BlockRegistryPolicy#matches} 中 {@code meta} 为
 * MetaTile ID（mID）；世界扫描使用 {@link com.lightning.mod.core.registry.BlockRegistryWorldPolicy} 与
 * {@link com.lightning.mod.core.sampling.PolicyBackedBlockSampler}，{@code matches}
 * 仅白名单、{@code VoxelSample#meta} 对机器块为 mID（见
 * {@link com.lightning.mod.core.registry.GregTechMetaTileRegistry}）。
 */
package com.lightning.mod.client.registry;
