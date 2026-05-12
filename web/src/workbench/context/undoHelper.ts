/**
 * Undo helper — 对标 Blender 的 OPTYPE_UNDO 自动包装。
 *
 * 用 SceneSnapshot（JSON deep-clone）捕获编辑前状态，
 * 编辑后自动推入 UndoManager。撤销时恢复快照。
 */

export class SceneSnapshot {
  private captured: unknown

  constructor(scene: unknown) {
    this.captured = JSON.parse(JSON.stringify(scene))
  }

  restore(scene: { scene: { value: unknown } }): void {
    const restored = JSON.parse(JSON.stringify(this.captured))
    scene.scene.value = restored
  }
}
