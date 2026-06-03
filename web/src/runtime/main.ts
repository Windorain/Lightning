import { ref } from 'vue'
import type { Ref } from 'vue'
import type { RuntimeDocument } from '@/context/runtimeDocument'
import type { OperatorRegistry } from '@/operators/operatorRegistry'
import type { ToolRegistry } from '@/workbench/tools/registry'
import type { RNARegistry } from '@/shared/types'
import type { ParserRegistryImpl } from '@/context/parserRegistry'
import { createParserRegistry } from '@/context/parserRegistry'

export interface MainRegistries {
  operators: OperatorRegistry
  operatorsFacade: {
    exec(id: string, props?: Record<string, unknown>): void | Promise<void>
    invoke(id: string, props?: Record<string, unknown>, event?: Event, regionId?: string): string
    find(id: string): { id: string; label: string } | undefined
    all(): { id: string; label: string }[]
    register(op: import('@/operators/operatorType').OperatorType): void
  }
  tools: ToolRegistry | null
  rna: RNARegistry | null
  parsers: ParserRegistryImpl
}

export class Main {
  readonly doc: Ref<RuntimeDocument | null> = ref(null)
  readonly structEpoch = ref(0)
  readonly currentFrameIndex = ref(0)
  readonly framesPlaybackIsPlaying = ref(false)
  readonly registries: MainRegistries

  constructor(registries: Omit<MainRegistries, 'parsers'> & { parsers?: ParserRegistryImpl }) {
    const { parsers, ...rest } = registries
    this.registries = {
      ...rest,
      parsers: parsers ?? createParserRegistry(),
    }
  }

  replaceDoc(doc: RuntimeDocument | null): void {
    this.doc.value = doc
    this.structEpoch.value += 1
    if (doc) this.currentFrameIndex.value = 0
  }

  bumpEpoch(): void {
    this.structEpoch.value += 1
  }
}
