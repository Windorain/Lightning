import type { OperatorType } from '@/workbench/operators/operatorType'

function pickFile(): Promise<File | undefined> {
  return new Promise(resolve => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.json'
    input.onchange = () => {
      cleanup()
      resolve(input.files?.[0])
    }
    const onFocus = () => {
      // Dialog closed; if no file was selected, treat as cancel
      setTimeout(() => {
        if (!input.files?.length) {
          cleanup()
          resolve(undefined)
        }
      }, 300)
    }
    const cleanup = () => window.removeEventListener('focus', onFocus)
    window.addEventListener('focus', onFocus)
    input.click()
  })
}

export const NewSceneOperator: OperatorType = {
  id: 'OPERATOR_NEW_SCENE',
  label: '新建场景',
  description: '创建空白新场景',

  poll(_bctx) {
    return true
  },

  async exec(bctx, _props) {
    if (bctx.scene.dirty.value) {
      const confirmFn = bctx.settings.confirmDirty ?? window.confirm
      const ok = confirmFn('当前场景有未保存的修改，是否保存？')
      if (ok) {
        await bctx.operators.exec('OPERATOR_SAVE_FILE')
      }
    }
    bctx.selection.clear()
    bctx.editHistory.clear()
    await bctx.scene.newScene()
  },
}

export const OpenSceneOperator: OperatorType = {
  id: 'OPERATOR_OPEN_SCENE',
  label: '打开场景',
  description: '从文件加载场景',

  poll(_bctx) {
    return true
  },

  async exec(bctx, _props) {
    let file = _props.file as File | undefined
    if (!file) {
      file = await pickFile()
      if (!file) return
    }
    if (bctx.scene.dirty.value) {
      const confirmFn = bctx.settings.confirmDirty ?? window.confirm
      const ok = confirmFn('当前场景有未保存的修改，是否保存？')
      if (ok) {
        await bctx.operators.exec('OPERATOR_SAVE_FILE')
      }
    }
    bctx.selection.clear()
    bctx.editHistory.clear()
    await bctx.scene.loadSceneFromFile(file)
  },
}

export const SaveFileOperator: OperatorType = {
  id: 'OPERATOR_SAVE_FILE',
  label: '保存到文件',
  description: '将当前场景保存到本地文件',

  poll(bctx) {
    return bctx.scene.scene.value !== null
  },

  async exec(bctx, _props) {
    await bctx.scene.saveToFile()
  },
}

export const LoadBuiltinSceneOperator: OperatorType = {
  id: 'OPERATOR_LOAD_BUILTIN',
  label: '加载内置示例',
  description: '加载内置示例场景',

  poll(_bctx) {
    return true
  },

  async exec(bctx, _props) {
    const sceneId = _props.sceneId as string | undefined
    bctx.selection.clear()
    bctx.editHistory.clear()
    await bctx.scene.loadBuiltinScene(sceneId)
  },
}
