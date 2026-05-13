<script setup lang="ts">
import { useSelectionContext } from '@/workbench/selectionContext'
import { useEditHistory } from '@/workbench/editHistoryContext'
import { useBContext } from '@/workbench/context/bContext'

const selection = useSelectionContext()
const history = useEditHistory()
const bctx = useBContext()

defineProps<{ x: number; y: number; visible: boolean }>()
const emit = defineEmits<{ (e: 'close'): void }>()

function run(action: string): void {
  switch (action) {
    case 'inspect': bctx.operators.exec('OPERATOR_TOOL_SET', { toolId: 'OPERATOR_SELECT' }); break
    case 'annotate': bctx.operators.exec('OPERATOR_TOOL_SET', { toolId: 'OPERATOR_ANNOTATION' }); break
    case 'label': bctx.operators.exec('OPERATOR_TOOL_SET', { toolId: 'OPERATOR_LABEL' }); break
    case 'delete': bctx.operators.exec('OPERATOR_TOOL_SET', { toolId: 'OPERATOR_DELETE' }); break
    case 'eyedropper': bctx.operators.exec('OPERATOR_TOOL_SET', { toolId: 'OPERATOR_EYEDROPPER' }); break
    case 'move': bctx.operators.exec('OPERATOR_TOOL_SET', { toolId: 'OPERATOR_MOVE' }); break
    case 'mirror': bctx.operators.exec('OPERATOR_TOOL_SET', { toolId: 'OPERATOR_MIRROR' }); break
    case 'undo': bctx.operators.exec('OPERATOR_UNDO'); break
    case 'redo': bctx.operators.exec('OPERATOR_REDO'); break
  }
  emit('close')
}

const hasSelection = selection.items.value.size > 0
const hasMultiple = selection.items.value.size > 1
</script>

<template>
  <div v-if="visible" class="ctx-menu" :style="{ left: x + 'px', top: y + 'px' }" @click.stop>
    <template v-if="!hasSelection">
      <button class="ctx-item" @click="run('label')">放置标签</button>
    </template>
    <template v-else-if="!hasMultiple">
      <button class="ctx-item" @click="run('inspect')">检查</button>
      <button class="ctx-item" @click="run('annotate')">注解</button>
      <button class="ctx-item" @click="run('label')">放置标签</button>
      <button class="ctx-item" @click="run('delete')">移除此方块</button>
      <button class="ctx-item" @click="run('eyedropper')">拾取类型</button>
    </template>
    <template v-else>
      <button class="ctx-item" @click="run('annotate')">批量注解</button>
      <button class="ctx-item" @click="run('move')">移动选中</button>
      <button class="ctx-item" @click="run('delete')">删除选中</button>
      <button class="ctx-item" @click="run('mirror')">镜像选中</button>
    </template>
    <div class="ctx-sep" />
    <button class="ctx-item" @click="run('undo')" :disabled="!history.canUndo.value">撤销</button>
    <button class="ctx-item" @click="run('redo')" :disabled="!history.canRedo.value">重做</button>
  </div>
</template>

<style scoped>
.ctx-menu {
  position: fixed; z-index: 2000; min-width: 160px;
  padding: 4px; background: var(--nei-dropdown-bg); border: 1px solid var(--nei-border);
  border-radius: 6px; box-shadow: 0 8px 24px rgba(0,0,0,0.5);
}
.ctx-item {
  display: block; width: 100%; padding: 5px 10px; border: none;
  background: transparent; color: var(--nei-text-dark); font-size: 12px;
  text-align: left; cursor: pointer; border-radius: 3px;
}
.ctx-item:hover { background: var(--nei-dropdown-hover); color: #fff; }
.ctx-item:disabled { color: var(--nei-muted); cursor: default; }
.ctx-sep { height: 1px; background: var(--nei-border); margin: 2px 0; }
</style>
