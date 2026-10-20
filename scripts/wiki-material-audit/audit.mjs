#!/usr/bin/env node
/**
 * audit.mjs —— GTNH 灰机 Wiki「页面嵌入的结构里有没有坏材质」一条命令清点
 * ============================================================================
 *
 * 用法：
 *   $env:HUIJI_AUTHKEY = "..."          # 见 resources/secrets/huiji-wiki.env，禁止入库
 *   node scripts/wiki-material-audit/audit.mjs [--out <dir>] [--limit N] [--page <标题>]
 *                                              [--min-interval <ms>] [--no-sweep] [--verbose]
 *
 * 它做什么（只读，一次跑完）：
 *   1. 枚举结构数据页：Data:Structures/*.json（allpages + apprefix）；
 *   2. 枚举嵌入页：template links（Template:渲染器）∪ 全站文章命名空间正文扫描
 *      ∪ insource 搜索补漏（直接写 data-wsr-structure 的页面）；
 *   3. 逐页解析 wikitext，抽出 {{渲染器|结构名称=...}} 与 data-wsr-structure；
 *   4. 逐结构取 Data 页、解 Envelope（含分片）、按 #87 / #9 判据扫 textureBlobs；
 *   5. 输出 JSON（机读）+ Markdown（人读），默认落在脚本目录的 .out/（已 gitignore）。
 *
 * 退出码：0 = 跑完（无论有没有命中）；1 = 参数/前置错误（例如没给 HUIJI_AUTHKEY）；
 *         2 = 跑完但有页面/结构无法判定（缺口见报告）。
 */

import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { WikiClient, WikiError } from './wiki.mjs'
import {
  decodeEnvelope,
  isMultipartIndex,
  mergeMultipart,
  multipartPartTitleCandidates,
  normalizeStructureBase,
  parseJsonDocument,
  titleKey,
} from './envelope.mjs'
import { extractMounts, mightMount } from './extract.mjs'
import { auditDocument } from './detect.mjs'
import { writeReports } from './report.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_OUT = path.join(HERE, '.out')

const USAGE = [
  '用法: node scripts/wiki-material-audit/audit.mjs [选项]',
  '',
  '选项:',
  '  --out <dir>           报告输出目录（默认 scripts/wiki-material-audit/.out，已 gitignore）',
  '  --page <标题>         只审计指定页面（可重复；调试用）',
  '  --limit <n>           最多审计 n 个结构数据页（调试用）',
  '  --min-interval <ms>   相邻请求最小间隔，默认 1000；不允许小于 1000',
  '  --no-sweep            跳过文章命名空间全量正文扫描（只靠 template links + 搜索）',
  '  --verbose             打印每次命中/判型的中间读数',
  '  --help                显示本帮助',
  '',
  '环境变量:',
  '  HUIJI_AUTHKEY  必填。灰机共享 key；缺省时站点会用 Cloudflare 挑战页回 403。',
  '  HUIJI_API_BASE 选填，默认 https://gtnh.huijiwiki.com/api.php',
].join('\n')

function parseArgs(argv) {
  const options = {
    out: DEFAULT_OUT,
    pages: [],
    limit: null,
    minInterval: 1000,
    sweep: true,
    verbose: false,
    help: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') options.help = true
    else if (arg === '--out') options.out = path.resolve(argv[++i])
    else if (arg === '--page') options.pages.push(argv[++i])
    else if (arg === '--limit') options.limit = Number.parseInt(argv[++i], 10)
    else if (arg === '--min-interval') options.minInterval = Number.parseInt(argv[++i], 10)
    else if (arg === '--no-sweep') options.sweep = false
    else if (arg === '--verbose') options.verbose = true
    else throw new Error('未知参数：' + arg)
  }
  if (options.limit != null && (!Number.isInteger(options.limit) || options.limit <= 0)) {
    throw new Error('--limit 必须是正整数')
  }
  if (!Number.isFinite(options.minInterval) || options.minInterval < 1000) {
    throw new Error('--min-interval 不允许小于 1000ms（礼貌爬取下限）')
  }
  return options
}

function log(message = '') {
  process.stderr.write(message + '\n')
}

export async function runAudit(options, client) {
  const started = Date.now()
  const gaps = []
  const warnings = []

  log('== 站点 ==')
  const siteinfo = await client.siteinfo()
  const siteName = (siteinfo.general && siteinfo.general.sitename) || 'gtnh.huijiwiki.com'
  const namespaces = siteinfo.namespaces || {}
  const dataNs = findNamespace(namespaces, 'Data')
  if (dataNs == null) throw new Error('站点没有 Data 命名空间，实验前提不成立')
  const templateNs = findNamespace(namespaces, '模板') ?? findNamespace(namespaces, 'Template')
  log('  ' + siteName + ' / API ' + client.base + ' / Data ns=' + dataNs)

  // ---- 1. 结构数据页清单 -------------------------------------------------
  log('== 枚举结构数据页 ==')
  const structurePages = (await client.listAllPages(dataNs, 'Structures/')).filter((page) =>
    /^Data:Structures\/.+\.json$/i.test(page.title),
  )
  log('  Data:Structures/*.json 共 ' + structurePages.length + ' 页')
  gaps.push({
    kind: 'enumeration',
    detail: '结构数据页只用 allpages(apprefix=Structures/) 枚举；Data 命名空间下不在该前缀下的结构不会被本工具发现。',
  })

  // ---- 2. 页面清单 -------------------------------------------------------
  log('== 枚举嵌入页 ==')
  const pageCache = new Map() // title -> { title, ns, text, sources:Set }
  const addCandidate = (page, source) => {
    const key = page.title
    const entry = pageCache.get(key) || { title: key, ns: page.ns, text: null, sources: new Set() }
    entry.sources.add(source)
    pageCache.set(key, entry)
  }

  if (options.pages.length) {
    for (const title of options.pages) addCandidate({ title, ns: null }, 'explicit')
    log('  --page 指定 ' + options.pages.length + ' 页')
  } else {
    const templateTitle = pickTemplateTitle(namespaces, templateNs)
    const embedded = await client.listEmbeddedIn(templateTitle)
    for (const page of embedded) addCandidate(page, 'template-links')
    log('  ' + templateTitle + ' 反链（embeddedin）' + embedded.length + ' 页')

    const searchHits = await client.search('insource:"data-wsr-structure"', 50)
    for (const hit of searchHits) addCandidate(hit, 'search:insource')
    log('  insource:data-wsr-structure 搜索 ' + searchHits.length + ' 页')

    if (options.sweep) {
      log('  扫描文章命名空间正文（只保留含渲染器字样的页面）...')
      let scanned = 0
      let kept = 0
      for await (const page of client.sweepNamespace(0, 30)) {
        scanned++
        if (page.contentModel && page.contentModel !== 'wikitext') continue
        if (mightMount(page.text)) {
          kept++
          const entry = pageCache.get(page.title)
          if (entry) {
            entry.ns = page.ns
            entry.text = page.text
          } else {
            pageCache.set(page.title, { title: page.title, ns: page.ns, text: page.text, sources: new Set(['article-sweep']) })
          }
        }
        if (scanned % 300 === 0) log('    ...已扫描 ' + scanned + ' 页，命中 ' + kept + ' 页')
      }
      log('  文章命名空间共扫描 ' + scanned + ' 页，含渲染器字样 ' + kept + ' 页')
      gaps.push({
        kind: 'enumeration',
        detail:
          '全量正文扫描只覆盖文章命名空间（ns=0）' +
          scanned +
          ' 页；其它命名空间（Project/Mod/模板/零件等）由 template links + insource 搜索覆盖。' +
          '若某页在其它命名空间里直接写 <div class="web-structure-renderer"> 且未被搜索索引，本工具不会发现。',
      })
    } else {
      warnings.push('已按 --no-sweep 跳过文章命名空间全量扫描，覆盖不完整。')
    }
  }

  // 补齐 candidate 的正文（batched）
  const needFetch = [...pageCache.values()].filter((entry) => entry.text == null).map((entry) => entry.title)
  if (needFetch.length) {
    log('  补取 ' + needFetch.length + ' 页正文...')
    const { pages, missing } = await client.getPages(needFetch)
    for (const title of needFetch) {
      const entry = pageCache.get(title)
      if (pages.has(title)) {
        const page = pages.get(title)
        if (page.contentModel && page.contentModel !== 'wikitext') {
          entry.skipReason = 'contentmodel=' + page.contentModel
          continue
        }
        entry.text = page.text
        entry.ns = page.ns
      } else {
        entry.missing = true
        gaps.push({ kind: 'page-missing', detail: '页面取不到正文：' + title + (missing.includes(title) ? '（API 报 missing）' : '') })
      }
    }
  }

  // ---- 3. 抽取挂载点 -----------------------------------------------------
  log('== 解析页面挂载点 ==')
  const pages = []
  const referenced = new Map() // key(titleKey) -> {name, titles:Set, mounts:[]}
  for (const entry of pageCache.values()) {
    if (entry.text == null) continue
    const { mounts, placeholders } = extractMounts(entry.text)
    for (const holder of mounts) {
      const key = titleKey(holder.dataTitle)
      const record = referenced.get(key) || { key, name: holder.name, dataTitle: holder.dataTitle, pages: new Set(), mounts: 0 }
      record.pages.add(entry.title)
      record.mounts++
      referenced.set(key, record)
    }
    pages.push({
      title: entry.title,
      ns: entry.ns,
      sources: [...entry.sources].sort(),
      placeholders,
      mounts,
    })
  }
  const pagesWithMounts = pages.filter((page) => page.mounts.length > 0)
  log('  ' + pages.length + ' 页有正文，其中 ' + pagesWithMounts.length + ' 页含挂载点，共 ' +
    pagesWithMounts.reduce((sum, page) => sum + page.mounts.length, 0) + ' 个挂载')

  // ---- 4. 审计结构 -------------------------------------------------------
  const structureAudits = new Map() // titleKey -> audit record
  const auditCache = new Map() // title -> decoded doc
  let auditedCount = 0
  const plan = [...referenced.values()].sort((a, b) => a.name.localeCompare(b.name))
  const limited = options.limit != null ? plan.slice(0, options.limit) : plan
  log('== 审计结构（' + limited.length + ' 个被引用结构）==')

  for (const item of limited) {
    auditedCount++
    const prefix = '  [' + auditedCount + '/' + limited.length + '] ' + item.name
    let record
    try {
      const loaded = await loadStructure(client, item.dataTitle, auditCache, options)
      record = auditLoaded(item, loaded)
      if (record.status === 'bad') log(prefix + ' => 命中 ' + record.hits87 + ' 个 #87 / ' + record.hits9 + ' 个 #9')
      else if (record.unclassifiedCount) log(prefix + ' => 未判型 ' + record.unclassifiedCount + ' 条')
      else log(prefix + ' => ok')
    } catch (error) {
      record = {
        title: item.dataTitle,
        name: item.name,
        status: 'unresolved',
        error: error instanceof Error ? error.message : String(error),
        code: error && error.code ? error.code : null,
        badBlobs: [],
        unclassified: [],
        hits87: 0,
        hits9: 0,
        unclassifiedCount: 0,
      }
      log(prefix + ' => 未解析：' + record.error)
      gaps.push({ kind: 'structure-unresolved', detail: item.dataTitle + '：' + record.error })
    }
    structureAudits.set(item.key, record)
  }

  // ---- 5. 页面/结构状态归并 ----------------------------------------------
  const pageRows = pages.map((page) => {
    const resolved = []
    for (const mount of page.mounts) {
      const audit = structureAudits.get(titleKey(mount.dataTitle))
      resolved.push({
        ...mount,
        structureStatus: audit ? audit.status : 'unaudited',
        structureTitle: audit ? audit.title : mount.dataTitle,
      })
    }
    const statuses = resolved.map((m) => m.structureStatus)
    let status = 'ok'
    if (statuses.includes('bad')) status = 'bad'
    else if (statuses.includes('unresolved') || statuses.includes('error')) status = 'unresolved'
    else if (statuses.includes('warn')) status = 'warn'
    else if (statuses.includes('unaudited')) status = 'unaudited'
    return {
      title: page.title,
      ns: page.ns,
      sources: page.sources,
      status,
      placeholders: page.placeholders,
      mounts: resolved,
    }
  })

  const badPages = pageRows.filter((page) => page.status === 'bad')
  const unresolvedPages = pageRows.filter((page) => page.status === 'unresolved')
  const structureRows = [...structureAudits.values()]

  const summary = {
    pagesScanned: pages.length,
    pagesWithMounts: pagesWithMounts.length,
    mounts: pagesWithMounts.reduce((sum, page) => sum + page.mounts.length, 0),
    pagesBad: badPages.length,
    pagesWarn: pageRows.filter((page) => page.status === 'warn').length,
    pagesUnresolved: unresolvedPages.length,
    structuresReferenced: referenced.size,
    structuresAudited: structureRows.length,
    structuresBad: structureRows.filter((row) => row.status === 'bad').length,
    structuresWarn: structureRows.filter((row) => row.status === 'warn').length,
    structuresUnresolved: structureRows.filter((row) => row.status === 'unresolved').length,
    structuresUnclassified: structureRows.filter((row) => row.unclassifiedCount > 0).length,
    hits87: structureRows.reduce((sum, row) => sum + (row.hits87 || 0), 0),
    hits9: structureRows.reduce((sum, row) => sum + (row.hits9 || 0), 0),
    unclassified: structureRows.reduce((sum, row) => sum + (row.unclassifiedCount || 0), 0),
    unreferencedStructurePages: Math.max(0, structurePages.length - referenced.size),
  }

  const result = {
    tool: 'wiki-material-audit',
    version: 1,
    generatedAt: new Date().toISOString(),
    durationMs: Date.now() - started,
    requests: client.requestCount,
    api: client.base,
    site: siteName,
    criteria: {
      placeholder87: '#87：16x16、颜色数<=4、洋红占比>10%、纯黑占比>10%',
      strip9: '#9：384x32 或 192x32 横向带 + IC2 系 locator（ic2: / ic2/）',
      unclassified: '其它可疑形状（非 IC2 横向带、未达 #87 门槛的占位图样、解码失败）如实列在未判型',
    },
    enumeration: {
      structurePages: structurePages.length,
      articleSweep: options.sweep && !options.pages.length,
      candidatePages: pages.length,
      pagesWithMounts: pagesWithMounts.length,
      referencedStructures: referenced.size,
    },
    summary,
    pages: pageRows.sort((a, b) => a.title.localeCompare(b.title, 'zh')),
    structures: structureRows.sort((a, b) => String(a.name).localeCompare(String(b.name), 'zh')),
    gaps,
    warnings,
  }

  const paths = writeReports(result, options.out)
  log('== 完成 ==')
  log('  JSON: ' + paths.json)
  log('  MD:   ' + paths.markdown)
  log('  读数: 页面 ' + summary.pagesWithMounts + ' 嵌入 / 命中 ' + summary.pagesBad +
    ' 页；结构 ' + summary.structuresAudited + ' 审计 / #87 ' + summary.hits87 +
    ' / #9 ' + summary.hits9 + ' / 未判型 ' + summary.unclassified)
  return summary.structuresUnresolved || summary.pagesUnresolved ? 2 : 0
}

function findNamespace(namespaces, name) {
  for (const [id, value] of Object.entries(namespaces || {})) {
    const label = value && (value['*'] != null ? value['*'] : value.name)
    if (label === name) return Number(id)
  }
  return null
}

function pickTemplateTitle(namespaces, templateNs) {
  const label = (namespaces[String(templateNs)] && namespaces[String(templateNs)]['*']) || '模板'
  return label + ':渲染器'
}

/**
 * 取一个结构：普通 Envelope 直接解；分片索引按 part 拼装。
 * 分片优先用客户端约定的 base_NN，再退让到站内实际出现的 base NN。
 */
async function loadStructure(client, dataTitle, cache, options) {
  if (cache.has(dataTitle)) return cache.get(dataTitle)
  const { pages, missing } = await client.getPages([dataTitle])
  if (!pages.has(dataTitle)) {
    const error = new WikiError('Data 页不存在：' + dataTitle, 'STRUCTURE-MISSING')
    error.detail = missing
    throw error
  }
  const text = pages.get(dataTitle).text
  const parsed = parseJsonDocument(text)

  let loaded
  if (isMultipartIndex(parsed)) {
    const base = normalizeStructureBase(parsed.base || dataTitle)
    const partDocs = []
    const usedTitles = []
    for (let part = 1; part <= parsed.partCount; part++) {
      let found = null
      for (const candidate of multipartPartTitleCandidates(parsed, base, part)) {
        const partResult = await client.getPages([candidate])
        if (partResult.pages.has(candidate)) {
          found = parseJsonDocument(partResult.pages.get(candidate).text)
          usedTitles.push(candidate)
          break
        }
      }
      if (!found) throw new WikiError('分片缺失：' + base + ' part ' + part, 'PART-MISSING')
      partDocs.push(found)
    }
    const merged = mergeMultipart(parsed, partDocs)
    const decoded = decodeEnvelope(merged)
    loaded = {
      title: dataTitle,
      documentFormat: 'Envelope/multipart',
      meta: decoded.meta,
      doc: decoded.doc,
      partTitles: usedTitles,
    }
  } else {
    const decoded = decodeEnvelope(parsed)
    loaded = {
      title: dataTitle,
      documentFormat: decoded.documentFormat,
      meta: decoded.meta,
      doc: decoded.doc,
    }
  }
  cache.set(dataTitle, loaded)
  return loaded
}

function auditLoaded(item, loaded) {
  const audit = auditDocument(loaded.doc)
  return {
    title: loaded.title,
    name: item.name,
    status: audit.status,
    documentFormat: loaded.documentFormat,
    meta: {
      id: loaded.meta && loaded.meta.id,
      label: loaded.meta && loaded.meta.label,
      author: loaded.meta && loaded.meta.author,
      gtnhVersion: loaded.meta && loaded.meta.gtnhVersion,
    },
    frameCount: audit.frameCount,
    blobCount: audit.blobCount,
    materialCount: audit.materialCount,
    blockCount: audit.blockCount,
    hits87: audit.hits87,
    hits9: audit.hits9,
    unclassifiedCount: audit.unclassifiedCount,
    decodeErrorCount: audit.decodeErrorCount,
    badBlobs: audit.badBlobs,
    unclassified: audit.unclassified,
    usedByPages: [...item.pages],
    mountCount: item.mounts,
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    process.stdout.write(USAGE + '\n')
    return 0
  }

  const authkey = process.env.HUIJI_AUTHKEY || ''
  if (!authkey) {
    log('缺少 HUIJI_AUTHKEY。')
    log('站点由 Cloudflare 托管，匿名请求会被挑战页拦下（HTTP 403）。')
    log('请从 resources/secrets/huiji-wiki.env 取值后设置环境变量，例如：')
    log('  $env:HUIJI_AUTHKEY = "..."')
    return 1
  }

  const client = new WikiClient({
    base: process.env.HUIJI_API_BASE || undefined,
    authkey,
    minInterval: options.minInterval,
    log,
  })
  return runAudit(options, client)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
    .then((code) => {
      process.exitCode = code
    })
    .catch((error) => {
      log('')
      log('失败：' + (error instanceof Error ? error.message : String(error)))
      if (error && error.detail) log('详情：' + JSON.stringify(error.detail).slice(0, 800))
      log(USAGE)
      process.exitCode = 1
    })
}