/**
 * StructureData（JSON 解析结果）→ 运行时 StructureDefinition。
 * 当前二者同形，仅做浅拷贝；入口集中于此便于日后校验或规范化。
 */

import type { StructureDataBaked, StructureDefinition } from '../schema/types'

export function toStructureDefinition(model: StructureDataBaked): StructureDefinition {
  return { ...model }
}
