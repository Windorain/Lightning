/**
 * extract.test.mjs —— 页面挂载点提取的判据
 * ============================================================================
 * 关键不是「能抓到」，而是「不抓错」：文档示例区（pre/nowiki/注释）里的调用不算
 * 嵌入，参数是 {{{参数}}} 的不猜名字，嵌套模板里的调用不能漏。
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { extractMounts, normalizeLineEndings, parseTemplateParams, stripNonRendered } from './extract.mjs'

test('直接模板调用', () => {
  const { mounts } = extractMounts('{{渲染器\n|结构名称=工业高炉四共\n|宽度=750px\n}}')
  assert.equal(mounts.length, 1)
  assert.equal(mounts[0].kind, 'template')
  assert.equal(mounts[0].name, '工业高炉四共')
  assert.equal(mounts[0].dataTitle, 'Data:Structures/工业高炉四共.json')
})

test('嵌套在其它模板参数里的调用不能漏', () => {
  const text = '{{简单折叠/内容|{{渲染器|结构名称=聚变共用一}}|id=2}}'
  const { mounts } = extractMounts(text)
  assert.deepEqual(mounts.map((m) => m.name), ['聚变共用一'])
})

test('pre / nowiki / 注释里的示例不算嵌入', () => {
  const text = [
    '<pre>{{渲染器|结构名称=示例甲}}</pre>',
    '<nowiki>{{渲染器|结构名称=示例乙}}</nowiki>',
    '<!-- {{渲染器|结构名称=示例丙}} -->',
    '<code>{{渲染器|结构名称=示例丁}}</code>',
    '{{渲染器|结构名称=真挂载}}',
  ].join('\n')
  const { mounts } = extractMounts(text)
  assert.deepEqual(mounts.map((m) => m.name), ['真挂载'])
})

test('直接写 data-wsr-structure 的 div 也能抓到', () => {
  const text = '<div class="web-structure-renderer" data-wsr-structure="PseudoBiosphere"></div>'
  const { mounts } = extractMounts(text)
  assert.equal(mounts.length, 1)
  assert.equal(mounts[0].kind, 'div')
  assert.equal(mounts[0].name, 'PseudoBiosphere')
})

test('参数名做出来的名字进 placeholders，不猜', () => {
  const text = '<div class="web-structure-renderer" data-wsr-structure="{{{结构名称}}}"></div>'
  const { mounts, placeholders } = extractMounts(text)
  assert.equal(mounts.length, 0)
  assert.equal(placeholders.length, 1)
})

test('名字带 .json 后缀与 Data 前缀都归一化', () => {
  const text = '{{渲染器|结构名称=Data:Structures/半自动核反应堆升温-envelope.json}}'
  const { mounts } = extractMounts(text)
  assert.equal(mounts[0].name, '半自动核反应堆升温-envelope')
})

test('模板参数解析：嵌套链接里的竖线不切参数', () => {
  const params = parseTemplateParams('渲染器\n|结构名称=甲\n|说明=[[页面|别名]]\n|宽度=500px')
  assert.equal(params['结构名称'], '甲')
  assert.equal(params['说明'], '[[页面|别名]]')
  assert.equal(params['宽度'], '500px')
})

test('CRLF 与 LF 提取结果一致（core.autocrlf 不参与判据）', () => {
  const lf = '{{渲染器\n|结构名称=沙盒\n}}'
  const crlf = lf.replace(/\n/g, '\r\n')
  assert.deepEqual(extractMounts(lf), extractMounts(crlf))
  assert.equal(normalizeLineEndings(crlf), lf)
  assert.equal(stripNonRendered('<pre>x</pre>Y'), 'Y')
})
