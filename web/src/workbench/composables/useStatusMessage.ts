import { ref, type Ref } from 'vue'

const _statusMessage = ref('')

export function useStatusMessage() {
  return {
    statusMessage: _statusMessage,
  } satisfies { statusMessage: Ref<string> }
}
