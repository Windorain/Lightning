<script setup lang="ts">
import { computed } from 'vue'
import { sdeGetWorkspaceDocument } from '@/workbench/sdeApi'
import { useContext } from '@/runtime/context'
const ctx = useContext()

const connectionOk = computed(() => ctx.connection.connected)
const connectionMessageText = computed(() => ctx.log.statusMessage)
const showConnectionHint = computed(() => ctx.connection.connected !== null)

async function onConnect(): Promise<void> {
  await ctx.operators.exec('OPERATOR_SDE_CONNECT')
  if (!ctx.connection.connected) return

  const data = await sdeGetWorkspaceDocument(ctx.connection.apiBase, ctx.connection.token)
  if (!data || Object.keys(data as Record<string, unknown>).length === 0) return

  await ctx.operators.exec('OPERATOR_SDE_LOAD_WORKSPACE', { data })
}
</script>

<template>
  <section class="dash-card">
    <h2 class="dash-card__title">连接 SDE Web</h2>
    <p class="dash-card__desc">填写游戏内 <code class="dash-code">/sde web</code> 打印的地址与 Token，与 <code class="dash-code">structure_exports</code> 目录同步。</p>
    <label class="dash-field">
      <span class="dash-field__label">API 基址</span>
      <input v-model="ctx.connection.apiBase" class="dash-input" type="text" autocomplete="off" placeholder="http://127.0.0.1:37564" />
    </label>
    <label class="dash-field">
      <span class="dash-field__label">Token</span>
      <input v-model="ctx.connection.token" class="dash-input" type="password" autocomplete="off" placeholder="Bearer" />
    </label>
    <div class="dash-row">
      <button type="button" class="dash-btn dash-btn--primary" @click="onConnect">连接并刷新</button>
      <span
        v-if="showConnectionHint"
        class="dash-hint"
        :class="{ 'dash-hint--ok': connectionOk, 'dash-hint--err': connectionOk === false }"
      >
        {{ connectionMessageText }}
      </span>
    </div>
  </section>
</template>

<style scoped>
.dash-card {
  padding: 16px;
  border: 1px solid var(--wb-border);
  border-radius: 10px;
  background: var(--wb-bg-deepest);
  margin-bottom: 14px;
}
.dash-card__title {
  margin: 0 0 8px;
  font-size: 14px;
  font-weight: 600;
  color: var(--wb-text);
}
.dash-card__desc {
  margin: 0 0 14px;
  font-size: 12px;
  line-height: 1.5;
  color: var(--wb-text-muted);
}
.dash-code {
  font-size: 11px;
  padding: 1px 6px;
  border-radius: 4px;
  background: var(--wb-bg-elevated);
  color: var(--wb-text);
}
.dash-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 10px;
}
.dash-field__label {
  font-size: 11px;
  color: var(--wb-text-muted);
}
.dash-input {
  padding: 8px 10px;
  border-radius: 8px;
  border: 1px solid var(--wb-bg-hover);
  background: var(--wb-bg-elevated);
  color: var(--wb-text);
  font-size: 13px;
}
.dash-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-top: 4px;
}
.dash-btn {
  padding: 8px 16px;
  border-radius: 8px;
  border: 1px solid var(--wb-text-dim);
  background: var(--wb-border);
  color: var(--wb-text);
  cursor: pointer;
  font-size: 13px;
}
.dash-btn--primary {
  background: var(--wb-accent);
  border-color: var(--wb-accent);
}
.dash-btn:hover {
  filter: brightness(1.06);
}
.dash-hint {
  font-size: 12px;
  color: var(--wb-text-muted);
}
.dash-hint--ok {
  color: var(--wb-success);
}
.dash-hint--err {
  color: var(--wb-text);
}
</style>
