/**
 * e2e 侧的日志级别常量（`logging/LogCenter#LOG_LEVEL` 的镜像）。
 *
 * 为什么不在 e2e 里 import 生产模块：`e2e/` 不在 tsconfig include 内、也不经
 * 生产打包，值导入会把整条模块图拉进 Playwright 的 babel 转译。级别是**稳定契约**
 * （位掩码），镜像一个数比拉一条依赖边更小 —— 且`presenterFailureBound` 的单测
 * 已把"两处常量逐字相同"作为判据（口径漂移会被单测抓到）。
 */
export const LOG_LEVEL_ERROR = 16
