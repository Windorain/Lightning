/**
 * Wiki 结构数据上传（ES5）：选 JSON → 自动分片 → mw.Api 写入 Data:Structures。
 * 依赖：structureDataMultipart.js（WSRStructureData）、jQuery、mw.Api。
 */
/* global $, mw, document, window, WSRStructureData */
;(function () {
  var SD = window.WSRStructureData
  if (!SD) {
    console.error('[StructureRenderUpload] 缺少 WSRStructureData')
    return
  }

  function log(el, msg) {
    var line = document.createElement('div')
    line.className = 'wsr-upload-log__line'
    line.textContent = msg
    el.appendChild(line)
    el.scrollTop = el.scrollHeight
  }

  function clearLog(el) {
    el.innerHTML = ''
  }

  function basenameFromFile(file) {
    if (!file || !file.name) {
      return ''
    }
    return SD.normalizeBase(file.name.replace(/\.json$/i, ''))
  }

  function fetchIndexDoc(api, base, onOk, onErr) {
    var title = SD.indexTitle(base)
    api
      .get({
        action: 'query',
        titles: title,
        prop: 'revisions',
        rvprop: 'content',
        rvslots: 'main',
        format: 'json'
      })
      .done(function (data) {
        var pages = data.query && data.query.pages
        if (!pages) {
          onOk(null)
          return
        }
        var page = pages[Object.keys(pages)[0]]
        if (!page || page.missing) {
          onOk(null)
          return
        }
        var rev = page.revisions && page.revisions[0]
        var content = rev && rev.slots && rev.slots.main && rev.slots.main['*']
        if (!content) {
          onOk(null)
          return
        }
        try {
          onOk(JSON.parse(content))
        } catch (parseErr) {
          onOk(null)
        }
      })
      .fail(onErr)
  }

  function probeExistingPartCount(api, base, maxProbe, onOk, onErr) {
    var titles = SD.probeLegacyPartTitles(base, maxProbe || 32)
    api
      .get({
        action: 'query',
        titles: titles.join('|'),
        format: 'json'
      })
      .done(function (data) {
        var pages = data.query && data.query.pages
        if (!pages) {
          onOk(0)
          return
        }
        var max = 0
        var id
        for (id in pages) {
          if (!Object.prototype.hasOwnProperty.call(pages, id)) {
            continue
          }
          if (!pages[id].missing) {
            var t = pages[id].title || ''
            var m = /_(\d+)\.json$/i.exec(t)
            if (m) {
              max = Math.max(max, parseInt(m[1], 10))
            }
          }
        }
        onOk(max)
      })
      .fail(onErr)
  }

  function editPage(api, title, text, summary, onOk, onErr) {
    api
      .postWithToken('csrf', {
        action: 'edit',
        title: title,
        text: text,
        summary: summary,
        format: 'json'
      })
      .done(function (data) {
        if (data.edit && data.edit.result === 'Success') {
          onOk(data.edit)
          return
        }
        if (data.error) {
          onErr(new Error(data.error.info || data.error.code))
          return
        }
        onErr(new Error('编辑失败: ' + (data.edit && data.edit.result)))
      })
      .fail(onErr)
  }

  function deletePage(api, title, summary, onOk) {
    api
      .postWithToken('csrf', {
        action: 'delete',
        title: title,
        reason: summary,
        format: 'json'
      })
      .done(function (data) {
        if (data.delete && data.delete.title) {
          onOk(true)
          return
        }
        onOk(false)
      })
      .fail(function () {
        onOk(false)
      })
  }

  function runTasksSequential(tasks, onDone, onErr) {
    var i = 0
    function next() {
      if (i >= tasks.length) {
        onDone()
        return
      }
      var task = tasks[i]
      i += 1
      task(next, onErr)
    }
    next()
  }

  function readFileAsText(file, onOk, onErr) {
    var reader = new FileReader()
    reader.onload = function () {
      onOk(String(reader.result || ''))
    }
    reader.onerror = function () {
      onErr(new Error('无法读取文件'))
    }
    reader.readAsText(file, 'UTF-8')
  }

  function runUpload(options, onDone, onErr) {
    var file = options.file
    var base = SD.normalizeBase(options.baseName || basenameFromFile(file))
    var overwrite = options.overwrite !== false
    var logEl = options.logEl
    var onProgress = options.onProgress || function () {}
    var api = options.api || new mw.Api()

    clearLog(logEl)
    log(logEl, '读取文件…')

    readFileAsText(
      file,
      function (text) {
        var doc
        try {
          doc = JSON.parse(text)
        } catch (e) {
          onErr(new Error('JSON 解析失败：' + e.message))
          return
        }
        var plan
        try {
          plan = SD.planUpload(base, doc)
        } catch (planErr) {
          onErr(planErr)
          return
        }
        if (plan.mode === 'single') {
          log(logEl, '将单页上传（' + plan.pages[0].title + '）')
        } else {
          log(logEl, '将分 ' + plan.partCount + ' 片上传')
        }

        var existingIndex = null
        var knownOldParts = 0

        function executePlan() {
          var toDelete = []
          if (overwrite) {
            toDelete = SD.cleanupTitlesForOverwrite(existingIndex, plan, knownOldParts)
          }
          var tasks = []
          var di
          for (di = 0; di < toDelete.length; di++) {
            ;(function (delTitle) {
              tasks.push(function (next) {
                onProgress('删除 ' + delTitle)
                deletePage(api, delTitle, 'StructureRender 上传覆盖：移除过时分片', function () {
                  next()
                })
              })
            })(toDelete[di])
          }
          var pi
          for (pi = 0; pi < plan.pages.length; pi++) {
            ;(function (page, idx) {
              tasks.push(function (next, err) {
                onProgress('上传 ' + idx + '/' + plan.pages.length)
                log(logEl, '[' + idx + '/' + plan.pages.length + '] ' + page.title)
                var sum =
                  plan.mode === 'single'
                    ? 'StructureRender：上传结构数据'
                    : 'StructureRender：上传结构数据（分片 ' + idx + '/' + plan.pages.length + '）'
                editPage(api, page.title, page.text, sum, function () {
                  next()
                }, err)
              })
            })(plan.pages[pi], pi + 1)
          }
          if (toDelete.length) {
            log(logEl, '覆盖：清理旧分片 ' + toDelete.length + ' 页…')
          }
          runTasksSequential(tasks, function () {
            log(logEl, '完成。词条请使用 data-wsr-structure="' + base + '"')
            onDone({ plan: plan, base: base })
          }, onErr)
        }

        if (!overwrite) {
          fetchIndexDoc(api, base, function (idx) {
            if (idx) {
              onErr(
                new Error(
                  '已存在 ' +
                    SD.indexTitle(base) +
                    '。勾选「覆盖已有数据」后再上传，或换一个结构名称。'
                )
              )
              return
            }
            executePlan()
          }, onErr)
          return
        }

        fetchIndexDoc(api, base, function (idx) {
          existingIndex = idx
          if (idx && SD.isMultipartIndex(idx)) {
            knownOldParts = idx.partCount
            if (knownOldParts > 0) {
              log(logEl, '检测到旧分片约 ' + knownOldParts + ' 页')
            }
            executePlan()
            return
          }
          probeExistingPartCount(api, base, 32, function (n) {
            knownOldParts = n
            if (knownOldParts > 0) {
              log(logEl, '检测到旧分片约 ' + knownOldParts + ' 页')
            }
            executePlan()
          }, onErr)
        }, onErr)
      },
      onErr
    )
  }

  function injectUploadStyles() {
    if (document.getElementById('wsr-upload-style')) {
      return
    }
    var s = document.createElement('style')
    s.id = 'wsr-upload-style'
    s.textContent =
      '.wsr-upload{max-width:40em;font-size:14px;line-height:1.5}' +
      '.wsr-upload__title{margin:0 0 .5em}' +
      '.wsr-upload__hint{color:#444;margin:0 0 1em}' +
      '.wsr-upload__field{display:block;margin:12px 0}' +
      '.wsr-upload__field span{display:block;font-weight:600;margin-bottom:4px}' +
      '.wsr-upload__base{width:100%;padding:8px;box-sizing:border-box}' +
      '.wsr-upload__check{display:block;margin:12px 0}' +
      '.wsr-upload__btn{padding:10px 20px;font-size:16px;cursor:pointer}' +
      '.wsr-upload__status{margin:12px 0;font-weight:600}' +
      '.wsr-upload-log{margin-top:12px;padding:12px;background:#1a1a1a;color:#e8e8e8;' +
      'font:12px/1.45 monospace;max-height:240px;overflow:auto;border-radius:6px}'
    document.head.appendChild(s)
  }

  function mountUploadPanel(root) {
    injectUploadStyles()
    root.innerHTML =
      '<div class="wsr-upload">' +
      '<h2 class="wsr-upload__title">结构数据上传</h2>' +
      '<p class="wsr-upload__hint">选择游戏或工作台导出的 JSON。小于约 1.9MB 将自动单页上传；更大文件会自动分片。上传完成后在词条使用 <code>data-wsr-structure="名称"</code> 即可。</p>' +
      '<label class="wsr-upload__field"><span>结构名称</span><input type="text" class="wsr-upload__base" placeholder="例如 PseudoBiosphere" /></label>' +
      '<label class="wsr-upload__field"><span>JSON 文件</span><input type="file" accept=".json,application/json" class="wsr-upload__file" /></label>' +
      '<label class="wsr-upload__check"><input type="checkbox" class="wsr-upload__overwrite" checked /> 覆盖已有同名数据（推荐）</label>' +
      '<button type="button" class="wsr-upload__btn">开始上传</button>' +
      '<p class="wsr-upload__status" aria-live="polite"></p>' +
      '<div class="wsr-upload-log"></div>' +
      '</div>'

    var baseInput = root.querySelector('.wsr-upload__base')
    var fileInput = root.querySelector('.wsr-upload__file')
    var overwriteInput = root.querySelector('.wsr-upload__overwrite')
    var btn = root.querySelector('.wsr-upload__btn')
    var statusEl = root.querySelector('.wsr-upload__status')
    var logEl = root.querySelector('.wsr-upload-log')

    fileInput.addEventListener('change', function () {
      if (fileInput.files && fileInput.files[0] && !baseInput.value.replace(/^\s+|\s+$/g, '')) {
        baseInput.value = basenameFromFile(fileInput.files[0])
      }
    })

    btn.addEventListener('click', function () {
      if (!fileInput.files || !fileInput.files[0]) {
        statusEl.textContent = '请先选择 JSON 文件'
        return
      }
      if (!mw || !mw.Api) {
        statusEl.textContent = '请在已登录的灰机 Wiki 页面中使用，并启用 StructureRenderUpload 小工具'
        return
      }
      btn.disabled = true
      statusEl.textContent = '上传中，请勿关闭页面…'
      runUpload(
        {
          file: fileInput.files[0],
          baseName: baseInput.value,
          overwrite: overwriteInput.checked,
          logEl: logEl,
          onProgress: function (msg) {
            statusEl.textContent = msg
          }
        },
        function () {
          statusEl.textContent = '上传成功'
          btn.disabled = false
        },
        function (err) {
          statusEl.textContent = '失败：' + (err && err.message ? err.message : String(err))
          log(logEl, '错误：' + statusEl.textContent)
          btn.disabled = false
        }
      )
    })
  }

  window.StructureRenderUpload = {
    runUpload: runUpload,
    mountUploadPanel: mountUploadPanel
  }

  $(function () {
    var root = document.getElementById('wsr-structure-upload-root')
    if (root) {
      mountUploadPanel(root)
    }
  })
})()
