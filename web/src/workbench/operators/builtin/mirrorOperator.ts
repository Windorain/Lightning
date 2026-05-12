import type { OperatorType } from '@/workbench/operators/operatorType'
import type { V2PlainSceneDocument, V2BlockInstance } from '@/render/data/sceneDocumentV2'

export const MirrorOperator: OperatorType = {
  id: 'OPERATOR_MIRROR',
  label: '镜像',
  description: '沿指定轴镜像选中的方块',
  flagUndo: true,

  poll(bctx) {
    return bctx.scene.scene.value !== null && bctx.selection.items.value.size > 0
  },

  exec(bctx, props) {
    const doc = bctx.scene.scene.value as V2PlainSceneDocument | null
    if (!doc?.frames?.length) return
    const idx = bctx.selection.frameIndex.value ?? 0
    const frame = doc.frames[idx]
    if (!frame) return

    const axis = (props.axis as 'x' | 'y' | 'z') ?? 'x'
    const targets = [...bctx.selection.items.value]

    const min = { x: Infinity, y: Infinity, z: Infinity }
    const max = { x: -Infinity, y: -Infinity, z: -Infinity }
    for (const t of targets) {
      if (t.pos.x < min.x) min.x = t.pos.x; if (t.pos.y < min.y) min.y = t.pos.y; if (t.pos.z < min.z) min.z = t.pos.z
      if (t.pos.x > max.x) max.x = t.pos.x; if (t.pos.y > max.y) max.y = t.pos.y; if (t.pos.z > max.z) max.z = t.pos.z
    }
    const center = { x: Math.round((min.x + max.x) / 2), y: Math.round((min.y + max.y) / 2), z: Math.round((min.z + max.z) / 2) }

    const targetKeys = new Set(targets.map(t => `${t.pos.x},${t.pos.y},${t.pos.z}`))
    const originalBlocks = frame.blocks.filter(b => targetKeys.has(`${b.pos.x},${b.pos.y},${b.pos.z}`))
    const newBlocks: V2BlockInstance[] = []

    for (const b of originalBlocks) {
      const mirrored: V2BlockInstance = {
        pos: { ...b.pos },
        block_state_id: b.block_state_id,
        nbt: b.nbt ? { ...b.nbt } : undefined,
        parts: b.parts?.map(p => ({ ...p, local_id: p.local_id + '_mirror' })),
      }
      if (axis === 'x') mirrored.pos.x = center.x * 2 - mirrored.pos.x
      if (axis === 'y') mirrored.pos.y = center.y * 2 - mirrored.pos.y
      if (axis === 'z') mirrored.pos.z = center.z * 2 - mirrored.pos.z
      newBlocks.push(mirrored)
    }

    frame.blocks.push(...newBlocks)
    bctx.scene.markDirty()
  },
}
