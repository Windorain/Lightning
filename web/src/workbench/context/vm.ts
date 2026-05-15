/**
 * VM（虚拟机）抽象层。
 *
 * 职责：
 * 1. 组装 BContext（委托 createWorkbenchContext）
 * 2. 注册 operators / 启动视口
 * 3. 接管 I/O：场景数据通过 VM 注入，内部走生产加载路径
 *
 * 测试只通过 VM 提供的公开接口与系统交互——注入数据、注入事件、观测状态。
 * harness 不直接调用 scene.loadFromData() 等内部 API。
 */

import type { BContext } from '@/workbench/context/bContext'
import type { BContextSettings } from '@/workbench/context/bContext'
import { createWorkbenchContext, registerAllOperators, bootTestViewport } from '@/workbench/context/workbenchContext'
import { createSceneContext } from '@/workbench/sceneContext'
import { createConnectionContext } from '@/workbench/connectionContext'
import { createSelectionContext } from '@/workbench/selectionContext'
import { createEditHistory } from '@/workbench/editHistoryContext'
import { createToolRegistry } from '@/workbench/toolRegistry'
import { createBContextSettings } from '@/workbench/context/toolSettings'
import { buildTestSceneDocument, blocksToCellGrid, type BlockTuple } from '@/workbench/testing/testScene'

// 文档格式处理器（VM 负责注册）
import { formatDispatcher } from '@/workbench/context/documentHandler'
import { V2PlainHandler } from '@/workbench/context/handlers/v2PlainHandler'
import { WorldHandler } from '@/workbench/context/handlers/worldHandler'
import { StructureDataHandler } from '@/workbench/context/handlers/structureDataHandler'

let _formatsBooted = false
function ensureFormats(): void {
  if (_formatsBooted) return
  _formatsBooted = true
  formatDispatcher.register(V2PlainHandler)
  formatDispatcher.register(WorldHandler)
  formatDispatcher.register(StructureDataHandler)
}

// ---- VM 配置 ----

export interface VMConfig {
  /** 便捷：直接注入方块数据（转为 cellGrid 格式后走 loadFromData） */
  blocks?: BlockTuple[]
  /** 注入完整场景文档（走 loadFromData） */
  document?: Record<string, any>
  /** 设置覆盖 */
  settings?: Partial<BContextSettings>
  /** 视口尺寸 */
  viewport?: { width: number; height: number }
}

// ---- VM 实例 ----

export interface VM {
  bctx: BContext
}

// ---- 创建 VM ----

export function createVM(config: VMConfig = {}): VM {
  ensureFormats()

  // 1. 创建 context 对象
  const scene = createSceneContext()
  const connection = createConnectionContext(scene)
  const selection = createSelectionContext()
  const editHistory = createEditHistory(256)
  const toolRegistry = createToolRegistry()
  const settings = createBContextSettings({
    theme: 'dark',
    language: 'zh',
    confirmDirty: () => false,
  })

  // 2. 组装 BContext
  const { bctx } = createWorkbenchContext({
    scene, connection, selection, editHistory, toolRegistry, settings,
  })

  // 3. 注册 operators + 激活默认工具
  registerAllOperators(bctx)
  toolRegistry.rebuildTools()
  toolRegistry.activate('OPERATOR_SELECT')

  // 4. I/O：准备场景数据
  const doc = config.document ?? buildTestSceneDocument(config.blocks ?? [])
  const blocks = config.blocks ?? []
  const { cellGrid, blockPalette } = blocksToCellGrid(blocks)

  // 5. 启动视口（camera / mesh / DOM / handlers）
  bootTestViewport(bctx, { cellGrid, blockPalette })

  // 6. 加载场景（生产路径）
  scene.loadFromData(doc)

  return { bctx }
}
