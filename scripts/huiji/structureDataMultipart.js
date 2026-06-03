/**
 * 灰机 Data:Structures 大文件分片契约（ES5，Upload / Entry 共用）。
 * 暴露全局 WSRStructureData。
 */
/* global window */
(function (global) {
  /** 单页 edit 安全上限（字节），低于 Wiki 2048 KiB */
  var PAGE_LIMIT_BYTES = 1900 * 1024
  var MULTIPART = 'Envelope/multipart'
  var PART = 'Envelope/part'

  function utf8ByteLength(str) {
    if (typeof TextEncoder !== 'undefined') {
      return new TextEncoder().encode(str).length
    }
    try {
      return unescape(encodeURIComponent(str)).length
    } catch (ignoreErr) {
      return str.length
    }
  }

  function pad2(n) {
    return n < 10 ? '0' + n : String(n)
  }

  function normalizeBase(name) {
    var v = String(name || '').replace(/^\s+|\s+$/g, '')
    v = v.replace(/\.json$/i, '')
    v = v.replace(/\\/g, '/')
    var slash = v.lastIndexOf('/')
    if (slash >= 0) {
      v = v.slice(slash + 1)
    }
    return v
  }

  function dataPageTitle(base, suffix) {
    return 'Data:Structures/' + base + (suffix || '') + '.json'
  }

  function indexTitle(base) {
    return dataPageTitle(normalizeBase(base), '')
  }

  function partTitle(base, partIndex) {
    return dataPageTitle(normalizeBase(base), '_' + pad2(partIndex))
  }

  function isEnvelopeDoc(doc) {
    if (!doc || typeof doc !== 'object') {
      return false
    }
    return (
      doc.documentFormat === 'Envelope' ||
      (typeof doc.payload === 'string' &&
        doc.payload.length > 0 &&
        doc.meta != null &&
        typeof doc.meta === 'object')
    )
  }

  function isMultipartIndex(doc) {
    return !!(doc && doc.documentFormat === MULTIPART && doc.partCount > 0)
  }

  function jsonPageBytes(obj) {
    return utf8ByteLength(JSON.stringify(obj))
  }

  function buildPartDoc(base, partIndex, partCount, payloadSlice) {
    return {
      documentFormat: PART,
      part: partIndex,
      partCount: partCount,
      base: normalizeBase(base),
      payload: payloadSlice
    }
  }

  function maxPayloadSliceLength(base, partIndex, partCount) {
    var lo = 0
    var hi = partCount > 0 ? 1 : 0
    var payload = 'A'
    while (jsonPageBytes(buildPartDoc(base, partIndex, partCount, payload)) <= PAGE_LIMIT_BYTES) {
      hi *= 2
      payload = payload + payload
    }
    lo = Math.floor(hi / 2)
    hi = hi - 1
    while (lo < hi) {
      var mid = Math.ceil((lo + hi) / 2)
      var slice = new Array(mid + 1).join('A')
      if (jsonPageBytes(buildPartDoc(base, partIndex, partCount, slice)) <= PAGE_LIMIT_BYTES) {
        lo = mid
      } else {
        hi = mid - 1
      }
    }
    return lo
  }

  function splitPayload(base, payload) {
    var chunks = []
    var offset = 0
    var estimatedParts = Math.max(1, Math.ceil(payload.length / 500000))
    while (offset < payload.length) {
      var maxLen = maxPayloadSliceLength(base, chunks.length + 1, estimatedParts)
      if (maxLen < 1) {
        throw new Error('单分片仍超过 Wiki 页面大小上限，无法上传')
      }
      var take = Math.min(maxLen, payload.length - offset)
      var slice = payload.slice(offset, offset + take)
      while (take > 0 && jsonPageBytes(buildPartDoc(base, chunks.length + 1, estimatedParts, slice)) > PAGE_LIMIT_BYTES) {
        take -= 4
        slice = payload.slice(offset, offset + take)
      }
      if (take <= 0) {
        throw new Error('无法切分 payload')
      }
      chunks.push(slice)
      offset += take
    }
    var n = chunks.length
    var i
    var parts = []
    for (i = 0; i < n; i++) {
      parts.push(buildPartDoc(base, i + 1, n, chunks[i]))
    }
    return parts
  }

  function buildMultipartPlan(base, envelope) {
    var b = normalizeBase(base)
    var parts = splitPayload(b, envelope.payload)
    var index = {
      documentFormat: MULTIPART,
      partCount: parts.length,
      payloadEncoding: envelope.payloadEncoding || 'gzip+base64',
      meta: envelope.meta || {},
      base: b
    }
    var pages = [{ title: indexTitle(b), text: JSON.stringify(index) }]
    var i
    for (i = 0; i < parts.length; i++) {
      pages.push({
        title: partTitle(b, i + 1),
        text: JSON.stringify(parts[i])
      })
    }
    return {
      mode: 'multipart',
      base: b,
      pages: pages,
      partCount: parts.length
    }
  }

  function buildSinglePlan(base, doc) {
    var b = normalizeBase(base)
    return {
      mode: 'single',
      base: b,
      pages: [{ title: indexTitle(b), text: JSON.stringify(doc) }],
      partCount: 0
    }
  }

  /**
   * 根据文档与 base 名生成上传计划。
   * @param {string} base
   * @param {object} doc parsed JSON
   */
  function planUpload(base, doc) {
    var b = normalizeBase(base)
    if (!b) {
      throw new Error('请填写结构名称（英文/数字，对应 Data:Structures/名称.json）')
    }
    if (!doc || typeof doc !== 'object') {
      throw new Error('不是有效的 JSON 对象')
    }
    if (isMultipartIndex(doc)) {
      throw new Error('请勿上传分片索引页；请上传完整导出的 JSON 文件')
    }
    if (isEnvelopeDoc(doc)) {
      var singleBytes = jsonPageBytes(doc)
      if (singleBytes <= PAGE_LIMIT_BYTES) {
        return buildSinglePlan(b, doc)
      }
      return buildMultipartPlan(b, doc)
    }
    var plainBytes = jsonPageBytes(doc)
    if (plainBytes <= PAGE_LIMIT_BYTES) {
      return buildSinglePlan(b, doc)
    }
    throw new Error(
      'Plain JSON 超过 Wiki 单页上限。请用游戏/工作台导出 Envelope（gzip+base64）后再上传。'
    )
  }

  function mergeMultipartIndex(indexDoc, partDocs) {
    if (!isMultipartIndex(indexDoc)) {
      return indexDoc
    }
    var n = indexDoc.partCount
    var sorted = partDocs.slice().sort(function (a, b) {
      return a.part - b.part
    })
    if (sorted.length !== n) {
      throw new Error('分片数量不匹配：索引 ' + n + '，实际 ' + sorted.length)
    }
    var i
    var payload = ''
    for (i = 0; i < sorted.length; i++) {
      if (sorted[i].part !== i + 1) {
        throw new Error('缺少分片 part ' + (i + 1))
      }
      payload += sorted[i].payload || ''
    }
    return {
      documentFormat: 'Envelope',
      payloadEncoding: indexDoc.payloadEncoding || 'gzip+base64',
      meta: indexDoc.meta || {},
      payload: payload
    }
  }

  /**
   * 根据索引页内容决定需要拉取的分片标题；单文件返回 null。
   */
  function partTitlesFromIndex(indexDoc, base) {
    if (!isMultipartIndex(indexDoc)) {
      return null
    }
    var b = normalizeBase(base || indexDoc.base)
    var out = []
    var i
    for (i = 1; i <= indexDoc.partCount; i++) {
      out.push(partTitle(b, i))
    }
    return out
  }

  /**
   * 覆盖上传前应删除的过时分片页（不含索引页；索引由新内容覆盖 edit）。
   * @param {object|null} existingIndexDoc 已拉取的索引 JSON，不存在则为 null
   * @param {object} newPlan planUpload 结果
   * @param {number} [knownOldPartCount] 探测到的旧分片数（无索引时）
   */
  function cleanupTitlesForOverwrite(existingIndexDoc, newPlan, knownOldPartCount) {
    var deleteTitles = []
    var b = newPlan.base
    var oldCount = 0
    if (existingIndexDoc && isMultipartIndex(existingIndexDoc)) {
      oldCount = existingIndexDoc.partCount
    } else if (knownOldPartCount > 0) {
      oldCount = knownOldPartCount
    }
    var i
    if (newPlan.mode === 'single') {
      for (i = 1; i <= oldCount; i++) {
        deleteTitles.push(partTitle(b, i))
      }
      return deleteTitles
    }
    for (i = newPlan.partCount + 1; i <= oldCount; i++) {
      deleteTitles.push(partTitle(b, i))
    }
    return deleteTitles
  }

  /**
   * 发现旧分片（无索引或索引损坏时，探测 _01.._32）。
   */
  function probeLegacyPartTitles(base, maxProbe) {
    var out = []
    var i
    var limit = maxProbe || 32
    for (i = 1; i <= limit; i++) {
      out.push(partTitle(base, i))
    }
    return out
  }

  global.WSRStructureData = {
    PAGE_LIMIT_BYTES: PAGE_LIMIT_BYTES,
    MULTIPART: MULTIPART,
    PART: PART,
    normalizeBase: normalizeBase,
    indexTitle: indexTitle,
    partTitle: partTitle,
    dataPageTitle: dataPageTitle,
    isEnvelopeDoc: isEnvelopeDoc,
    isMultipartIndex: isMultipartIndex,
    planUpload: planUpload,
    mergeMultipartIndex: mergeMultipartIndex,
    partTitlesFromIndex: partTitlesFromIndex,
    cleanupTitlesForOverwrite: cleanupTitlesForOverwrite,
    probeLegacyPartTitles: probeLegacyPartTitles,
    utf8ByteLength: utf8ByteLength,
    jsonPageBytes: jsonPageBytes
  }
})(typeof window !== 'undefined' ? window : this)
