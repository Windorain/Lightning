/**
 * PlainSceneDocument RNA 属性注册。
 *
 * 基于 proto 定义（lightning/v2/plain_v2.proto）注册属性描述符。
 * 覆盖核心编辑对象类型：BlockInstance, BlockPos, AnnotationBox, Label。
 */
import { globalRna } from './rnaRegistry'
import type { RnaProperty } from './rnaTypes'

function register(props: RnaProperty[]): void {
  for (const p of props) registerOne(p)
}

function registerOne(prop: RnaProperty): void {
  globalRna.register(prop)
}

// -- BlockPos --

register([
  {
    path: 'BlockPos.x',
    label: 'X',
    type: 'int',
    get: (o: unknown) => (o as Record<string, number>).x ?? 0,
    set: (o: unknown, v: unknown) => { (o as Record<string, number>).x = v as number },
  },
  {
    path: 'BlockPos.y',
    label: 'Y',
    type: 'int',
    get: (o: unknown) => (o as Record<string, number>).y ?? 0,
    set: (o: unknown, v: unknown) => { (o as Record<string, number>).y = v as number },
  },
  {
    path: 'BlockPos.z',
    label: 'Z',
    type: 'int',
    get: (o: unknown) => (o as Record<string, number>).z ?? 0,
    set: (o: unknown, v: unknown) => { (o as Record<string, number>).z = v as number },
  },
])

// -- BlockInstance --

register([
  {
    path: 'BlockInstance.block_state_id',
    label: '方块 ID',
    type: 'string',
    get: (o: unknown) => (o as Record<string, string>).block_state_id ?? '',
    set: (o: unknown, v: unknown) => { (o as Record<string, string>).block_state_id = v as string },
  },
  {
    path: 'BlockInstance.nbt',
    label: 'NBT',
    type: 'object',
    get: (o: unknown) => (o as Record<string, unknown>).nbt ?? {},
    set: (o: unknown, v: unknown) => { (o as Record<string, unknown>).nbt = v as Record<string, string> },
  },
])

// -- AnnotationBox --

register([
  {
    path: 'AnnotationBox.title',
    label: '标题',
    type: 'string',
    get: (o: unknown) => (o as Record<string, string>).title ?? '',
    set: (o: unknown, v: unknown) => { (o as Record<string, string>).title = v as string },
  },
  {
    path: 'AnnotationBox.description',
    label: '描述',
    type: 'string',
    get: (o: unknown) => (o as Record<string, string>).description ?? '',
    set: (o: unknown, v: unknown) => { (o as Record<string, string>).description = v as string },
  },
  {
    path: 'AnnotationBox.color',
    label: '颜色',
    type: 'string',
    get: (o: unknown) => (o as Record<string, string>).color ?? '#4488ff',
    set: (o: unknown, v: unknown) => { (o as Record<string, string>).color = v as string },
  },
])

// -- Label --

register([
  {
    path: 'Label.text',
    label: '文本',
    type: 'string',
    get: (o: unknown) => (o as Record<string, string>).text ?? '',
    set: (o: unknown, v: unknown) => { (o as Record<string, string>).text = v as string },
  },
  {
    path: 'Label.color',
    label: '颜色',
    type: 'string',
    get: (o: unknown) => (o as Record<string, string>).color ?? '#ffffff',
    set: (o: unknown, v: unknown) => { (o as Record<string, string>).color = v as string },
  },
  {
    path: 'Label.font_size',
    label: '字号',
    type: 'int',
    min: 8,
    max: 72,
    step: 1,
    get: (o: unknown) => (o as Record<string, number>).font_size ?? 16,
    set: (o: unknown, v: unknown) => { (o as Record<string, number>).font_size = v as number },
  },
])
