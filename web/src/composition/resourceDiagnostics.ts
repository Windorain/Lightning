/**
 * `composition/resourceDiagnostics` —— 屏上**资源失败/降级/重试/恢复**的结构化发射点（M8-5）。
 *
 * ## 它解决什么（S0-B D2/D7 + Q1）
 *
 * 今天屏上资源链走到终态后只有两句人读文案（状态栏的「纹理缺失 k/n（点名 ≤2）」）与
 * 一条**借用** `effect.failed` 的记录（且不带 assetId —— D7）。而 Q1 把"坏一张贴图"
 * 的产品形态定为：**不夺视口** + 受影响图元降级 + **点名** + 产 `resource.*` 诊断。
 * 前两条在呈现链上（`kernelTextureResources` 的五态 + `presenterSession.bindTextures`），
 * 后两条的**记录面**在本模块。
 *
 * ## 为什么在 `composition/`（而不是直接写在 `shared/viewport/useViewportRuntime`）
 *
 * 那个文件属**旧层**：它既不能 import `application/diagnostics` 的类型，也不该承载
 * "哪条事实对应哪个稳定码"的决策（决策属装配根的职责，且要在单测里能直接驱动）。
 * 于是：视口只把**事实**（五态资源表 + 绑定计数 + 重试次数）交给装配根注入的端口，
 * 记录的形状与去重口径全部留在这里。
 *
 * ## 三条不变量（都有单测钉住）
 *
 * 1. **可定位**：每条失败记录都带 `params.assetId`（有 locator 时一并带），
 *    绝不只报计数（D7）；
 * 2. **有界**：一次同步失败 57 张不会写 57 条记录（共享记录器容量 512）——
 *    逐条记录封顶 `RESOURCE_FAILURE_REPORT_MAX`，其余由 `resource.degraded` 的
 *    `failed` 计数承载；重试不改变这条上界；
 * 3. **不静默降级**：只要有绑定指向未就绪资源（`degradedMaterials > 0`）就必须有
 *    `resource.degraded` 记录 —— "画面变平了但账上什么都没有"正是要防的形态。
 *
 * ## 与恢复副本通道的关系
 *
 * **不复用** `recovery` 通道（M8-4 交接说明）：S6-b 的判据按 `/recovery|corrupt|storage/i`
 * 过滤，把资源失败塞进 `recovery` 会同时污染两条判据。这里用**既有** `resource` 通道
 * （`DiagnosticChannel` 本来就有它）与 `resource.*` 码族。
 */

import type { DiagnosticRecorder } from '@/application/diagnostics'
import type { TextureResource } from '@/presentation/textureBinding'

/**
 * 一次同步里**逐条**失败记录的上限（其余靠 `resource.degraded` 的计数承载）。
 *
 * 取 8 的理由：记录器容量 512、一次同步最多一次结算；8 条足以在真实夹具
 * （57 纹理）里点名"坏的是哪几张"的大多数情形，同时给其它通道留足空间。
 * 重试会再次结算 —— 但重试是**显式动作**（用户点击/命令），不是帧循环里的逐帧写。
 */
export const RESOURCE_FAILURE_REPORT_MAX = 8

/** 一次资源同步的**事实**（视口侧只交事实，判定与记录形状在本模块）。 */
export interface ResourceOutcomeFacts {
  /** 视口 region id（多 Area 时定位"哪一侧的呈现受影响"）。 */
  readonly viewportId: string
  /** 本次同步的资源五态表（`textureResourcesOf` 的产出）。 */
  readonly resources: readonly TextureResource[]
  /** 绑定表里指向未就绪资源的材质条数（呈现降级范围）。 */
  readonly degradedMaterials: number
  /** 绑定表里"必需且未就绪"的条数（与 `textureBinding#missingRequired` 同一事实）。 */
  readonly missingRequired: number
  /** 0 = 首次请求；n>0 = 第 n 次显式重试建立的新请求（SPEC §7.4:252）。 */
  readonly attempt: number
}

/** 显式重试请求（用户点击"重试"或命令触发）。 */
export interface ResourceRetryRequest {
  readonly viewportId: string
  /** 当前仍未就绪的资源身份（用于 `params.assets` 点名与"恢复"的对账）。 */
  readonly failed: readonly string[]
  readonly attempt: number
}

/** 资源诊断端口（注入视口；视口不认识码表）。 */
export interface ResourceDiagnosticsPort {
  /** 结算一次资源同步（终态）。 */
  reportOutcome(facts: ResourceOutcomeFacts): void
  /** 记录一次显式重试请求。 */
  reportRetryRequested(request: ResourceRetryRequest): void
  /** 当前各视口已失败的资源身份（**只读**；判据/排障用）。 */
  failedAssets(viewportId: string): readonly string[]
}

/** 未就绪且**已经结算为失败**的资源（`unrequested` 不是失败：外链未取回是另一件事）。 */
function failedResourcesOf(resources: readonly TextureResource[]): readonly TextureResource[] {
  return resources.filter((r) => r.state === 'failed' || r.state === 'missing')
}

export function createResourceDiagnostics(
  recorder: Pick<DiagnosticRecorder, 'record'>,
): ResourceDiagnosticsPort {
  /** 视口 → 上次结算里失败的资源身份（用于"重试后恢复"的对账；有界 = 视口数）。 */
  const failedByViewport = new Map<string, Set<string>>()

  const record = (
    code: 'resource.failed' | 'resource.degraded' | 'resource.retryRequested' | 'resource.recovered',
    params: Record<string, string | number | boolean>,
    viewportId: string,
  ): void => {
    recorder.record({
      channel: 'resource',
      code,
      params,
      correlation: { viewportId },
    })
  }

  return {
    failedAssets(viewportId) {
      return [...(failedByViewport.get(viewportId) ?? [])]
    },

    reportRetryRequested(request) {
      record(
        'resource.retryRequested',
        {
          attempt: request.attempt,
          failed: request.failed.length,
          // 点名（有界：最多前 3 条，单条由记录器按 200 字符截断）
          assets: request.failed.slice(0, 3).join(','),
        },
        request.viewportId,
      )
    },

    reportOutcome(facts) {
      const failed = failedResourcesOf(facts.resources)
      const failedIds = new Set(failed.map((r) => r.identity.id))
      const previous = failedByViewport.get(facts.viewportId) ?? new Set<string>()

      // ① 逐条失败（封顶）：点名 assetId + locator（D7）。超出上限的由下面的汇总承载。
      for (const r of failed.slice(0, RESOURCE_FAILURE_REPORT_MAX)) {
        const params: Record<string, string | number | boolean> = {
          assetId: r.identity.id,
          locator: r.locator.url,
          state: r.state,
          resourceVersion: r.identity.version,
        }
        if (r.failure !== undefined) params.reason = r.failure
        record('resource.failed', params, facts.viewportId)
      }

      // ② 降级汇总：只要"有绑定指向未就绪资源"就必须有记录（不得静默变平）。
      //    `failed` 是**资源条数**（与状态栏文案同单位），`degradedMaterials` 是**材质条数**
      //    —— 两者单位不同且都有明确语义，故并列给出而不是挑一个冒充另一个。
      if (facts.degradedMaterials > 0 || failed.length > 0) {
        record(
          'resource.degraded',
          {
            degradedMaterials: facts.degradedMaterials,
            missingRequired: facts.missingRequired,
            failed: failed.length,
            total: facts.resources.length,
            attempt: facts.attempt,
            omitted: Math.max(0, failed.length - RESOURCE_FAILURE_REPORT_MAX),
          },
          facts.viewportId,
        )
      }

      // ③ 恢复：上次失败、这次就绪 ⇒ 一条 `resource.recovered`（占位已回到正常呈现）。
      for (const id of previous) {
        if (failedIds.has(id)) continue
        const nowReady = facts.resources.find((r) => r.identity.id === id && r.state === 'ready')
        if (nowReady === undefined) continue
        record(
          'resource.recovered',
          {
            assetId: id,
            locator: nowReady.locator.url,
            attempt: facts.attempt,
          },
          facts.viewportId,
        )
      }

      failedByViewport.set(facts.viewportId, failedIds)
    },
  }
}
