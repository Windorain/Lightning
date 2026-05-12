import type { RnaProperty } from './rnaTypes'

/**
 * RnaRegistry — 对标 Blender 的 RNA struct 注册表。
 *
 * 集中存储所有属性描述符，支持按路径查询和对象巡检。
 */
export class RnaRegistry {
  private props = new Map<string, RnaProperty>()

  register(prop: RnaProperty): void {
    this.props.set(prop.path, prop)
  }

  get(path: string): RnaProperty | undefined {
    return this.props.get(path)
  }

  /** 遍历一个类型的所有注册属性，提取当前值 */
  inspect(obj: unknown): Array<{ prop: RnaProperty; value: unknown }> {
    const result: Array<{ prop: RnaProperty; value: unknown }> = []
    for (const prop of this.props.values()) {
      result.push({ prop, value: prop.get(obj) })
    }
    return result
  }
}

export const globalRna = new RnaRegistry()
