/**
 * 全局状态栏消息（模块级单例，与 useNeiTheme 同模式）。
 * 简单 Ref<string>，组件直接读写，无需 pub-sub。
 */

import { ref, type Ref } from 'vue'

const message = ref('')

export function useStatusMessage(): {
  statusMessage: Ref<string>
  setStatusMessage(msg: string): void
  clearStatusMessage(): void
} {
  function setStatusMessage(msg: string): void {
    message.value = msg
  }

  function clearStatusMessage(): void {
    message.value = ''
  }

  return {
    statusMessage: message,
    setStatusMessage,
    clearStatusMessage,
  }
}
