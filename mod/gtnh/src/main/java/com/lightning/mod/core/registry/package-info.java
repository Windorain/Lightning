/**
 * BlockRegistry（Wiki）与结构扫描的<strong>服务端安全</strong>策略：{@link com.lightning.mod.core.registry.BlockRegistryWorldPolicy}
 * 定义 {@code matches} + {@code sample}；有序列表见
 * {@link com.lightning.mod.core.registry.BlockRegistryWorldPolicies}。
 * <p>
 * 客户端全量注册表写出另见 {@code com.lightning.mod.client.registry}（三方法含 {@code writeBlockRegistryEntry}）。
 * material_registry 仍由
 * {@link com.lightning.mod.client.export.ExportBundleClient#fillMaterialsFromBlockTextureAtlas}
 * 独立填充，与策略正交。
 */
package com.lightning.mod.core.registry;
