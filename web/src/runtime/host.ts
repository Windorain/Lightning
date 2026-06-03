import type { InjectionKey } from 'vue'
import type { Main } from '@/runtime/main'
import type { Context } from '@/runtime/context'
import type { WM } from '@/runtime/wm'
import type { createLogCenter } from '@/logging/LogCenter'
import type { AttachViewportInput } from '@/runtime/attachViewport'
import { attachViewport } from '@/runtime/attachViewport'

export const hostKey: InjectionKey<Host> = Symbol('host')

export interface Host {
  readonly main: Main
  readonly ctx: Context
  readonly wm: WM
  readonly log: ReturnType<typeof createLogCenter>
  start(): Promise<void>
  attachViewport(regionId: string, input: AttachViewportInput): Promise<() => void>
  detachViewport(regionId: string): void
}

export abstract class HostBase implements Host {
  private _detachByRegion = new Map<string, () => void>()

  abstract readonly main: Main
  abstract readonly ctx: Context
  abstract readonly wm: WM
  abstract readonly log: ReturnType<typeof createLogCenter>
  abstract start(): Promise<void>

  async attachViewport(regionId: string, input: AttachViewportInput): Promise<() => void> {
    this.detachViewport(regionId)
    const unbind = await attachViewport(this.ctx, regionId, input)
    this._detachByRegion.set(regionId, unbind)
    return unbind
  }

  detachViewport(regionId: string): void {
    const fn = this._detachByRegion.get(regionId)
    if (fn) {
      fn()
      this._detachByRegion.delete(regionId)
    }
  }
}
