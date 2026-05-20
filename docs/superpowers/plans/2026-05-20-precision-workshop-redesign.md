# Precision Workshop Redesign — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the NEI retro-industrial visual language with "Precision Workshop" — cool steel blue on midnight, blueprint grid, industrial precision aesthetic across workbench + embed viewer.

**Architecture:** CSS custom property replacement is the foundation (Phase 1). Then core shell/components get updated styles (Phase 2-3). Panels follow naturally since they use the same primitives (Phase 4). Embed viewer gets minimal token-adoption pass (Phase 5). No architectural changes — purely visual CSS + template updates.

**Tech Stack:** Vue 3 + TypeScript + CSS custom properties. No new dependencies. Custom inline SVG for tool icons.

---

## File Map

| File | Action | Phase |
|------|--------|-------|
| `web/src/styles/precision-tokens.css` | **Create** | 1 |
| `web/src/styles/nei-tokens.css` | **Remove** (replace imports) | 1 |
| `web/src/workbench/composables/useNeiTheme.ts` | **Modify** → rename to usePrecisionTheme | 1 |
| `web/src/workbench/layout/WorkbenchShell.vue` | **Modify** | 2 |
| `web/src/workbench/ux/UIRenderer.vue` | **Modify** | 2 |
| `web/src/workbench/ux/RNAWidget.vue` | **Modify** | 2 |
| `web/src/workbench/ux/OperatorBtn.vue` | **Modify** | 3 |
| `web/src/workbench/ux/UIMenu.vue` | **Modify** | 3 |
| `web/src/workbench/ux/PanelTabs.vue` | **Modify** | 2 |
| `web/src/workbench/components/MenuBar.vue` | **Modify** | 2 |
| `web/src/workbench/components/StatusBar.vue` | **Modify** | 2 |
| `web/src/workbench/components/WorkspaceTabs.vue` | **Modify** | 2 |
| `web/src/workbench/components/ContextMenu.vue` | **Modify** | 3 |
| `web/src/workbench/components/WorkbenchSettingsDrawer.vue` | **Modify** | 3 |
| `web/src/workbench/components/WorkbenchViewport.vue` | **Modify** | 3 |
| `web/src/workbench/icons/toolIcons.ts` | **Create** | 3 |
| `web/src/workbench/ux/panels/toolShelf.ts` | **Modify** | 3 |
| `web/src/embed/EmbedViewer.vue` | **Modify** | 5 |
| `web/src/embed/components/ViewerCore.vue` | **Modify** | 5 |
| `web/src/embed/components/ToolTipBox.vue` | **Modify** | 5 |
| `web/src/embed/components/BlockStatsSidebar.vue` | **Modify** | 5 |
| `web/src/embed/components/BlockSlotPreview.vue` | **Modify** | 5 |
| `web/src/embed/components/LayerPreviewBar.vue` | **Modify** | 5 |
| `web/src/embed/components/WorldFrameScrubber.vue` | **Modify** | 5 |
| `web/src/embed/components/WorldFramePlayerControls.vue` | **Modify** | 5 |
| `web/src/workbench/components/MarkdownEditor.vue` | **Modify** | 4 |
| `web/src/workbench/components/StatsPanel.vue` | **Modify** | 4 |
| `web/src/workbench/components/ResourceBrowser.vue` | **Modify** | 4 |
| `web/src/workbench/ux/panels/annotationPanel.ts` | **Modify** | 4 |
| `web/src/workbench/ux/panels/blockInspector.ts` | **Modify** | 4 |
| `web/src/workbench/ux/panels/menuBar.ts` | **Modify** | 4 |
| `web/src/workbench/ux/panels/sceneInfo.ts` | **Modify** | 4 |
| `web/src/workbench/ux/panels/transform.ts` | **Modify** | 4 |
| `web/src/workbench/ux/panels/blockStats.ts` | **Modify** | 4 |
| `web/src/workbench/ux/panels/wikiConfig.ts` | **Modify** | 4 |
| `web/src/workbench/components/ExportWorkspace.vue` | **Modify** | 4 |
| `web/src/workbench/components/WikiViewerWorkspace.vue` | **Modify** | 4 |
| `web/src/workbench/components/WorkbenchPreviewPanel.vue` | **Modify** | 4 |
| `web/src/workbench/components/SdeConnectionPanel.vue` | **Modify** | 4 |
| `web/src/workbench/components/ExportsListPanel.vue` | **Modify** | 4 |
| `web/src/workbench/components/LocalFilePanel.vue` | **Modify** | 4 |
| `web/src/workbench/components/LocalBundlePanel.vue` | **Modify** | 4 |

---

## Phase 1: Design Token Foundation

### Task 1.1: Create precision-tokens.css

**Files:**
- Create: `web/src/styles/precision-tokens.css`

- [ ] **Step 1: Write the new token file**

Write `web/src/styles/precision-tokens.css`:

```css
/**
 * Precision Workshop — Design Tokens
 * Cold steel blue on midnight. Industrial precision aesthetic.
 */
:root {
  /* Surface hierarchy */
  --wb-bg-deepest: #0b1217;
  --wb-bg-surface: #101820;
  --wb-bg-elevated: #0f161d;
  --wb-bg-hover: #1a2532;

  /* Borders */
  --wb-border: #1a2532;
  --wb-border-light: #1a3040;

  /* Accent */
  --wb-accent: #4dabf7;
  --wb-accent-muted: #7aa2c4;

  /* Text */
  --wb-text: #c5d8e8;
  --wb-text-muted: #56728a;
  --wb-text-dim: #3a5068;

  /* Semantic */
  --wb-success: #2ecc71;
  --wb-danger: #e74c3c;
  --wb-danger-bg: #301a1a;

  /* Scrollbar */
  --wb-scrollbar-width: 6px;
  --wb-scrollbar-track: #0d141c;
  --wb-scrollbar-thumb: #1a2532;

  /* Viewport */
  --wb-viewport-bg: #0b1217;
  --wb-grid-color: rgba(77, 171, 247, 0.025);

  /* Misc */
  --wb-radius-sm: 3px;
  --wb-radius-md: 4px;
  --wb-radius-lg: 6px;
  --wb-radius-xl: 8px;
  --wb-radius-full: 10px;
}

[data-wb-theme="light"] {
  --wb-bg-deepest: #e8ecf0;
  --wb-bg-surface: #f0f2f5;
  --wb-bg-elevated: #e0e4e8;
  --wb-bg-hover: #d0d6de;
  --wb-border: #c0c8d0;
  --wb-border-light: #d0d6de;
  --wb-accent: #2563eb;
  --wb-accent-muted: #4b7cb8;
  --wb-text: #1a2532;
  --wb-text-muted: #5a6678;
  --wb-text-dim: #8898a8;
  --wb-success: #16a34a;
  --wb-danger: #dc2626;
  --wb-danger-bg: #fecaca;
  --wb-scrollbar-track: #d0d6de;
  --wb-scrollbar-thumb: #a0aab4;
  --wb-viewport-bg: #d8dce2;
  --wb-grid-color: rgba(37, 99, 235, 0.04);
}
```

- [ ] **Step 2: Add global scrollbar styles to the same file**

Append to `web/src/styles/precision-tokens.css`:

```css
/* Custom scrollbar — global */
* {
  scrollbar-width: thin;
  scrollbar-color: var(--wb-scrollbar-thumb) var(--wb-scrollbar-track);
}

::-webkit-scrollbar {
  width: 6px;
  height: 6px;
}

::-webkit-scrollbar-track {
  background: var(--wb-scrollbar-track);
  border-radius: 3px;
}

::-webkit-scrollbar-thumb {
  background: var(--wb-scrollbar-thumb);
  border-radius: 2px;
}

::-webkit-scrollbar-thumb:hover {
  background: var(--wb-accent);
}
```

- [ ] **Step 3: Update import in main-workbench.ts**

Read `web/src/main-workbench.ts`. Remove `import './styles/nei-tokens.css'` and add `import './styles/precision-tokens.css'`.

```typescript
// Replace the import line:
import './styles/precision-tokens.css'
```

- [ ] **Step 4: Update import in main.ts (embed entry)**

Read `web/src/main.ts`. Remove `import './styles/nei-tokens.css'` and add `import './styles/precision-tokens.css'`.

- [ ] **Step 5: Commit**

```bash
git add web/src/styles/precision-tokens.css web/src/main-workbench.ts web/src/main.ts
git commit -m "feat: replace NEI tokens with Precision Workshop design tokens"
```

### Task 1.2: Rename theme composable

**Files:**
- Modify: `web/src/workbench/composables/useNeiTheme.ts`
- Modify: all files importing from this module

- [ ] **Step 1: Rewrite useNeiTheme.ts**

Rewrite `web/src/workbench/composables/useNeiTheme.ts`:

```typescript
import { ref, watch } from 'vue'

export type WbTheme = 'light' | 'dark'

const STORAGE_KEY = 'wb-theme'
const ATTR = 'data-wb-theme'

function readStored(): WbTheme {
  try {
    const v = localStorage.getItem(STORAGE_KEY)
    if (v === 'light' || v === 'dark') return v
  } catch { /* noop */ }
  return 'dark'
}

function applyTheme(t: WbTheme): void {
  if (typeof document !== 'undefined') {
    document.documentElement.setAttribute(ATTR, t)
  }
}

const theme = ref<WbTheme>(readStored())

if (typeof document !== 'undefined') {
  applyTheme(theme.value)
}

watch(theme, (t) => {
  applyTheme(t)
  try { localStorage.setItem(STORAGE_KEY, t) } catch { /* noop */ }
})

export function toggleTheme(): void {
  theme.value = theme.value === 'dark' ? 'light' : 'dark'
}

export function useNeiTheme() {
  return { theme, toggleTheme }
}

export { theme }
```

Note: keep the exported function name `useNeiTheme` to avoid breaking all imports. The attribute changes from `data-nei-theme` to `data-wb-theme`.

- [ ] **Step 2: Verify no broken references**

Run: `npx tsc --noEmit 2>&1 | head -20`

Should compile without errors related to useNeiTheme.

- [ ] **Step 3: Commit**

```bash
git add web/src/workbench/composables/useNeiTheme.ts
git commit -m "refactor: update theme composable to data-wb-theme attribute"
```

---

## Phase 2: Core Visual DNA

### Task 2.1: Redesign WorkbenchShell

**Files:**
- Modify: `web/src/workbench/layout/WorkbenchShell.vue`

- [ ] **Step 1: Replace all CSS in WorkbenchShell.vue**

Replace the entire `<style>` block in `web/src/workbench/layout/WorkbenchShell.vue`:

```css
.wb-shell {
  display: flex;
  flex-direction: column;
  height: 100vh;
  overflow: hidden;
  background: var(--wb-bg-deepest);
  color: var(--wb-text);
  font-family: system-ui, 'Segoe UI', sans-serif;
}
.wb-shell--dragging * { cursor: col-resize !important; }

.wb-menubar {
  flex-shrink: 0;
  height: 32px;
  background: var(--wb-bg-elevated);
  border-bottom: 1px solid var(--wb-border);
}

.wb-workspace-tabs {
  flex-shrink: 0;
  height: 34px;
  background: var(--wb-bg-deepest);
  border-bottom: 1px solid var(--wb-border);
}

.wb-main {
  flex: 1;
  min-height: 0;
  display: flex;
  overflow: hidden;
}

.wb-divider {
  flex-shrink: 0;
  width: 1px;
  cursor: col-resize;
  background: var(--wb-border);
  transition: background 0.15s;
  z-index: 10;
}
.wb-divider:hover,
.wb-divider:active {
  background: var(--wb-accent);
}

.wb-viewport {
  flex: 1;
  min-width: 0;
  position: relative;
  overflow: hidden;
  background: var(--wb-viewport-bg);
  background-image:
    linear-gradient(var(--wb-grid-color) 1px, transparent 1px),
    linear-gradient(90deg, var(--wb-grid-color) 1px, transparent 1px);
  background-size: 32px 32px;
}

.wb-properties {
  flex-shrink: 0;
  overflow-y: auto;
  background: var(--wb-bg-elevated);
  border-left: 1px solid var(--wb-border);
}

.wb-statusbar {
  flex-shrink: 0;
  height: 26px;
  background: var(--wb-bg-deepest);
  border-top: 1px solid var(--wb-border);
  font-size: 10px;
  display: flex;
  align-items: center;
  padding: 0 12px;
  color: var(--wb-text-muted);
}
```

- [ ] **Step 2: Commit**

```bash
git add web/src/workbench/layout/WorkbenchShell.vue
git commit -m "feat: Precision Workshop shell — blueprint grid viewport, clean 1px borders"
```

### Task 2.2: Redesign UI primitives (UIRenderer, RNAWidget, PanelTabs)

**Files:**
- Modify: `web/src/workbench/ux/UIRenderer.vue`
- Modify: `web/src/workbench/ux/RNAWidget.vue`
- Modify: `web/src/workbench/ux/PanelTabs.vue`

- [ ] **Step 1: UIRenderer.vue — replace CSS tokens**

Replace the `<style scoped>` block in `web/src/workbench/ux/UIRenderer.vue`:

```css
.ux-row { display: flex; flex-direction: row; align-items: center; gap: 6px; }
.ux-column { display: flex; flex-direction: column; gap: 4px; }
.ux-box {
  border: 1px solid var(--wb-border);
  border-radius: var(--wb-radius-lg);
  padding: 10px;
  margin: 4px 0;
  background: var(--wb-bg-surface);
}
.ux-box-label {
  font-size: 9px;
  font-weight: 600;
  color: var(--wb-text-dim);
  text-transform: uppercase;
  letter-spacing: 0.8px;
  margin-bottom: 6px;
}
.ux-split { display: flex; flex-direction: row; }
.ux-scroll { overflow-y: auto; }
.ux-label { font-size: 11px; color: var(--wb-text-muted); }
.ux-sep {
  border: none;
  border-top: 1px solid transparent;
  background: linear-gradient(90deg, var(--wb-border), transparent);
  height: 1px;
  margin: 6px 0;
}
```

- [ ] **Step 2: RNAWidget.vue — replace CSS tokens + stepper + toggle**

Replace the entire `<style scoped>` block in `web/src/workbench/ux/RNAWidget.vue`:

```css
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
  font-size: 10px;
  color: var(--wb-text-muted);
}
.ux-rna-input {
  display: flex;
  align-items: center;
  gap: 4px;
}
.ux-input, .ux-dropdown {
  flex: 1;
  padding: 5px 8px;
  border: 1px solid var(--wb-border);
  border-radius: var(--wb-radius-sm);
  background: var(--wb-bg-surface);
  color: var(--wb-text);
  font-size: 11px;
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

/* Vec label */
.ux-vec-label {
  font-size: 9px;
  color: var(--wb-text-dim);
  width: 10px;
  text-align: center;
  flex-shrink: 0;
}
```

- [ ] **Step 3: RNAWidget.vue — add stepper and toggle templates**

In RNAWidget.vue template, replace the slider section and checkbox section. Add stepper support for number widget with `uiWidget: 'stepper'`. Add the toggle template.

The `widget === 'stepper'` case (for number type with stepper override — detect via `uiWidget` prop or infer from min/max + step hint):

Add after the `v-else-if="widget === 'number'"` block:

```html
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
```

Replace the checkbox section:

```html
<div
  v-else-if="widget === 'checkbox'"
  class="ux-toggle"
  :class="(getValue() as boolean) ? 'ux-toggle--on' : 'ux-toggle--off'"
  @click="setValue(!(getValue() as boolean))"
>
  <div class="ux-toggle-knob" />
</div>
```

Update the `inferWidget` function to return `'stepper'` for number type (making stepper the default for numbers):

```typescript
function inferWidget(desc: NonNullable<typeof props.descriptor>): string {
  switch (desc.type) {
    case 'string':
      return (desc.enumItems && desc.enumItems.length > 0) ? 'dropdown' : 'text'
    case 'number':
      return (desc.min != null || desc.max != null) ? 'stepper' : 'number'
    case 'boolean': return 'checkbox'
    case 'color':   return 'color'
    case 'enum':    return 'dropdown'
    case 'vector3': return 'vector'
    default:        return 'text'
  }
}
```

Add the `color-hex` variant in the color section — add a hex input next to the color picker:

```html
<input
  v-else-if="widget === 'color'"
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
```

For vector3, wrap each input with a label span:

```html
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
```

- [ ] **Step 4: PanelTabs.vue — replace CSS**

Replace the `<style scoped>` block in `web/src/workbench/ux/PanelTabs.vue`:

```css
.pt-root {
  display: flex;
  flex-direction: column;
  height: 100%;
}
.pt-tabs {
  flex-shrink: 0;
  display: flex;
  border-bottom: 1px solid var(--wb-border);
  background: var(--wb-bg-deepest);
  overflow-x: auto;
  height: 32px;
}
.pt-tab {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 0 14px;
  border: none;
  background: transparent;
  color: var(--wb-text-muted);
  font-size: 11px;
  cursor: pointer;
  white-space: nowrap;
  border-bottom: 2px solid transparent;
  transition: color 0.15s, border-color 0.15s;
}
.pt-tab:hover {
  color: var(--wb-text);
}
.pt-tab--active {
  color: var(--wb-text);
  border-bottom-color: var(--wb-accent);
  font-weight: 500;
}
.pt-tab-icon {
  font-size: 14px;
  line-height: 1;
}
.pt-tab-label {
  font-weight: inherit;
}
.pt-content {
  flex: 1;
  overflow-y: auto;
  padding: 10px 12px;
}
```

- [ ] **Step 5: Commit**

```bash
git add web/src/workbench/ux/UIRenderer.vue web/src/workbench/ux/RNAWidget.vue web/src/workbench/ux/PanelTabs.vue
git commit -m "feat: Precision Workshop UI primitives — stepper, toggle, new tokens"
```

### Task 2.3: Redesign chrome (MenuBar, StatusBar, WorkspaceTabs)

**Files:**
- Modify: `web/src/workbench/components/MenuBar.vue`
- Modify: `web/src/workbench/components/StatusBar.vue`
- Modify: `web/src/workbench/components/WorkspaceTabs.vue`

- [ ] **Step 1: MenuBar.vue — replace CSS**

Replace the entire `<style scoped>` block in `web/src/workbench/components/MenuBar.vue`:

```css
.mb-root {
  display: flex; align-items: center; justify-content: space-between;
  height: 100%; padding: 0 12px; font-size: 11px;
}
.mb-left, .mb-right { display: flex; align-items: center; gap: 0; }
.mb-item { position: relative; }
.mb-label {
  padding: 4px 10px; border-radius: var(--wb-radius-sm); cursor: pointer;
  user-select: none; color: var(--wb-accent-muted); display: inline-block;
}
.mb-label:hover { background: var(--wb-bg-hover); color: var(--wb-text); }
.mb-disabled { color: var(--wb-text-dim); cursor: default; }
.mb-disabled:hover { background: transparent; }
.mb-brand {
  color: var(--wb-text); font-size: 12px; font-weight: 600; letter-spacing: 0.3px; margin-right: 20px;
}
.mb-dropdown {
  position: absolute; top: 100%; left: 0; z-index: 1000;
  min-width: 180px; padding: 4px;
  background: var(--wb-bg-elevated); border: 1px solid var(--wb-border); border-radius: var(--wb-radius-lg);
  box-shadow: 0 8px 24px rgba(0,0,0,0.5);
}
.mb-dd-section {
  padding: 5px 12px 3px; font-size: 9px; text-transform: uppercase;
  color: var(--wb-text-dim); letter-spacing: 0.5px;
}
.mb-dd-item {
  display: flex; align-items: center; gap: 4px;
  width: 100%; padding: 5px 12px; border: none;
  background: transparent; color: var(--wb-text); font-size: 11px;
  text-align: left; cursor: pointer; border-radius: var(--wb-radius-sm);
}
.mb-dd-item:hover { background: var(--wb-bg-hover); }
.mb-check { width: 14px; font-size: 10px; color: var(--wb-success); }
.mb-status-dot { width: 7px; height: 7px; border-radius: 50%; margin-right: 4px; }
.mb-online { background: var(--wb-success); box-shadow: 0 0 6px rgba(46, 204, 113, 0.4); }
.mb-offline { background: var(--wb-text-dim); }
.mb-status-label { font-size: 10px; color: var(--wb-text-muted); }
.mb-theme-btn {
  width: 24px; height: 24px; border: 1px solid var(--wb-border); border-radius: var(--wb-radius-sm);
  background: var(--wb-bg-surface); color: var(--wb-accent-muted); font-size: 12px;
  cursor: pointer; display: flex; align-items: center; justify-content: center;
  margin-right: 10px; padding: 0; line-height: 1;
}
.mb-theme-btn:hover { background: var(--wb-bg-hover); }
.mb-file-input { display: none; }
```

Also add the brand span at the start of the `.mb-left` div in template:

```html
<div class="mb-left">
  <span class="mb-brand">LIGHTNING</span>
  <!-- existing menu items -->
```

- [ ] **Step 2: StatusBar.vue — replace CSS**

Replace the `<style scoped>` block:

```css
.sb-root {
  display: flex;
  align-items: center;
  width: 100%;
  gap: 14px;
  color: var(--wb-text-muted);
}
.sb-item { white-space: nowrap; font-size: 10px; }
.sb-item--error { color: var(--wb-danger); }
.sb-item--warn { color: #f59e0b; }
.sb-spacer { flex: 1; }
```

- [ ] **Step 3: WorkspaceTabs.vue — replace CSS**

Replace the `<style scoped>` block:

```css
.wt-root {
  display: flex; align-items: stretch; height: 100%;
  padding: 0 10px; gap: 0;
}
.wt-tab {
  padding: 0 18px; border: none; background: transparent;
  color: var(--wb-text-muted); font-size: 11px; cursor: pointer;
  border-bottom: 2px solid transparent;
  transition: color 0.15s, border-color 0.15s;
}
.wt-tab:hover { color: var(--wb-text); }
.wt-tab--active { color: var(--wb-text); border-bottom-color: var(--wb-accent); font-weight: 500; }
```

- [ ] **Step 4: Commit**

```bash
git add web/src/workbench/components/MenuBar.vue web/src/workbench/components/StatusBar.vue web/src/workbench/components/WorkspaceTabs.vue
git commit -m "feat: Precision Workshop chrome — menu bar, status bar, workspace tabs"
```

---

## Phase 3: Interactive Components

### Task 3.1: Tool Icons — create SVG icon module

**Files:**
- Create: `web/src/workbench/icons/toolIcons.ts`

- [ ] **Step 1: Write the icon module**

Write `web/src/workbench/icons/toolIcons.ts`:

```typescript
/**
 * Precision Workshop tool icons.
 * Inline SVG, 24x24 viewBox, 1.5px stroke, round caps/joins.
 * Usage: toolIcons.select('inactive') — returns SVG string.
 */

export type IconState = 'inactive' | 'active' | 'hover'

const stateColors: Record<IconState, string> = {
  inactive: '#56728a',
  active: '#4dabf7',
  hover: '#c5d8e8',
}

const icons = {
  select: `<svg viewBox="0 0 24 24" fill="none" stroke="__COLOR__" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4l6 16 2-6 6-2z"/></svg>`,

  move: `<svg viewBox="0 0 24 24" fill="none" stroke="__COLOR__" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v20M2 12h20"/><path d="M8 4l4-2 4 2M8 20l4 2 4-2M4 8l-2 4 2 4M20 8l2 4-2 4"/></svg>`,

  box: `<svg viewBox="0 0 24 24" fill="none" stroke="__COLOR__" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="1"/><path d="M3 12h18M12 3v18"/></svg>`,

  point: `<svg viewBox="0 0 24 24" fill="none" stroke="__COLOR__" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><circle cx="12" cy="12" r="8" stroke-dasharray="3 2"/></svg>`,

  line: `<svg viewBox="0 0 24 24" fill="none" stroke="__COLOR__" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20L20 4"/><circle cx="4" cy="20" r="1.5" fill="__COLOR__" stroke="none"/><circle cx="20" cy="4" r="1.5" fill="__COLOR__" stroke="none"/></svg>`,

  text: `<svg viewBox="0 0 24 24" fill="none" stroke="__COLOR__" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 7h14M12 7v14"/><path d="M6 21h12"/><path d="M7 3h10l-1 4H8z"/></svg>`,
} as const

export type ToolIconId = keyof typeof icons

export function toolIcon(id: ToolIconId, state: IconState = 'inactive'): string {
  const color = stateColors[state]
  return icons[id].replace(/__COLOR__/g, color)
}
```

- [ ] **Step 2: Update toolShelf.ts to use SVG icons**

Modify `web/src/workbench/ux/panels/toolShelf.ts`. Replace the layout function to use an `iconSvg` field on each tool item and keep icon as the raw SVG:

```typescript
import type { BContext } from '@/workbench/context/bContext'
import type { PanelDeclaration } from '../types/panel'
import { SpaceType, RegionType } from '../types/screen'
import type { UILayout, UILayoutItem } from '../types/layout'
import { toolIcon, type ToolIconId } from '@/workbench/icons/toolIcons'

const toolIconMap: Record<string, ToolIconId> = {
  OPERATOR_SELECT: 'select',
  OPERATOR_MOVE: 'move',
  OPERATOR_BOX: 'box',
  OPERATOR_POINT: 'point',
  OPERATOR_LINE: 'line',
  OPERATOR_TEXT: 'text',
}

export const toolShelfPanel: PanelDeclaration = {
  id: 'tool-shelf',
  label: '工具',
  spaceType: SpaceType.VIEW_3D,
  regionType: RegionType.TOOLSHELF,

  poll(): boolean { return true },
  owner(ctx: BContext): unknown { return ctx.settings },
  layout(ctx: BContext): UILayout {
    const tools = [...ctx.toolRegistry.tools.values()]
    const activeToolId = ctx.toolRegistry.activeTool.value?.id ?? ''
    const items: UILayoutItem[] = tools.map(t => {
      const iconId = toolIconMap[t.id] ?? 'select'
      const isActive = t.id === activeToolId
      return {
        kind: 'operator' as const,
        id: 'OPERATOR_TOOL_SET',
        label: toolIcon(iconId, isActive ? 'active' : 'inactive'),
        icon: '',
        title: t.label,
        props: { toolId: t.id },
      }
    })
    return { kind: 'column', align: false, items }
  },
}
```

Note: The tool icon SVG is passed as the label (innerHTML). The OperatorBtn will need to support this — or we render the icon differently. Since OperatorBtn currently has `v-if="icon"` for the icon span, we should pass the SVG through a `v-html` approach.

Actually, simpler approach: pass the SVG as the `label` prop and handle it in OperatorBtn. Or create a new dedicated icon rendering approach.

Even simpler: keep using the `icon` prop in OperatorBtn and pass the SVG string, then use `v-html` inside the icon span.

Modify `web/src/workbench/ux/OperatorBtn.vue` — replace the icon rendering:

```html
<span v-if="icon" class="ux-icon" v-html="icon"></span>
```

- [ ] **Step 3: Commit**

```bash
git add web/src/workbench/icons/toolIcons.ts web/src/workbench/ux/panels/toolShelf.ts web/src/workbench/ux/OperatorBtn.vue
git commit -m "feat: custom SVG tool icons — 6 tools, 3 states"
```

### Task 3.2: Redesign buttons, menus, context menu

**Files:**
- Modify: `web/src/workbench/ux/OperatorBtn.vue`
- Modify: `web/src/workbench/ux/UIMenu.vue`
- Modify: `web/src/workbench/components/ContextMenu.vue`

- [ ] **Step 1: OperatorBtn.vue — replace CSS**

Replace the `<style scoped>` block in `web/src/workbench/ux/OperatorBtn.vue`:

```css
.ux-operator-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 6px 14px;
  border: 1px solid var(--wb-border);
  border-radius: var(--wb-radius-md);
  background: var(--wb-bg-surface);
  color: var(--wb-accent-muted);
  cursor: pointer;
  font-size: 11px;
  line-height: 1.4;
  width: 100%;
  transition: background 0.15s, border-color 0.15s;
}
.ux-operator-btn:hover {
  background: var(--wb-bg-hover);
  border-color: var(--wb-accent);
  color: var(--wb-text);
}
.ux-operator-btn--primary {
  border-color: var(--wb-accent);
  background: var(--wb-bg-hover);
  color: var(--wb-accent);
  font-weight: 500;
}
.ux-operator-btn--danger {
  border-color: var(--wb-danger-bg);
  color: var(--wb-danger);
}
.ux-operator-btn--danger:hover {
  border-color: var(--wb-danger);
  background: var(--wb-danger-bg);
}
.ux-operator-btn:disabled {
  color: var(--wb-text-dim);
  cursor: default;
}
.ux-icon {
  font-size: 14px;
  display: inline-flex;
  align-items: center;
}
.ux-icon :deep(svg) {
  width: 18px;
  height: 18px;
  display: block;
}
```

Add `v-html` to the icon span in template:

```html
<span v-if="icon" class="ux-icon" v-html="icon"></span>
```

- [ ] **Step 2: UIMenu.vue — replace CSS**

Replace the `<style scoped>` block in `web/src/workbench/ux/UIMenu.vue`:

```css
.ux-menu { position: relative; }
.ux-menu-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 10px;
  border: 1px solid var(--wb-border);
  border-radius: var(--wb-radius-sm);
  background: var(--wb-bg-surface);
  color: var(--wb-accent-muted);
  cursor: pointer;
  font-size: 11px;
}
.ux-menu-btn:hover { background: var(--wb-bg-hover); }
.ux-arrow { font-size: 8px; }
.ux-menu-dropdown {
  position: absolute;
  top: 100%;
  left: 0;
  min-width: 160px;
  background: var(--wb-bg-elevated);
  border: 1px solid var(--wb-border);
  border-radius: var(--wb-radius-lg);
  z-index: 2100;
  padding: 4px;
  box-shadow: 0 8px 24px rgba(0,0,0,0.5);
}
.ux-menu-item {
  display: block;
  width: 100%;
  padding: 5px 12px;
  border: none;
  background: transparent;
  color: var(--wb-text);
  font-size: 11px;
  text-align: left;
  cursor: pointer;
  border-radius: var(--wb-radius-sm);
}
.ux-menu-item:hover { background: var(--wb-bg-hover); }
.ux-menu-label {
  display: block;
  padding: 5px 12px 3px;
  font-size: 9px;
  color: var(--wb-text-dim);
  text-transform: uppercase;
  letter-spacing: 0.5px;
}
.ux-menu-sep {
  margin: 4px 8px;
  border: none;
  border-top: 1px solid var(--wb-border);
}
```

- [ ] **Step 3: ContextMenu.vue — replace CSS**

Replace the `<style scoped>` block in `web/src/workbench/components/ContextMenu.vue`:

```css
.ctx-menu {
  position: fixed; z-index: 2000; min-width: 160px;
  padding: 4px; background: var(--wb-bg-elevated); border: 1px solid var(--wb-border);
  border-radius: var(--wb-radius-lg); box-shadow: 0 8px 24px rgba(0,0,0,0.5);
}
.ctx-item {
  display: block; width: 100%; padding: 5px 12px; border: none;
  background: transparent; color: var(--wb-text); font-size: 11px;
  text-align: left; cursor: pointer; border-radius: var(--wb-radius-sm);
}
.ctx-item:hover { background: var(--wb-bg-hover); }
.ctx-item:disabled { color: var(--wb-text-dim); cursor: default; }
.ctx-sep { height: 1px; background: var(--wb-border); margin: 4px 8px; }
```

- [ ] **Step 4: Commit**

```bash
git add web/src/workbench/ux/OperatorBtn.vue web/src/workbench/ux/UIMenu.vue web/src/workbench/components/ContextMenu.vue
git commit -m "feat: Precision Workshop buttons, menus, context menu"
```

### Task 3.3: Redesign WorkbenchSettingsDrawer

**Files:**
- Modify: `web/src/workbench/components/WorkbenchSettingsDrawer.vue`

- [ ] **Step 1: Replace CSS**

Replace the entire `<style scoped>` block:

```css
.drawer-root {
  position: fixed;
  inset: 0;
  z-index: 4000;
  display: flex;
  justify-content: flex-end;
  pointer-events: none;
}
.drawer-backdrop {
  position: absolute;
  inset: 0;
  background: rgba(2, 6, 23, 0.55);
  pointer-events: auto;
}
.drawer-panel {
  position: relative;
  width: min(420px, 100vw);
  height: 100%;
  background: var(--wb-bg-elevated);
  border-left: 1px solid var(--wb-border);
  box-shadow: -12px 0 40px rgba(0, 0, 0, 0.35);
  display: flex;
  flex-direction: column;
  pointer-events: auto;
  animation: drawer-in 0.18s ease-out;
}
@keyframes drawer-in {
  from { transform: translateX(100%); opacity: 0.9; }
  to { transform: translateX(0); opacity: 1; }
}
.drawer-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 16px;
  border-bottom: 1px solid var(--wb-border);
  flex-shrink: 0;
}
.drawer-title {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--wb-text);
}
.drawer-close {
  width: 28px; height: 28px;
  border: 1px solid var(--wb-border); border-radius: var(--wb-radius-md);
  background: var(--wb-bg-surface);
  color: var(--wb-text-muted); font-size: 16px; line-height: 1; cursor: pointer;
  display: flex; align-items: center; justify-content: center;
}
.drawer-close:hover { background: var(--wb-bg-hover); color: var(--wb-text); }
.drawer-body {
  flex: 1; overflow: auto; padding: 14px 16px 24px;
}
.drawer-section { margin-bottom: 16px; }
.drawer-h3 {
  margin: 0 0 8px; font-size: 9px; font-weight: 600; color: var(--wb-text-dim);
  text-transform: uppercase; letter-spacing: 0.8px;
}
.drawer-lead {
  margin: 0 0 10px; font-size: 11px; line-height: 1.5; color: var(--wb-text-muted);
}
.seg { display: flex; flex-wrap: wrap; gap: 6px; }
.seg__btn {
  flex: 1; min-width: 100px; padding: 8px 12px; border-radius: var(--wb-radius-md);
  border: 1px solid var(--wb-border); background: var(--wb-bg-surface);
  color: var(--wb-text-muted); font-size: 11px; font-weight: 500; cursor: pointer;
}
.seg__btn:hover { border-color: var(--wb-accent); }
.seg__btn--on {
  border-color: var(--wb-accent); background: var(--wb-bg-hover); color: var(--wb-accent);
}
.drawer-stack { display: flex; flex-direction: column; gap: 0; }
.drawer-stack :deep(.dash-card) { margin-bottom: 12px; }
.drawer-stack :deep(.dash-card:last-child) { margin-bottom: 0; }
```

- [ ] **Step 2: Commit**

```bash
git add web/src/workbench/components/WorkbenchSettingsDrawer.vue
git commit -m "feat: Precision Workshop settings drawer"
```

### Task 3.4: WorkbenchViewport — bottom dock restyle

**Files:**
- Modify: `web/src/workbench/components/WorkbenchViewport.vue:325-340`

- [ ] **Step 1: Replace bottom dock CSS**

In `web/src/workbench/components/WorkbenchViewport.vue`, replace the `<style scoped>` block:

```css
.wv-root { width: 100%; height: 100%; position: relative; display: flex; flex-direction: column; }
.wv-viewport-wrap { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.wv-bottom-dock {
  flex-shrink: 0; display: flex; flex-direction: column;
  background: var(--wb-bg-elevated); border-top: 1px solid var(--wb-border);
}
.wv-tab-row {
  display: flex; align-items: center; padding: 0 6px;
  background: var(--wb-bg-deepest); border-bottom: 1px solid var(--wb-border);
  height: 30px;
}
.wv-tab {
  padding: 0 14px; font-size: 11px; font-weight: 500;
  color: var(--wb-text-muted); background: none; border: none;
  border-bottom: 2px solid transparent; cursor: pointer; user-select: none;
  white-space: nowrap; transition: color 0.15s, border-color 0.15s;
  height: 100%; display: flex; align-items: center;
}
.wv-tab:hover { color: var(--wb-text); }
.wv-tab--active { color: var(--wb-text); border-bottom-color: var(--wb-accent); }
.wv-tab-status {
  margin-left: auto; display: flex; align-items: center; gap: 14px;
  padding: 0 10px; font-size: 10px; color: var(--wb-text-muted); flex-shrink: 0;
}
.wv-tab-stat strong { color: var(--wb-text); font-weight: 600; }
.wv-tab-panel {
  display: none; padding: 8px 12px; align-items: center; gap: 10px;
  min-height: 44px; background: var(--wb-bg-elevated);
}
.wv-tab-panel--active { display: flex; }
.wv-tab-panel :deep(.wm-wfs) { flex: 1; min-width: 0; background: transparent; border: none; padding: 0; }
.wv-tab-panel :deep(.wm-wfp-controls) { background: transparent; border: none; padding: 0; }
.wv-tab-panel :deep(.wm-layer-bar) { flex: 1; min-width: 0; background: transparent; border: none; padding: 0; }
```

- [ ] **Step 2: Commit**

```bash
git add web/src/workbench/components/WorkbenchViewport.vue
git commit -m "feat: Precision Workshop viewport dock styling"
```

---

## Phase 4: Panel Updates

### Task 4.1: Update all panel declarations

**Files:**
- Modify: `web/src/workbench/ux/panels/menuBar.ts`
- Modify: `web/src/workbench/ux/panels/annotationPanel.ts`
- Modify: `web/src/workbench/ux/panels/blockInspector.ts`
- Modify: `web/src/workbench/ux/panels/sceneInfo.ts`
- Modify: `web/src/workbench/ux/panels/transform.ts`
- Modify: `web/src/workbench/ux/panels/blockStats.ts`
- Modify: `web/src/workbench/ux/panels/wikiConfig.ts`

- [ ] **Step 1: menuBar.ts — update dropdown structure for new theme**

No structural changes needed — the menu bar layout is fine. The visual changes come from MenuBar.vue CSS (Phase 2.3).

- [ ] **Step 2: annotationPanel.ts — add compact stepper hints**

Update the renderOpacity, fillOpacity, frameThickness properties to use `uiWidget: 'stepper'` to get the new stepper controls:

In the layout items for `renderOpacity`, `fillOpacity`, `frameThickness`, add `widget: 'stepper'`:

```typescript
{ kind: 'property', rnaPath: 'annotation.renderOpacity', label: '不透明度', widget: 'stepper' },
{ kind: 'property', rnaPath: 'annotation.fillOpacity', label: '填充不透明度', widget: 'stepper' },
{ kind: 'property', rnaPath: 'annotation.frameThickness', label: '边框厚度', widget: 'stepper' },
{ kind: 'property', rnaPath: 'annotation.size', label: '大小', widget: 'stepper' },
{ kind: 'property', rnaPath: 'annotation.thickness', label: '粗细', widget: 'stepper' },
{ kind: 'property', rnaPath: 'annotation.fontSize', label: '字号', widget: 'stepper' },
{ kind: 'property', rnaPath: 'annotation.backgroundAlpha', label: '背景透明度', widget: 'stepper' },
```

- [ ] **Step 3: blockInspector.ts — no change needed**

The layout already uses standard RNA properties — they pick up the new styles automatically.

- [ ] **Step 4: Commit panel declaration updates**

```bash
git add web/src/workbench/ux/panels/
git commit -m "feat: add stepper widget hints to annotation panel properties"
```

### Task 4.2: Update remaining workbench components

**Files:**
- Modify: `web/src/workbench/components/MarkdownEditor.vue`
- Modify: `web/src/workbench/components/StatsPanel.vue`
- Modify: `web/src/workbench/components/ResourceBrowser.vue`
- Modify: `web/src/workbench/components/ExportWorkspace.vue`
- Modify: `web/src/workbench/components/WikiViewerWorkspace.vue`
- Modify: `web/src/workbench/components/WorkbenchPreviewPanel.vue`
- Modify: `web/src/workbench/components/SdeConnectionPanel.vue`
- Modify: `web/src/workbench/components/ExportsListPanel.vue`
- Modify: `web/src/workbench/components/LocalFilePanel.vue`
- Modify: `web/src/workbench/components/LocalBundlePanel.vue`

- [ ] **Step 1: Replace `--nei-*` tokens with `--wb-*` equivalents in each component**

For each component file, replace all `var(--nei-*)` references in `<style>` blocks with the equivalent `var(--wb-*)` tokens. Mapping:

| Old Token | New Token |
|-----------|-----------|
| `--nei-bg` | `--wb-bg-elevated` |
| `--nei-bg-deep` | `--wb-bg-deepest` |
| `--nei-viewport-bg` | `--wb-viewport-bg` |
| `--nei-highlight` | *(removed)* |
| `--nei-shadow` | *(removed)* |
| `--nei-inset-bg` | `--wb-bg-surface` |
| `--nei-text` | `--wb-text` |
| `--nei-text-muted` | `--wb-text-muted` |
| `--nei-text-dark` | `--wb-text` |
| `--nei-label` | `--wb-text-muted` |
| `--nei-muted` | `--wb-text-dim` |
| `--nei-border` | `--wb-border` |
| `--nei-accent` | `--wb-accent` |
| `--nei-dropdown-bg` | `--wb-bg-elevated` |
| `--nei-dropdown-hover` | `--wb-bg-hover` |
| `--nei-panel-hover` | `--wb-bg-hover` |
| `--nei-online` | `--wb-success` |
| `--nei-offline` | `--wb-text-dim` |
| `--nei-check` | `--wb-success` |
| `--nei-drawer-backdrop` | `rgba(2,6,23,0.55)` |
| `--nei-drawer-shadow` | `-12px 0 40px rgba(0,0,0,0.35)` |
| `--nei-tab-active-border` | `--wb-accent` |
| `--nei-tab-text` | `--wb-text-muted` |
| `--nei-tab-active-text` | `--wb-text` |
| `--nei-seg-off-bg` | `--wb-bg-surface` |
| `--nei-seg-off-border` | `--wb-border` |
| `--nei-seg-off-text` | `--wb-text-muted` |
| `--nei-seg-on-bg` | `--wb-bg-hover` |
| `--nei-seg-on-border` | `--wb-accent` |
| `--nei-seg-on-text` | `--wb-accent` |

Read each file, apply the substitutions, verify.

- [ ] **Step 2: Commit**

```bash
git add web/src/workbench/components/MarkdownEditor.vue web/src/workbench/components/StatsPanel.vue web/src/workbench/components/ResourceBrowser.vue web/src/workbench/components/ExportWorkspace.vue web/src/workbench/components/WikiViewerWorkspace.vue web/src/workbench/components/WorkbenchPreviewPanel.vue web/src/workbench/components/SdeConnectionPanel.vue web/src/workbench/components/ExportsListPanel.vue web/src/workbench/components/LocalFilePanel.vue web/src/workbench/components/LocalBundlePanel.vue
git commit -m "refactor: replace --nei-* tokens with --wb-* across all workbench components"
```

---

## Phase 5: Embed Viewer Unification

### Task 5.1: Update Embed components

**Files:**
- Modify: `web/src/embed/EmbedViewer.vue`
- Modify: `web/src/embed/components/ViewerCore.vue`
- Modify: `web/src/embed/components/ToolTipBox.vue`
- Modify: `web/src/embed/components/BlockStatsSidebar.vue`
- Modify: `web/src/embed/components/BlockSlotPreview.vue`
- Modify: `web/src/embed/components/LayerPreviewBar.vue`
- Modify: `web/src/embed/components/WorldFrameScrubber.vue`
- Modify: `web/src/embed/components/WorldFramePlayerControls.vue`

- [ ] **Step 1: Replace NEI tokens with WB tokens in all embed component styles**

Same token mapping as Phase 4 Task 4.2, applied to embed components. Read each file, apply the substitutions.

Additionally, for EmbedViewer's wrapper styles, apply the Precision Workshop aesthetic:
- Background: `--wb-bg-deepest`
- Borders: 1px `--wb-border`
- Font: system-ui sans-serif

- [ ] **Step 2: Update ToolTipBox.vue styles**

The tooltip already uses `--nei-tooltip-*` tokens. Replace with WB equivalents:

```css
.wm-tooltip-surface {
  background: var(--wb-bg-elevated);
  border: 1px solid var(--wb-border);
  color: var(--wb-text);
  border-radius: var(--wb-radius-md);
  box-shadow: 0 4px 12px rgba(0,0,0,0.5);
}
```

- [ ] **Step 3: ViewerCore.vue — viewport background**

In ViewerCore.vue, the 3D canvas container should use the blueprint grid background:

Locate the viewport container div and add the grid background CSS. This will likely be applied via a class that inherits from the global styles or directly inline.

- [ ] **Step 4: Commit**

```bash
git add web/src/embed/
git commit -m "feat: Precision Workshop token migration for embed viewer"
```

---

## Verification

### Verify all changes

- [ ] **Step 1: Type check**

```bash
cd web && npx vue-tsc --noEmit 2>&1 | head -30
```
Expected: No new type errors from our changes.

- [ ] **Step 2: Run tests**

```bash
cd web && npx vitest run 2>&1
```
Expected: Same results as baseline (1 known failing test).

- [ ] **Step 3: Build check**

```bash
cd web && npm run build:web 2>&1 | tail -20
```
Expected: Build succeeds.

- [ ] **Step 4: Visual check**

```bash
npm run dev:web
```
Open in browser, verify:
- Menu bar: white brand text, accent-colored menu items, green status dot with glow
- Tool shelf: SVG icons, active tool has blue border + glow
- Viewport: blueprint grid background visible
- Properties panel: stepper inputs, toggle switches, accent slider
- Frame navigation: scrubber with keyframe ticks
- Status bar: muted text on dark background
- Dark theme applied by default

- [ ] **Step 5: Final commit**

```bash
git commit -m "chore: final verification notes"
```
