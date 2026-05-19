<script setup lang="ts">
import { computed } from 'vue'
import type { PropertyDescriptor } from './rna/types'

const props = defineProps<{
  descriptor: PropertyDescriptor | null
  label: string
  rnaPath?: string
  owner?: unknown
}>()

const widget = computed(() => {
  if (!props.descriptor) return 'text'
  return props.descriptor.uiWidget ?? inferWidget(props.descriptor)
})

function inferWidget(desc: NonNullable<typeof props.descriptor>): string {
  switch (desc.type) {
    case 'string':
      return (desc.enumItems && desc.enumItems.length > 0) ? 'dropdown' : 'text'
    case 'number':
      return (desc.min != null && desc.max != null) ? 'slider' : 'number'
    case 'boolean': return 'checkbox'
    case 'color':   return 'color'
    case 'enum':    return 'dropdown'
    case 'vector3': return 'vector'
    default:        return 'text'
  }
}

function getValue(): unknown {
  if (!props.descriptor || !props.owner) return ''
  return props.descriptor.get(props.owner)
}

function setValue(val: unknown): void {
  if (!props.descriptor || !props.owner) return
  props.descriptor.set(props.owner, val)
}
</script>

<template>
  <div class="ux-rna-widget" :data-rna-path="rnaPath ?? descriptor?.name">
    <label class="ux-rna-label">{{ label }}</label>
    <div class="ux-rna-input">
      <input
        v-if="widget === 'text'"
        type="text"
        :value="getValue() as string"
        @input="(e: Event) => setValue((e.target as HTMLInputElement).value)"
        class="ux-input"
      />
      <input
        v-else-if="widget === 'number'"
        type="number"
        :value="getValue() as number"
        :min="descriptor?.min"
        :max="descriptor?.max"
        @input="(e: Event) => setValue(Number((e.target as HTMLInputElement).value))"
        class="ux-input"
      />
      <template v-else-if="widget === 'slider'">
        <input
          type="range"
          :value="getValue() as number"
          :min="descriptor?.min ?? 0"
          :max="descriptor?.max ?? 100"
          @input="(e: Event) => setValue(Number((e.target as HTMLInputElement).value))"
          class="ux-slider"
        />
        <span class="ux-slider-val">{{ getValue() }}</span>
      </template>
      <input
        v-else-if="widget === 'checkbox'"
        type="checkbox"
        :checked="(getValue() as boolean) ?? false"
        @change="(e: Event) => setValue((e.target as HTMLInputElement).checked)"
        class="ux-checkbox"
      />
      <input
        v-else-if="widget === 'color'"
        type="color"
        :value="getValue() as string"
        @input="(e: Event) => setValue((e.target as HTMLInputElement).value)"
        class="ux-color"
      />
      <select
        v-else-if="widget === 'dropdown'"
        :value="getValue() as string"
        @change="(e: Event) => setValue((e.target as HTMLSelectElement).value)"
        class="ux-dropdown"
      >
        <option v-if="!descriptor" value="">--</option>
        <option
          v-for="item in descriptor?.enumItems ?? []"
          :key="item"
          :value="item"
        >{{ item }}</option>
      </select>
      <template v-else-if="widget === 'vector'">
        <input
          type="number"
          :value="(getValue() as any)?.x ?? 0"
          @input="(e: Event) => { const v = getValue() as any ?? { x: 0, y: 0, z: 0 }; v.x = Number((e.target as HTMLInputElement).value); setValue(v) }"
          class="ux-vec-input"
          title="X"
        />
        <input
          type="number"
          :value="(getValue() as any)?.y ?? 0"
          @input="(e: Event) => { const v = getValue() as any ?? { x: 0, y: 0, z: 0 }; v.y = Number((e.target as HTMLInputElement).value); setValue(v) }"
          class="ux-vec-input"
          title="Y"
        />
        <input
          type="number"
          :value="(getValue() as any)?.z ?? 0"
          @input="(e: Event) => { const v = getValue() as any ?? { x: 0, y: 0, z: 0 }; v.z = Number((e.target as HTMLInputElement).value); setValue(v) }"
          class="ux-vec-input"
          title="Z"
        />
      </template>
      <span v-else class="ux-fallback">{{ widget }}: {{ getValue() }}</span>
    </div>
  </div>
</template>

<style scoped>
.ux-rna-widget {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 2px 0;
}
.ux-rna-label {
  font-size: 11px;
  color: var(--ui-label, #999);
}
.ux-rna-input {
  display: flex;
  align-items: center;
  gap: 4px;
}
.ux-input, .ux-dropdown {
  flex: 1;
  padding: 2px 4px;
  border: 1px solid var(--ui-border, #555);
  border-radius: 2px;
  background: var(--ui-input-bg, #2a2a2a);
  color: var(--ui-text, #ccc);
  font-size: 12px;
}
.ux-slider { flex: 1; }
.ux-slider-val { font-size: 11px; min-width: 30px; text-align: right; }
.ux-checkbox { width: 16px; height: 16px; }
.ux-color { width: 32px; height: 22px; padding: 0; border: 1px solid var(--ui-border, #555); border-radius: 2px; cursor: pointer; }
.ux-vec-input {
  width: 50px;
  padding: 2px 4px;
  border: 1px solid var(--ui-border, #555);
  border-radius: 2px;
  background: var(--ui-input-bg, #2a2a2a);
  color: var(--ui-text, #ccc);
  font-size: 12px;
}
</style>
