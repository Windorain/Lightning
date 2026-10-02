/**
 * 差异规则的**可读性说明**（fixture 文档级 `opsLegend`）。
 *
 * 这些句子原本写在每个 op 的 `note` 字段里。但 op 是**每个变体一份**的重复结构，
 * 把长句放进去会让 fixture 体积被说明文字主导（实测翻倍），也掩盖"格式自身的开销"。
 * 因此：`note` 是格式允许的**可选**字段（真实导出应留空），fixture 把说明集中到
 * 文档级 `opsLegend`，一处解释、全文引用。
 */

export const OPS_LEGEND = {
  'coil.baseline': 'coil 通道未设置（Not set）时的默认槽位：相位 backbone 的基线写入，会被后面的替换型规则覆盖。',
  'coil.replace': 'coil 通道已设置：相位 replace 写入该通道当前取值对应的方块。0 时不生效，保留 Not set 基线。',
  'glass.baseline': 'glass 通道未设置（Not set）时的默认棒：一条沿 y 的区间（fill）规则覆盖整根。',
  'glass.replace': 'glass 通道已设置：同一条区间规则改写整根玻璃棒（"旧下标 → 新下标"的批量替换表达）。',
  'glass.intersect': 'glass 与 capacitor 作用于同一片顶盖中央区（作用域相交例外）：位置集合相交，后写者胜。',
  'runstate.face': '运行态层：只替换控制器正面的材质/纹理，cellGrid 形状不变（本轮只承诺纹理/材质层差异）。',
  'size.topcap': '尺寸型通道变化时顶盖位置随动：同一组规则在每一阶骨架上按新的 h 生效。',
  'cap.baseline': 'capacitor 未设置（Not set）时的基线：一条区间规则铺满相交区域的两格。',
  'cap.replace': 'capacitor 已设置：写入该通道取值对应的方块。',
  'cap.clamped': '耦合夹取后的电容档：反映 clamp 型耦合的实际结果（同一区域第 3 次写入，后写者胜）。',
  'totalTier.top': '总 Tier 的显式落点：显式设置时改写柱顶，未设置（0）时不生效、柱顶保持不设置基线的方块。',
}
