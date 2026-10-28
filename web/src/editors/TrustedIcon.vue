<script setup lang="ts">
/**
 * TrustedIcon —— **可信编译期图标**的唯一消费者。
 *
 * ## 为什么这里可以有 `v-html`
 *
 * "可信图标使用专门来源，不能把『支持图标 HTML』升级为外部内容注入通道"。
 * 本组件是这句话的落地形态：
 *
 * - prop 类型是**品牌类型** `TrustedIconTemplate`（`domain/trustedIcon.ts`），
 *   只能由 `trustedIcon(key, state)` 产出，而后者只认模块内登记的键。
 *   ⇒ 调用方**无法**传一个任意字符串进来：类型系统要求品牌字段，
 *   而品牌字段只能由可信构造口填写。
 * - 因此本处 `v-html` 的输入是**编译期常量派生值**，不是外部内容。
 *
 * ## 这是全仓唯一保留的 `v-html`
 *
 * 外部文本的 6 条直通路径都已收编到 `editors/ContentText.vue`（受控呈现边界）。
 * 本文件之所以保留 `v-html`，是因为内联 SVG **必须**经标记注入才能渲染
 * （Vue 没有"渲染 SVG 字符串"的安全 API）。把这条唯一的例外隔离在一个
 * 只接受品牌类型的组件里，比"每个组件各自 `v-html`"可控得多：
 * 审查面从 6 处调用点收敛为 1 个组件 + 1 个类型定义。
 *
 * 由 `tests/architecture/` 的 `content-boundary-gate` 规则静态钉住：
 * 生产代码里 `v-html`/`innerHTML` 的出现位置必须**恰好**在这个白名单内。
 */
import { computed } from 'vue'
import { isTrustedIconTemplate, type TrustedIconTemplate } from '@/domain/trustedIcon'

const props = defineProps<{
  /** 可信图标模板（品牌类型；见 `domain/trustedIcon.ts`）。 */
  icon: TrustedIconTemplate
}>()

/**
 * 二次防线：即使类型在运行时被绕过（`as any`、JSON 反序列化等），
 * 也**拒绝渲染**非品牌对象。宁可图标不显示，也不把字符串当标记注入。
 */
const markup = computed(() => (isTrustedIconTemplate(props.icon) ? props.icon.markup : ''))
</script>

<template>
  <!-- eslint-disable-next-line vue/no-v-html -- 输入是品牌类型 TrustedIconTemplate，非外部文本 -->
  <span class="lk-icon" v-html="markup" />
</template>

<style scoped>
.lk-icon {
  display: inline-flex;
  align-items: center;
}
.lk-icon :deep(svg) {
  width: 18px;
  height: 18px;
  display: block;
}
</style>
