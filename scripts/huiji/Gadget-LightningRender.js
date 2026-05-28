// 按照官方做法，使用入口来加载真正的逻辑文件，可参考
// https://www.huijiwiki.com/wiki/%E5%B8%AE%E5%8A%A9:%E5%9C%A8%E7%81%B0%E6%9C%BA%E4%BD%BF%E7%94%A8Vue.js

// 使用 ES5 语法
// 加载 CSS 和 JS 文件
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

    var yaw = parseNumAttr(el, 'data-wsr-camera-yaw')
    var elv = parseNumAttr(el, 'data-wsr-camera-elevation')
    var dist = parseNumAttr(el, 'data-wsr-camera-distance')
    var zm = parseNumAttr(el, 'data-wsr-camera-zoom')
    if (yaw !== undefined || elv !== undefined || dist !== undefined || zm !== undefined) {
      var cam = {}
      if (yaw !== undefined) {
        cam.yawDeg = yaw
      }
      if (elv !== undefined) {
        cam.elevationDeg = elv
      }
      if (dist !== undefined) {
        cam.distance = dist
      }
      if (zm !== undefined) {
        cam.zoom = zm
      }
      ui.initialCamera = cam
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

  function mountIntoElement(el, doc) {
    if (!window.LightningEmbed || !window.LightningEmbed.mount) {
      return
    }
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

      function loadJsonInto(el, dataTitle) {
        var jsonUrl = mw.util.getUrl(dataTitle, { action: 'raw' })
        $.getJSON(jsonUrl)
          .done(function (doc) {
            mountIntoElement(el, doc)
          })
          .fail(function (_jqXHR, textStatus, err) {
            console.warn('结构数据加载失败', dataTitle, textStatus, err)
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
