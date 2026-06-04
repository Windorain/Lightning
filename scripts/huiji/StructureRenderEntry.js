// Wiki 零件页：零件:StructureRenderEntry.js
// https://gtnh.huijiwiki.com/wiki/%E9%9B%B6%E4%BB%B6:StructureRenderEntry.js
//
// 按照官方做法，使用入口来加载真正的逻辑文件，可参考
// https://www.huijiwiki.com/wiki/%E5%B8%AE%E5%8A%A9:%E5%9C%A8%E7%81%B0%E6%9C%BA%E4%BD%BF%E7%94%A8Vue.js
//
// 使用 ES5 语法
// 库由 Wiki 零件页加载（与仓库构建产物同名）：
//   零件:StructureRender.js  ← web/dist/StructureRender.js（npm run build:embed）
//   零件:StructureRender.css ← web/dist/StructureRender.css（已含 scripts/huiji/StructureRender.css）
// 大结构分片（可选）：零件:structureDataMultipart.js → WSRStructureData
// 全局 API 仍为 window.LightningEmbed
//
// 词条中可挂载多处，使用 class（推荐）：
// <div class="web-structure-renderer" data-wsr-structure="MEControllers5x5"
//   data-wsr-camera-yaw="225" data-wsr-camera-zoom="1.2" data-wsr-scene-background="#5a5a5a"></div>
//
// 将加载 https://你的站/wiki/Data:Structures/MEControllers5x5.json?action=raw
// 若无 data-wsr-structure，则仍使用 window.__WSR_EMBED_DOCUMENT__（便于控制台调试；多节点时各自都会用该文档）
//
// 兼容旧版：若页上无 .web-structure-renderer，会尝试单个 id="web-structure-renderer"
//
// previewConfig / 嵌入层支持的 data 属性（均为可选，省略则走库内默认）：
// —— ui ——
//   data-wsr-initial-layer-world-y  或 data-wsr-initial-layer  → initialLayerWorldY（分层，-1 为 ALL）
//   data-wsr-initial-world-frame-index 或 data-wsr-initial-frame → initialWorldFrameIndex（World 起始帧）
//   data-wsr-scene-background      6 位十六进制，可带 # 或 0x → sceneBackground
//   data-wsr-debug                 true/false/1/0 → debug
//   data-wsr-loading-message       字符串 → loadingMessage
//   data-wsr-camera-yaw            → initialCamera.yawDeg
//   data-wsr-camera-elevation      → initialCamera.elevationDeg
//   data-wsr-camera-distance         → initialCamera.distance
//   data-wsr-camera-zoom             → initialCamera.zoom（正交 zoom，与滚轮一致）
//   data-wsr-icon-size-px            → blockIconCacheOptions.sizePx
//   data-wsr-icon-ortho-half         → blockIconCacheOptions.orthoHalf
// —— features（每项 true/false/1/0）——
//   data-wsr-feature-layer-bar       → layerBar
//   data-wsr-feature-title-bar       → titleBar
//   data-wsr-feature-frame-controls  → frameControls
//   data-wsr-feature-block-stats     → blockStatsSidebar
//   data-wsr-feature-debug-status    → debugStatusBar
//   data-wsr-feature-axes-gizmo     → showAxesGizmo
// —— mobile ——
//   data-wsr-mobile-fit            默认开启；0/false 关闭外壳等比缩放
//   data-wsr-mobile-profile        auto（默认）| desktop | compact

/* global $, mw, document, window, console */
$(function () {
  function loadCss() {
    if (document.querySelector('link[data-wsr-css]')) {
      return
    }
    var href = mw.util.getUrl('零件:StructureRender.css', {
      action: 'raw',
      ctype: 'text/css',
    })
    var link = document.createElement('link')
    link.rel = 'stylesheet'
    link.href = href
    link.setAttribute('data-wsr-css', '1')
    document.head.appendChild(link)
  }

  function parseBoolAttr(el, name) {
    if (!el || !el.getAttribute) {
      return undefined
    }
    var v = el.getAttribute(name)
    if (v == null || v === '') {
      return undefined
    }
    var t = String(v).toLowerCase()
    if (t === '1' || t === 'true' || t === 'yes') {
      return true
    }
    if (t === '0' || t === 'false' || t === 'no') {
      return false
    }
    return undefined
  }

  function parseNumAttr(el, name) {
    if (!el || !el.getAttribute) {
      return undefined
    }
    var v = el.getAttribute(name)
    if (v == null || v === '') {
      return undefined
    }
    var n = Number(v)
    return isFinite(n) ? n : undefined
  }

  function parseHexAttr(el, name) {
    if (!el || !el.getAttribute) {
      return undefined
    }
    var v = el.getAttribute(name)
    if (v == null || typeof v !== 'string') {
      return undefined
    }
    v = v.replace(/^\s+|\s+$/g, '')
    var m = /^#?([0-9a-fA-F]{6})$/.exec(v)
    if (m) {
      return parseInt(m[1], 16)
    }
    if (/^0x[0-9a-fA-F]{1,8}$/i.test(v)) {
      return parseInt(v.slice(2), 16)
    }
    return undefined
  }

  function objectHasAnyKey(obj) {
    if (!obj) {
      return false
    }
    for (var k in obj) {
      if (Object.prototype.hasOwnProperty.call(obj, k)) {
        return true
      }
    }
    return false
  }

  /**
   * 从挂载 div 的 data-wsr-structure 得到 MediaWiki 页面名 Data:Structures/XXX.json
   * 属性值填 XXX 即可（可带或不带 .json 后缀）
   */
  function structureDataTitleFromMountEl(el) {
    if (!el || !el.getAttribute) {
      return ''
    }
    var v = el.getAttribute('data-wsr-structure')
    if (v == null || typeof v !== 'string') {
      return ''
    }
    v = v.replace(/^\s+|\s+$/g, '')
    if (!v) {
      return ''
    }
    v = v.replace(/\.json$/i, '')
    return 'Data:Structures/' + v + '.json'
  }

  function uiFromMountEl(el) {
    var ui = {}
    var il = parseNumAttr(el, 'data-wsr-initial-layer-world-y')
    if (il === undefined) {
      il = parseNumAttr(el, 'data-wsr-initial-layer')
    }
    if (il !== undefined) {
      ui.initialLayerWorldY = il
    }

    var iwfi = parseNumAttr(el, 'data-wsr-initial-world-frame-index')
    if (iwfi === undefined) {
      iwfi = parseNumAttr(el, 'data-wsr-initial-frame')
    }
    if (iwfi !== undefined) {
      ui.initialWorldFrameIndex = iwfi
    }

    var bg = parseHexAttr(el, 'data-wsr-scene-background')
    if (bg !== undefined) {
      ui.sceneBackground = bg
    }

    var dbg = parseBoolAttr(el, 'data-wsr-debug')
    if (dbg !== undefined) {
      ui.debug = dbg
    }

    var lm = el.getAttribute('data-wsr-loading-message')
    if (lm != null && String(lm) !== '') {
      ui.loadingMessage = String(lm)
    }

    var iconPx = parseNumAttr(el, 'data-wsr-icon-size-px')
    var orthoH = parseNumAttr(el, 'data-wsr-icon-ortho-half')
    if (iconPx !== undefined || orthoH !== undefined) {
      ui.blockIconCacheOptions = {}
      if (iconPx !== undefined) {
        ui.blockIconCacheOptions.sizePx = iconPx
      }
      if (orthoH !== undefined) {
        ui.blockIconCacheOptions.orthoHalf = orthoH
      }
    }

    return ui
  }

  function featuresFromMountEl(el) {
    var f = {}
    var pairs = [
      ['data-wsr-feature-layer-bar', 'layerBar'],
      ['data-wsr-feature-title-bar', 'titleBar'],
      ['data-wsr-feature-frame-controls', 'frameControls'],
      ['data-wsr-feature-block-stats', 'blockStatsSidebar'],
      ['data-wsr-feature-debug-status', 'debugStatusBar'],
      ['data-wsr-feature-axes-gizmo', 'showAxesGizmo'],
    ]
    for (var i = 0; i < pairs.length; i++) {
      var b = parseBoolAttr(el, pairs[i][0])
      if (b !== undefined) {
        f[pairs[i][1]] = b
      }
    }
    return f
  }

  function bootstrapFromMountEl(el, doc) {
    var bootstrap = {
      data: { document: doc },
    }
    var ui = uiFromMountEl(el)
    if (objectHasAnyKey(ui)) {
      bootstrap.ui = ui
    }
    var feat = featuresFromMountEl(el)
    if (objectHasAnyKey(feat)) {
      bootstrap.features = feat
    }
    return bootstrap
  }

  var HOST_CLASS = 'wsr-fit-host'
  var FIT_MARGIN_PX = 16
  var DEFAULT_DESIGN_W = 800
  var DEFAULT_DESIGN_H = 600

  function parseMobileFitEnabled(el) {
    var b = parseBoolAttr(el, 'data-wsr-mobile-fit')
    if (b === false) {
      return false
    }
    return true
  }

  function readDesignPx(el, dim) {
    var inline = el.style[dim]
    if (inline) {
      var m = /^([\d.]+)\s*px$/i.exec(String(inline).replace(/^\s+|\s+$/g, ''))
      if (m) {
        return Math.max(1, parseFloat(m[1]))
      }
    }
    var cs = window.getComputedStyle(el)
    var parsed = parseFloat(cs[dim])
    if (parsed > 0 && isFinite(parsed)) {
      return parsed
    }
    return dim === 'width' ? DEFAULT_DESIGN_W : DEFAULT_DESIGN_H
  }

  function availWidthForHost(host) {
    var parent = host.parentElement
    if (parent && parent.clientWidth > 0) {
      return parent.clientWidth
    }
    return document.documentElement.clientWidth
  }

  function ensureMobileFitHost(mountEl) {
    if (!parseMobileFitEnabled(mountEl)) {
      return
    }
    var host = mountEl.parentElement
    if (!host || !host.classList || !host.classList.contains(HOST_CLASS)) {
      host = document.createElement('div')
      host.className = HOST_CLASS
      if (mountEl.parentNode) {
        mountEl.parentNode.insertBefore(host, mountEl)
      }
      host.appendChild(mountEl)
    }
    var parentRo = null

    function getDesignSize() {
      var sw = mountEl.getAttribute('data-wsr-design-width')
      var sh = mountEl.getAttribute('data-wsr-design-height')
      if (sw && sh) {
        return { w: Math.max(1, parseFloat(sw)), h: Math.max(1, parseFloat(sh)) }
      }
      var designW = readDesignPx(mountEl, 'width')
      var designH = readDesignPx(mountEl, 'height')
      mountEl.setAttribute('data-wsr-design-width', String(designW))
      mountEl.setAttribute('data-wsr-design-height', String(designH))
      return { w: designW, h: designH }
    }

    function apply() {
      var design = getDesignSize()
      var designW = design.w
      var designH = design.h
      var avail = Math.max(1, availWidthForHost(host) - FIT_MARGIN_PX)
      if (avail >= designW) {
        host.style.width = ''
        host.style.height = ''
        mountEl.style.width = designW + 'px'
        mountEl.style.height = designH + 'px'
        mountEl.style.transform = ''
        mountEl.style.transformOrigin = ''
        mountEl.removeAttribute('data-wsr-fit-scale')
        try {
          window.dispatchEvent(new CustomEvent('wsr-fit-change'))
        } catch (_e) { /* IE */ }
        return
      }
      var s = avail / designW
      var fitW = Math.round(designW * s)
      var fitH = Math.round(designH * s)
      host.style.width = fitW + 'px'
      host.style.height = fitH + 'px'
      mountEl.style.width = fitW + 'px'
      mountEl.style.height = fitH + 'px'
      mountEl.style.transform = ''
      mountEl.style.transformOrigin = ''
      mountEl.setAttribute('data-wsr-fit-scale', String(s))
      try {
        window.dispatchEvent(new CustomEvent('wsr-fit-change'))
      } catch (_e) { /* IE */ }
    }

    apply()
    window.addEventListener('resize', apply)
    var parent = host.parentElement
    if (parent && window.ResizeObserver) {
      parentRo = new ResizeObserver(function () {
        apply()
      })
      parentRo.observe(parent)
    }
  }

  function mountIntoElement(el, doc) {
    if (!window.LightningEmbed || !window.LightningEmbed.mount) {
      return
    }
    ensureMobileFitHost(el)
    window.LightningEmbed.mount(el, bootstrapFromMountEl(el, doc))
  }

  function collectMountNodes() {
    var out = []
    var nl = document.querySelectorAll('.web-structure-renderer')
    var i
    for (i = 0; i < nl.length; i++) {
      out.push(nl[i])
    }
    if (!out.length) {
      var legacy = document.getElementById('web-structure-renderer')
      if (legacy) {
        out.push(legacy)
      }
    }
    return out
  }

  function onExternalLibsLoaded() {
    window.removeEventListener('externalLibsLoaded', onExternalLibsLoaded, false)
    loadCss()
    var raw = mw.util.getUrl('零件:StructureRender.js', {
      action: 'raw',
      ctype: 'text/javascript',
    })
    $.getScript(raw, function () {
      if (!window.LightningEmbed || !window.LightningEmbed.mount) {
        return
      }
      var nodes = collectMountNodes()
      if (!nodes.length) {
        return
      }

      function baseFromDataTitle(dataTitle) {
        var m = /^Data:Structures\/(.+)\.json$/i.exec(dataTitle || '')
        return m ? m[1].replace(/\.json$/i, '') : ''
      }

      function isMultipartIndexDoc(doc) {
        return !!(doc && doc.documentFormat === 'Envelope/multipart' && doc.partCount > 0)
      }

      function pad2Part(n) {
        return n < 10 ? '0' + n : String(n)
      }

      function partTitlesForIndex(indexDoc, base) {
        var b = indexDoc.base || base
        var n = indexDoc.partCount
        var out = []
        var i
        for (i = 1; i <= n; i++) {
          out.push('Data:Structures/' + b + '_' + pad2Part(i) + '.json')
        }
        return out
      }

      function mergeMultipartDocs(indexDoc, partDocs) {
        var SD = window.WSRStructureData
        if (SD && SD.mergeMultipartIndex) {
          return SD.mergeMultipartIndex(indexDoc, partDocs)
        }
        var sorted = partDocs.slice().sort(function (a, b) {
          return a.part - b.part
        })
        if (sorted.length !== indexDoc.partCount) {
          throw new Error('分片数量不匹配')
        }
        var payload = ''
        var i
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

      function fetchPartDocsSequential(titles, index, acc, onDone, onFail) {
        if (index >= titles.length) {
          onDone(acc)
          return
        }
        var partUrl = mw.util.getUrl(titles[index], { action: 'raw' })
        $.getJSON(partUrl)
          .done(function (partDoc) {
            acc.push(partDoc)
            fetchPartDocsSequential(titles, index + 1, acc, onDone, onFail)
          })
          .fail(onFail)
      }

      function loadJsonInto(el, dataTitle) {
        var jsonUrl = mw.util.getUrl(dataTitle, { action: 'raw' })
        $.getJSON(jsonUrl)
          .done(function (indexDoc) {
            if (!isMultipartIndexDoc(indexDoc)) {
              mountIntoElement(el, indexDoc)
              return
            }
            var base = indexDoc.base || baseFromDataTitle(dataTitle)
            var partTitles = partTitlesForIndex(indexDoc, base)
            if (!partTitles.length) {
              return
            }
            fetchPartDocsSequential(
              partTitles,
              0,
              [],
              function (partDocs) {
                try {
                  var merged = mergeMultipartDocs(indexDoc, partDocs)
                  mountIntoElement(el, merged)
                } catch (_mergeErr) {
                  /* 合并失败：不挂载，避免向 Embed 传入无效文档 */
                }
              },
              function () {
                /* 分片请求失败：不挂载 */
              }
            )
          })
          .fail(function () {
            /* 结构数据请求失败：不挂载 */
          })
      }

      var j
      for (j = 0; j < nodes.length; j++) {
        ;(function (mountEl) {
          var dataTitle = structureDataTitleFromMountEl(mountEl)
          if (dataTitle) {
            loadJsonInto(mountEl, dataTitle)
            return
          }
          var doc = window.__WSR_EMBED_DOCUMENT__
          if (!doc) {
            console.warn(
              '[在线渲染器] 请为节点设置 data-wsr-structure，或提供 window.__WSR_EMBED_DOCUMENT__',
              mountEl
            )
            return
          }
          mountIntoElement(mountEl, doc)
        })(nodes[j])
      }
    })
  }
  window.addEventListener('externalLibsLoaded', onExternalLibsLoaded, false)
})
