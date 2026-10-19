/**
 * 资源失败**重试入口**（M8-5 / D6；SPEC §7.4:252）。
 *
 * ## 形态（二选一：手动入口 —— 本包选它，理由写在这里）
 *
 * 自动退避需要"失败后按时间重试"的调度器，而本产品的资源是**内嵌字节**
 * （文档里的 base64）——同样的字节再解一次不会变好；真正会变好的是"字节换了"
 * （内容版本变化，那已经会触发新请求）或"上次失败是瞬时的"（解码器/内存抖动）。
 * 后者没有可观测的退避信号，自动重试只会把**瞬时失败**反复写进共享诊断缓冲
 * （容量 512），并把"失败"变成噪声。⇒ 手动入口：用户看到底栏点名后**主动**重试，
 * 每次重试是**新请求**（`resource.retryRequested`，`attempt` 自增）。
 *
 * ## 政策不在这里
 *
 * 本算子只把"用户请求重试"放进 `Context#requestResourceRetry()` 这个唯一请求槽；
 * 重试怎么执行、旧请求怎么作废、成功后占位怎么回到正常呈现，全在视口的纹理同步环
 * （`shared/viewport/useViewportRuntime#syncPresenterTextures`）里，与首次加载同一套代码。
 */

import type { OperatorType } from '@/operators/operatorType'

export const RetryResourcesOperator: OperatorType = {
  id: 'OPERATOR_RETRY_RESOURCES',
  label: '重试未就绪资源',
  description: '对未就绪的纹理资源发起一次新请求（画面保留；成功后占位恢复为正常呈现）',

  poll(ctx) {
    return ctx.hasLoadedDocument()
  },

  exec(ctx) {
    const attempt = ctx.requestResourceRetry()
    ctx.log.info('资源', `已请求重试未就绪的资源（第 ${attempt} 次）`, { attempt })
  },
}
