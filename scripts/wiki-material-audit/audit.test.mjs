/**
 * audit.test.mjs —— 整条命令的离线端到端判据（本地假 MediaWiki，不碰真站）
 * ============================================================================
 * 为什么值得写：判型函数各自绿，不代表「一条命令跑完能产出报告」。这里用 node:http
 * 起一个只会 query 的假站点，喂给 runAudit 一份含 #87 命中的最小数据集，断言：
 *   - 命令真的枚举到了 Data 页与嵌入页；
 *   - 报告 JSON/Markdown 都落盘，读数与命中的页面/结构对得上；
 *   - 分片页标题用空格时，能审出来但必须如实标注「客户端命名对不上」。
 * 全程离线，请求间隔设 0（假站点不是别人的生产环境）。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

import { runAudit } from './audit.mjs'
import { WikiClient } from './wiki.mjs'
import {
  gridWith,
  makeBlock,
  makeDocument,
  makeEnvelope,
  makeMaterial,
  makeMultipart,
  placeholder16,
  pngBase64,
} from './fixtures.mjs'

function structureDoc() {
  return makeDocument({
    blobs: [pngBase64(placeholder16())],
    materials: [makeMaterial('minecraft:stone', 0)],
    blocks: [makeBlock('minecraft:stone', [0])],
    grid: gridWith([0]),
  })
}

function startMockServer(pages) {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost')
    const query = url.searchParams
    const json = (body) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify(body))
    }

    if (query.get('meta') === 'siteinfo') {
      return json({
        query: {
          general: { sitename: '假灰机' },
          namespaces: {
            0: { id: 0, '*': '' },
            10: { id: 10, '*': '模板' },
            3500: { id: 3500, '*': 'Data' },
          },
        },
      })
    }
    if (query.get('list') === 'allpages') {
      const prefix = query.get('apprefix') || ''
      const ns = Number(query.get('apnamespace'))
      const allpages = [...pages.keys()]
        .filter((title) => title.startsWith('Data:') === (ns === 3500))
        .filter((title) => (prefix ? title.startsWith('Data:' + prefix) : true))
        .map((title) => ({ title, ns }))
      return json({ query: { allpages } })
    }
    if (query.get('list') === 'embeddedin') {
      return json({
        query: { embeddedin: [...pages.keys()].filter((title) => !title.startsWith('Data:')).map((title) => ({ title, ns: 0 })) },
      })
    }
    if (query.get('list') === 'search') return json({ query: { search: [] } })

    if (query.get('prop') === 'revisions') {
      const titles = String(query.get('titles') || '').split('|').filter(Boolean)
      const out = titles.map((title) => {
        const content = pages.get(title)
        if (content == null) return { title, missing: true }
        return {
          title,
          ns: title.startsWith('Data:') ? 3500 : 0,
          revisions: [{ size: content.length, slots: { main: { contentmodel: 'wikitext', content } } }],
        }
      })
      return json({ query: { pages: out } })
    }
    if (query.get('generator') === 'allpages') {
      return json({ query: { pages: [] } })
    }
    response.writeHead(400, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ error: { code: 'mock-unhandled', info: String(request.url) } }))
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)))
}

async function withServer(pages, fn) {
  const server = await startMockServer(pages)
  const port = server.address().port
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-audit-'))
  try {
    const client = new WikiClient({ base: 'http://127.0.0.1:' + port + '/api.php', authkey: 'test', minInterval: 0 })
    const code = await runAudit(
      { out: outDir, pages: [], limit: null, minInterval: 0, sweep: false, verbose: false },
      client,
    )
    return { code, outDir, json: readJson(path.join(outDir, 'wiki-material-audit.json')), markdown: fs.readFileSync(path.join(outDir, 'wiki-material-audit.md'), 'utf8') }
  } finally {
    server.close()
    fs.rmSync(outDir, { recursive: true, force: true })
  }
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

test('端到端：#87 命中页面写进 JSON 与 Markdown', async () => {
  const pages = new Map([
    ['Data:Structures/测试结构.json', makeEnvelope(structureDoc(), { label: '测试结构' })],
    ['测试页', '{{渲染器\n|结构名称=测试结构\n|宽度=500px\n}}'],
  ])
  const { code, json, markdown } = await withServer(pages, (x) => x)
  assert.equal(code, 0)
  assert.equal(json.summary.pagesWithMounts, 1)
  assert.equal(json.summary.pagesBad, 1)
  assert.equal(json.summary.hits87, 1)
  assert.equal(json.structures.length, 1)
  assert.equal(json.structures[0].status, 'bad')
  assert.equal(json.structures[0].badBlobs[0].usedInGrid, true)
  assert.match(markdown, /测试页/)
  assert.match(markdown, /#87/)
  assert.ok(!markdown.includes('\r'), 'Markdown 必须是 LF')
})

test('端到端：分片标题与客户端约定不同名时，退让到站内实际命名仍能审出', async () => {
  const doc = structureDoc()
  const { index, parts } = makeMultipart({ base: '多分片', docs: [doc, doc] })
  const pages = new Map([
    ['Data:Structures/多分片.json', JSON.stringify(index)],
    ['Data:Structures/多分片 01.json', JSON.stringify(parts[0])],
    ['Data:Structures/多分片 02.json', JSON.stringify(parts[1])],
    ['分片页', '{{渲染器|结构名称=多分片}}'],
  ])
  const { json } = await withServer(pages, (x) => x)
  const structure = json.structures.find((row) => row.name === '多分片')
  assert.ok(structure)
  assert.equal(structure.status, 'bad')
  assert.equal(json.summary.hits87, 1)
})

test('端到端：结构页缺失时页面记 unresolved，不静默跳过', async () => {
  const pages = new Map([['坏页面', '{{渲染器|结构名称=并不存在的结构}}']])
  const { code, json } = await withServer(pages, (x) => x)
  assert.equal(code, 2)
  assert.equal(json.summary.pagesUnresolved, 1)
  assert.ok(json.gaps.some((gap) => gap.kind === 'structure-unresolved'))
})
