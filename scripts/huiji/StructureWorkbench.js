// 灰机零件页：零件:StructureWorkbench.js（小工具 module.scripts 入口，非 bundle）
// 推送：覆盖站上同名页；Vue 应用见 build:wiki-workbench → 零件:StructureWorkbench.bundle.js
// 结构工作台启动脚本：在模板 div 内挂载浮层并加载 Vue bundle。
/* global $, mw, document, window */
(function () {
  function trim(s) {
    return String(s == null ? '' : s).replace(/^\s+|\s+$/g, '')
  }

  function normalizeDataTitle(raw) {
    var title = trim(raw)
    if (!title) return ''
    if (!/^Data:/i.test(title)) {
      title = 'Data:' + title.replace(/^:+/, '')
    }
    if (!/\.json$/i.test(title)) {
      title += '.json'
    }
    return title
  }

  function getQueryParam(name) {
    var q = window.location.search || ''
    var re = new RegExp('[?&]' + name + '=([^&]*)')
    var m = re.exec(q)
    if (!m) return ''
    try {
      return decodeURIComponent(m[1].replace(/\+/g, ' '))
    } catch (e) {
      return m[1]
    }
  }

  function getQueryDataTitle() {
    return normalizeDataTitle(getQueryParam('data') || getQueryParam('page') || '')
  }

  function getExistingMountRoot() {
    return document.querySelector('.web-structure-workbench')
  }

  function getMode(root) {
    var mode = root ? trim(root.getAttribute('data-wsw-mode') || '') : ''
    mode = mode.toLowerCase()
    if (mode === 'inline') return 'inline'
    if (mode === 'fullscreen') return 'fullscreen'
    return 'overlay'
  }

  function loadRawPage(title, ctype) {
    return mw.util.getUrl(title, {
      action: 'raw',
      ctype: ctype
    })
  }

  function loadCssOnce() {
    if (document.querySelector('link[data-wsw-css]')) return
    var link = document.createElement('link')
    link.rel = 'stylesheet'
    link.href = loadRawPage('零件:StructureWorkbench.css', 'text/css')
    link.setAttribute('data-wsw-css', '1')
    document.head.appendChild(link)
  }

  function loadShellCssOnce() {
    if (document.querySelector('style[data-wsw-shell-css]')) return
    var style = document.createElement('style')
    style.setAttribute('data-wsw-shell-css', '1')
    style.textContent = [
      '.wsw-shell{position:fixed;inset:0;z-index:3999;display:flex;flex-direction:column;background:#111827;color:#e5e7eb;}',
      '.wsw-shell__bar{flex:0 0 auto;display:flex;align-items:center;gap:12px;padding:6px 10px;background:#0f172a;border-bottom:1px solid #334155;font:12px system-ui,sans-serif;}',
      '.wsw-shell__title{font-weight:700;color:#f8fafc;}',
      '.wsw-shell__meta{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#94a3b8;}',
      '.wsw-shell__btn,.wsw-picker__btn{padding:4px 10px;border:1px solid #475569;background:#1e293b;color:#e2e8f0;cursor:pointer;font-size:12px;}',
      '.wsw-shell__app{flex:1;min-height:0;overflow:hidden;}',
      '.web-structure-workbench.wsw-mount-host{position:relative;width:100%;min-height:min(72vh,800px);height:min(72vh,800px);margin:12px 0;}',
      '.wsw-overlay-layer{position:absolute;inset:0;z-index:1;display:flex;flex-direction:column;overflow:hidden;border:1px solid #334155;border-radius:8px;background:#111827;box-shadow:0 12px 40px rgba(15,23,42,.45);}',
      '.wsw-overlay-app{flex:1;min-height:0;overflow:hidden;}',
      '.wsw-inline{width:100%;min-height:min(70vh,720px);height:min(72vh,800px);display:flex;flex-direction:column;border:1px solid #334155;border-radius:8px;overflow:hidden;background:#111827;}',
      '.wsw-inline__app{flex:1;min-height:0;overflow:hidden;}',
      '.wsw-error{margin:0;padding:20px;color:#fecaca;white-space:pre-wrap;}',
    ].join('')
    document.head.appendChild(style)
  }

  function createFullShell(dataTitle, buttonLabel) {
    var shell = document.createElement('div')
    shell.className = 'wsw-shell'
    shell.innerHTML = [
      '<div class="wsw-shell__bar">',
      '<div class="wsw-shell__title">Structure Workbench</div>',
      '<div class="wsw-shell__meta"></div>',
      '<button type="button" class="wsw-shell__btn" data-wsw-fullscreen>Fullscreen</button>',
      '</div>',
      '<div id="wsr-workbench-app" class="wsw-shell__app"></div>',
    ].join('')
    shell.querySelector('[data-wsw-fullscreen]').textContent = buttonLabel || 'Fullscreen'
    shell.querySelector('.wsw-shell__meta').textContent = dataTitle ? dataTitle : ''
    return shell
  }

  function loadWorkbenchBundle(shell) {
    if (!shell || document.querySelector('script[data-wsw-bundle]')) {
      return
    }
    var script = document.createElement('script')
    script.type = 'module'
    script.src = loadRawPage('零件:StructureWorkbench.bundle.js', 'text/javascript')
    script.setAttribute('data-wsw-bundle', '1')
    script.onload = function () {
      shell.setAttribute('data-wsw-bundle-loaded', '1')
    }
    script.onerror = function () {
      var shellBox = shell.querySelector('.wsw-shell')
      if (shellBox) {
        shellBox.innerHTML = '<pre class="wsw-error">Failed to load workbench bundle.</pre>'
      }
    }
    document.head.appendChild(script)
  }

  /** 默认：模板 div 内浮层 + 工作台（不盖住 Wiki 顶栏） */
  function mountPageOverlayWorkbench(root, dataTitle) {
    window.__WSR_WORKBENCH_DATA_TITLE__ = dataTitle
    loadShellCssOnce()
    root.innerHTML = ''
    root.className = 'web-structure-workbench wsw-mount-host'
    var layer = document.createElement('div')
    layer.className = 'wsw-overlay-layer'
    var app = document.createElement('div')
    app.id = 'wsr-workbench-app'
    app.className = 'wsw-overlay-app'
    layer.appendChild(app)
    root.appendChild(layer)
    loadCssOnce()
    loadWorkbenchBundle(layer)
  }

  /** 词条内嵌（无浮层样式，data-wsw-mode="inline"） */
  function mountInlineWorkbench(root, dataTitle) {
    window.__WSR_WORKBENCH_DATA_TITLE__ = dataTitle
    loadShellCssOnce()
    root.innerHTML = ''
    var box = document.createElement('div')
    box.className = 'wsw-inline'
    var app = document.createElement('div')
    app.id = 'wsr-workbench-app'
    app.className = 'wsw-inline__app'
    box.appendChild(app)
    root.appendChild(box)
    loadCssOnce()
    loadWorkbenchBundle(box)
  }

  /** 整页 fixed 遮罩（data-wsw-mode="fullscreen"，调试用） */
  function mountFullWorkbench(root, dataTitle) {
    window.__WSR_WORKBENCH_DATA_TITLE__ = dataTitle
    loadShellCssOnce()
    var shell = createFullShell(dataTitle, 'Fullscreen')
    root.innerHTML = ''
    root.appendChild(shell)
    loadCssOnce()
    loadWorkbenchBundle(shell)
    shell.querySelector('[data-wsw-fullscreen]').onclick = function () {
      if (document.fullscreenElement) {
        if (document.exitFullscreen) {
          document.exitFullscreen()
        }
        return
      }
      if (shell.requestFullscreen) {
        shell.requestFullscreen()
      }
    }
    return shell
  }

  $(function () {
    var root = getExistingMountRoot()
    if (!root) {
      return
    }
    var mode = getMode(root)
    var dataTitle = normalizeDataTitle(
      root.getAttribute('data-wsw-data') || getQueryDataTitle() || window.__WSR_WORKBENCH_DATA_TITLE__ || ''
    )
    if (mode === 'fullscreen') {
      mountFullWorkbench(root, dataTitle)
      return
    }
    if (mode === 'inline') {
      mountInlineWorkbench(root, dataTitle)
      return
    }
    mountPageOverlayWorkbench(root, dataTitle)
  })
})()