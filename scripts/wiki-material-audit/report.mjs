/**
 * report.mjs —— 把审计结果写成 JSON（机读）与 Markdown（人读）
 * ============================================================================
 *
 * 两个文件同名不同后缀，落在 --out 目录（默认 scripts/wiki-material-audit/.out/）。
 * JSON 是完整事实（含每个坏 blob 的读数与引用方块）；Markdown 只做人类判读需要的
 * 汇总与明细，避免把几百 KB 的物料清单塞进 PR/日报。
 *
 * CRLF 纪律：写盘前统一成 LF，读取方（测试/CI）也按 LF 断言，不受 core.autocrlf 影响。
 */

import fs from 'node:fs'
import path from 'node:path'

export function writeReports(result, outDir) {
  fs.mkdirSync(outDir, { recursive: true })
  const base = path.join(outDir, 'wiki-material-audit')
  const jsonPath = base + '.json'
  const markdownPath = base + '.md'
  fs.writeFileSync(jsonPath, toLf(JSON.stringify(result, null, 2)) + '\n', 'utf8')
  fs.writeFileSync(markdownPath, toLf(renderMarkdown(result)) + '\n', 'utf8')
  return { json: jsonPath, markdown: markdownPath }
}

function toLf(text) {
  return String(text).replace(/\r\n?/g, '\n')
}

export function renderMarkdown(result) {
  const s = result.summary
  const lines = []
  lines.push('# GTNH 灰机 Wiki 错材质审计（自动清点）')
  lines.push('')
  lines.push('> 由 scripts/wiki-material-audit/audit.mjs 生成；只读 Wiki，未做任何写入。')
  lines.push('')
  lines.push('| 项 | 值 |')
  lines.push('| --- | --- |')
  lines.push('| 生成时间 | ' + result.generatedAt + ' |')
  lines.push('| 站点 | ' + result.site + '（' + result.api + '） |')
  lines.push('| 耗时 / 请求数 | ' + Math.round(result.durationMs / 1000) + ' s / ' + result.requests + ' 次 |')
  lines.push('| 含挂载的页面 | ' + s.pagesWithMounts + ' 页（共 ' + s.mounts + ' 个挂载点） |')
  lines.push('| 命中页面 | **' + s.pagesBad + ' 页** |')
  lines.push('| 被引用结构 | ' + s.structuresReferenced + ' 个（审计 ' + s.structuresAudited + ' 个） |')
  lines.push('| #87 型坏 blob | **' + s.hits87 + '** |')
  lines.push('| #9 型坏 blob | **' + s.hits9 + '** |')
  lines.push('| 未判型 | ' + s.unclassified + ' 条 |')
  lines.push('| 无法解析 | ' + s.structuresUnresolved + ' 个结构 / ' + s.pagesUnresolved + ' 页 |')
  lines.push('')

  lines.push('## 判据（复用既有判型，未重新发明）')
  lines.push('')
  lines.push('- **#87 占位图**：blob 为 16x16、颜色数 <= 4、洋红像素占比 > 10%、纯黑像素占比 > 10%。')
  lines.push('- **#9 横向多面带**：blob 为 384x32 或 192x32，且材质 locator 是 IC2 系（ic2: 或 ic2/ 前缀）。')
  lines.push('- **未判型**：横向带但非 IC2（或宽度不是 384/192）、像占位图但未达 #87 门槛、贴图解码失败。')
  lines.push('')
  lines.push('命中口径：坏 blob 必须被**实际出现在 cellGrid 里的方块**引用才算结构命中（status=bad）；')
  lines.push('坏 blob 存在但没被用到，只记警告（status=warn），不冤枉页面。')
  lines.push('')

  const badPages = result.pages.filter((page) => page.status === 'bad')
  lines.push('## 命中页面（' + badPages.length + '）')
  lines.push('')
  if (!badPages.length) {
    lines.push('本次清点没有页面命中 #87 / #9。')
  } else {
    lines.push('| 页面 | 命名空间 | 结构 | 判型 | 坏 blob 数 |')
    lines.push('| --- | --- | --- | --- | --- |')
    for (const page of badPages) {
      for (const mount of page.mounts) {
        const structure = findStructure(result, mount.structureTitle)
        if (!structure || structure.status !== 'bad') continue
        const kinds = []
        if (structure.hits87) kinds.push('#87 x' + structure.hits87)
        if (structure.hits9) kinds.push('#9 x' + structure.hits9)
        lines.push(
          '| ' + cell(page.title) + ' | ' + page.ns + ' | ' + cell(mount.name) + ' | ' + kinds.join(' + ') + ' | ' +
            structure.badBlobs.length + ' |',
        )
      }
    }
  }
  lines.push('')

  const badStructures = result.structures.filter((row) => row.status === 'bad')
  if (badStructures.length) {
    lines.push('### 坏材质明细')
    lines.push('')
    for (const structure of badStructures) {
      lines.push('#### ' + structure.name + '（' + structure.title + '）')
      lines.push('')
      lines.push('| blob | 判型 | 尺寸 | 颜色数 | 洋红占比 | 纯黑占比 | locator | 被使用 |')
      lines.push('| --- | --- | --- | --- | --- | --- | --- | --- |')
      for (const blob of structure.badBlobs) {
        const stats = blob.stats || {}
        lines.push(
          '| ' + blob.index + ' | ' + labelVerdict(blob.verdict) + ' | ' +
            (stats.width != null ? stats.width + 'x' + stats.height : '?') + ' | ' +
            (stats.uniqueColors != null ? stats.uniqueColors : '?') + ' | ' +
            (stats.magentaRatio != null ? pct(stats.magentaRatio) : '?') + ' | ' +
            (stats.blackRatio != null ? pct(stats.blackRatio) : '?') + ' | ' +
            cell((blob.locators || []).join('<br>')) + ' | ' +
            (blob.usedInGrid ? '是' : '否（仅残留）') + ' |',
        )
      }
      lines.push('')
      const users = collectBlockUsers(structure)
      if (users.length) {
        lines.push(
          '用到这些材质的方块：' +
            users.slice(0, 12).map((u) => '「' + u.registryId + '」x' + u.cells).join('、') +
            (users.length > 12 ? ' 等 ' + users.length + ' 种' : ''),
        )
        lines.push('')
      }
    }
  }

  const unclassified = result.structures.filter((row) => row.unclassifiedCount > 0)
  lines.push('## 未判型（' + s.unclassified + ' 条，来自 ' + unclassified.length + ' 个结构）')
  lines.push('')
  if (!unclassified.length) {
    lines.push('无。')
  } else {
    lines.push('| 结构 | blob | 尺寸 | locator | 原因 |')
    lines.push('| --- | --- | --- | --- | --- |')
    for (const structure of unclassified) {
      for (const blob of structure.unclassified) {
        const stats = blob.stats || {}
        lines.push(
          '| ' + cell(structure.name) + ' | ' + blob.index + ' | ' +
            (stats.width != null ? stats.width + 'x' + stats.height : '?') + ' | ' +
            cell((blob.locators || []).join(', ')) + ' | ' + cell(blob.reason || blob.error || '') + ' |',
        )
      }
    }
  }
  lines.push('')

  const unresolved = result.structures.filter((row) => row.status === 'unresolved')
  lines.push('## 无法解析 / 缺口')
  lines.push('')
  if (!unresolved.length && !result.gaps.length) {
    lines.push('无。')
  } else {
    for (const row of unresolved) lines.push('- 结构 ' + row.title + '：' + row.error)
    for (const gap of result.gaps) lines.push('- [' + gap.kind + '] ' + gap.detail)
  }
  lines.push('')

  if (result.warnings && result.warnings.length) {
    lines.push('## 警告')
    lines.push('')
    for (const warning of result.warnings) lines.push('- ' + warning)
    lines.push('')
  }

  lines.push('## 枚举口径（怎么找到这些页面的）')
  lines.push('')
  lines.push('1. **结构数据页**：allpages（Data 命名空间，apprefix=Structures/），筛 *.json。')
  lines.push('2. **嵌入页**：embeddedin（模板:渲染器 反链，覆盖全部命名空间）∪ 文章命名空间全量正文扫描 ∪ insource:"data-wsr-structure" 搜索补漏。')
  lines.push('3. **页面内挂载点**：解析 {{渲染器|结构名称=...}}（含嵌套模板）与 data-wsr-structure="..."；跳过 pre/nowiki/注释里的示例。')
  lines.push('4. **结构内容**：取 Data:Structures/名字.json，解 Envelope（gzip+base64）；分片索引按 base_01 再退让 base 01 拼装。')
  lines.push('')
  lines.push('详见同目录 README 的「侦察结论」。')
  lines.push('')
  return lines.join('\n')
}

function findStructure(result, title) {
  return result.structures.find((row) => row.title === title)
}

function collectBlockUsers(structure) {
  const seen = new Map()
  for (const blob of structure.badBlobs || []) {
    for (const user of blob.blockUsers || []) {
      seen.set(user.registryId, (seen.get(user.registryId) || 0) + (user.cells || 0))
    }
  }
  return [...seen.entries()].map(([registryId, cells]) => ({ registryId, cells }))
}

function labelVerdict(verdict) {
  if (verdict === 'placeholder87') return '#87 占位图'
  if (verdict === 'strip9') return '#9 横向带'
  if (verdict === 'unclassified') return '未判型'
  if (verdict === 'error') return '解码失败'
  return verdict
}

function pct(value) {
  return (value * 100).toFixed(1) + '%'
}

function cell(value) {
  return String(value == null ? '' : value).replace(/\|/g, '\\|').replace(/\n/g, ' ')
}
