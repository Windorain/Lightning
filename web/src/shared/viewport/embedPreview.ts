/**
 * Shared re-export of EmbedViewport for cross-shell consumption.
 * Prevents workbench shell from importing directly from embed/ (D4 shell trapping).
 */
export { default as EmbedPreview } from '@/embed/EmbedViewport.vue'
