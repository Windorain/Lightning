export * from './types'
export * from './layout'
export * from './panels'
export { default as ReadonlyLayout } from './ReadonlyLayout.vue'
export { default as PropertyField } from './PropertyField.vue'
export { default as PropertyInspector } from './PropertyInspector.vue'
export { default as OperatorBtn } from './OperatorBtn.vue'
export { default as UIMenu } from './UIMenu.vue'

// ---------------------------------------------------------------------------
// 退役：`RNAWidget.vue` 与 `rna/` 已删除
// ---------------------------------------------------------------------------
//
// 删掉的入口：`RNAWidget`（三条写路径 —— `wikiconfig.` / `toolsettings.` 前缀分派 +
// `descriptor.set(owner, v)` 直接改内存）、`rna/registry.ts`、`rna/structs/*`、`rna/types.ts`。
// 替代：`PropertyInspector`（生成式属性面板）+ `PropertyField`（受控字段）+
// `@/editors/workbench-rna`（唯一写路由的接线）+ `@/editors/property-controls`（控件模型）。
// 不留兼容别名（退役纪律）。
