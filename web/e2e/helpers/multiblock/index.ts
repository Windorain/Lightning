/**
 * T2.6 无头渲染断言管线 —— helper 出口。
 *
 * 第一阶段（骨架）导出的能力，第二阶段（通道滑杆遍历）直接复用：
 *  - `gotoWorkbench` / `waitForRenderedGrid`  → 入口挂载与装配等待
 *  - `injectSceneDocument`                    → IO 接管（生产拖放同一 operator）
 *  - `readDocObservation`                     → 通道清单 / 取值域 / 运行态 / 变体声明
 *  - `readRenderedGrid`                       → 当前装配网格（T3.3 逐格 diff 的 web 侧输入）
 *  - `setSliderValue` / `pressSliderKey`      → DOM 事件注入（滑杆遍历用同一函数）
 *  - `assertScreenshotNotBlank`               → 截图证据链 + 非空基础断言
 *  - `readChannelPanel` / `setTier` / `setChannelValue` / `setRunstate`
 *                                             → **第二阶段接口预留**（选择器由 T2.4 声明，见 channels.ts）
 */

export * from './harness'
export * from './pixels'
export * from './contract'
export * from './frameDoc'
export * from './channels'
export * from './panelContract'
export * from './referenceGrids'
export * from './realExports'
