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

const sliderStep = computed(() => {
  if (!props.descriptor || props.descriptor.min == null || props.descriptor.max == null) return 1
  const range = props.descriptor.max - props.descriptor.min
  if (range <= 0) return 1
  const raw = range / 100
  const exp = Math.floor(Math.log10(raw))
  const base = Math.pow(10, exp)
  const frac = raw / base
  // Round to 1, 2, or 5 multiples for nice steps
  const nice = frac <= 2 ? 1 : frac <= 5 ? 2 : 5
  return nice * base
})

function inferWidget(desc: NonNullable<typeof props.descriptor>): string {
  switch (desc.type) {
    case 'string':
      return (desc.enumItems && desc.enumItems.length > 0) ? 'dropdown' : 'text'
    case 'number':
      return (desc.min != null || desc.max != null) ? 'slider' : 'number'
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
  <div class="ux-rna-widget" :class="{ 'ux-rna-widget--row': widget === 'checkbox' || widget === 'color' }" :data-rna-path="rnaPath ?? descriptor?.name">
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
      <template v-else-if="widget === 'stepper'">
        <div class="ux-stepper" :class="{ 'ux-stepper--compact': descriptor?.uiWidget === 'stepper-compact' }">
          <input
            type="number"
            class="ux-stepper-input"
            :value="getValue() as number"
            :step="sliderStep"
            @input="(e: Event) => setValue(Number((e.target as HTMLInputElement).value))"
          />
          <div class="ux-stepper-btns">
            <button class="ux-stepper-up" @click="setValue((getValue() as number) + sliderStep)">&#9650;</button>
            <button class="ux-stepper-down" @click="setValue((getValue() as number) - sliderStep)">&#9660;</button>
          </div>
        </div>
      </template>
      <template v-else-if="widget === 'slider'">
        <input
          type="range"
          :value="getValue() as number"
          :min="descriptor?.min ?? 0"
          :max="descriptor?.max ?? 100"
          :step="sliderStep"
          @input="(e: Event) => setValue(Number((e.target as HTMLInputElement).value))"
          class="ux-slider"
        />
        <span class="ux-slider-val">{{ getValue() }}</span>
      </template>
      <div
        v-else-if="widget === 'checkbox'"
        class="ux-toggle"
        :class="(getValue() as boolean) ? 'ux-toggle--on' : 'ux-toggle--off'"
        @click="setValue(!(getValue() as boolean))"
      >
        <div class="ux-toggle-knob" />
      </div>
      <template v-else-if="widget === 'color'">
        <input
          type="color"
          :value="getValue() as string"
          @input="(e: Event) => setValue((e.target as HTMLInputElement).value)"
          class="ux-color"
        />
        <input
          type="text"
          :value="getValue() as string"
          @input="(e: Event) => setValue((e.target as HTMLInputElement).value)"
          class="ux-color-hex"
        />
      </template>
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
        <span class="ux-vec-label">X</span>
        <input
          type="number"
          :value="(getValue() as any)?.x ?? 0"
          @input="(e: Event) => { const v = getValue() as any ?? { x: 0, y: 0, z: 0 }; v.x = Number((e.target as HTMLInputElement).value); setValue(v) }"
          class="ux-vec-input"
        />
        <span class="ux-vec-label">Y</span>
        <input
          type="number"
          :value="(getValue() as any)?.y ?? 0"
          @input="(e: Event) => { const v = getValue() as any ?? { x: 0, y: 0, z: 0 }; v.y = Number((e.target as HTMLInputElement).value); setValue(v) }"
          class="ux-vec-input"
        />
        <span class="ux-vec-label">Z</span>
        <input
          type="number"
          :value="(getValue() as any)?.z ?? 0"
          @input="(e: Event) => { const v = getValue() as any ?? { x: 0, y: 0, z: 0 }; v.z = Number((e.target as HTMLInputElement).value); setValue(v) }"
          class="ux-vec-input"
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
  gap: 3px;
  padding: 3px 0;
}
.ux-rna-widget--row {
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
}
.ux-rna-label {
  font-size: 12px;
  color: var(--wb-text-muted);
}
.ux-rna-input {
  display: flex;
  align-items: center;
  gap: 4px;
}
.ux-input, .ux-dropdown {
  flex: 1;
  padding: 6px 8px;
  border: 1px solid var(--wb-border);
  border-radius: var(--wb-radius-sm);
  background: var(--wb-bg-surface);
  color: var(--wb-text);
  font-size: 13px;
  outline: none;
}
.ux-input:focus, .ux-dropdown:focus {
  border-color: var(--wb-accent);
}

/* Stepper */
.ux-stepper {
  display: flex;
  border: 1px solid var(--wb-border);
  border-radius: var(--wb-radius-sm);
  overflow: hidden;
  flex-shrink: 0;
}
.ux-stepper-input {
  width: 44px;
  padding: 4px 2px;
  border: none;
  background: var(--wb-bg-surface);
  color: var(--wb-text);
  font-size: 11px;
  font-family: ui-monospace, monospace;
  outline: none;
  text-align: center;
  -moz-appearance: textfield;
}
.ux-stepper-input::-webkit-inner-spin-button,
.ux-stepper-input::-webkit-outer-spin-button {
  -webkit-appearance: none;
  margin: 0;
}
.ux-stepper-btns {
  display: flex;
  flex-direction: column;
  border-left: 1px solid var(--wb-border);
}
.ux-stepper-up,
.ux-stepper-down {
  width: 15px;
  height: 12px;
  border: none;
  background: var(--wb-bg-elevated);
  color: var(--wb-text-muted);
  font-size: 7px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  line-height: 1;
}
.ux-stepper-down {
  border-top: 1px solid var(--wb-border);
}
.ux-stepper-up:hover,
.ux-stepper-down:hover {
  background: var(--wb-bg-hover);
  color: var(--wb-accent);
}
.ux-stepper--compact .ux-stepper-input { width: 38px; padding: 3px 2px; font-size: 10px; }
.ux-stepper--compact .ux-stepper-up,
.ux-stepper--compact .ux-stepper-down { width: 13px; height: 10px; font-size: 6px; }

/* Slider */
.ux-slider { flex: 1; accent-color: var(--wb-accent); }
.ux-slider-val { font-size: 11px; min-width: 32px; text-align: right; font-family: ui-monospace, monospace; font-weight: 600; color: var(--wb-accent); }

/* Toggle */
.ux-toggle {
  width: 32px; height: 18px;
  border-radius: var(--wb-radius-full);
  position: relative;
  cursor: pointer;
  transition: background 0.15s;
  flex-shrink: 0;
}
.ux-toggle--on {
  background: var(--wb-accent);
}
.ux-toggle--off {
  background: var(--wb-border);
}
.ux-toggle-knob {
  position: absolute;
  top: 2px;
  width: 14px; height: 14px;
  border-radius: 50%;
  background: #fff;
  transition: left 0.15s, right 0.15s;
}
.ux-toggle--on .ux-toggle-knob { right: 2px; }
.ux-toggle--off .ux-toggle-knob { left: 2px; background: var(--wb-text-muted); }

/* Checkbox */
.ux-checkbox { width: 16px; height: 16px; accent-color: var(--wb-accent); }

/* Color */
.ux-color { width: 26px; height: 26px; padding: 0; border: 1px solid var(--wb-border); border-radius: var(--wb-radius-md); cursor: pointer; }
.ux-color-hex {
  flex: 1;
  padding: 5px 8px;
  border: 1px solid var(--wb-border);
  border-radius: var(--wb-radius-sm);
  background: var(--wb-bg-surface);
  color: var(--wb-text);
  font-size: 11px;
  font-family: ui-monospace, monospace;
  outline: none;
}

/* Vector */
.ux-vec-input {
  width: 40px;
  padding: 4px 2px;
  border: 1px solid var(--wb-border);
  border-radius: var(--wb-radius-sm);
  background: var(--wb-bg-surface);
  color: var(--wb-text);
  font-size: 11px;
  font-family: ui-monospace, monospace;
  outline: none;
  text-align: center;
}
.ux-vec-label {
  font-size: 9px;
  color: var(--wb-text-dim);
  width: 10px;
  text-align: center;
  flex-shrink: 0;
}
</style>
