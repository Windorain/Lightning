import { expect, test } from '@playwright/test'
import JSZip from 'jszip'
import path from 'node:path'
import fs from 'node:fs'

async function waitWorkbenchReady(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/?sceneId=export')
  await page.waitForFunction(
    () => (window as any).__vm_ready__ === true,
    { timeout: 30_000 },
  )
}

async function switchToExportTab(page: import('@playwright/test').Page): Promise<void> {
  await page.click('.wt-tab:has-text("导出")')
  await page.waitForSelector('.ew-root', { timeout: 10_000 })
}

test.describe('OBJ export — blob capture (Chromium)', () => {
  test('connected mode: builtin scene yields valid ZIP', async ({ page }) => {
    const errors: string[] = []
    page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()) })

    await waitWorkbenchReady(page)

    const base64Data = await page.evaluate(async () => {
      const ctx = (window as any).__vm__
      const doc = ctx.getDoc().value?.serialize()
      if (!doc) throw new Error('No document')
      const { buildStructureBundleZip } = await import('/src/workbench/export/bundleMeshAssembly.ts')
      const { loadStructureOrWorld } = await import('/src/render/data/bundleResolve')
      const def = loadStructureOrWorld(doc, undefined)
      const blob = await buildStructureBundleZip(def, doc, { mode: 'connected' })
      return new Promise<string>((resolve, reject) => {
        const reader = new FileReader()
        reader.onloadend = () => resolve((reader.result as string).split(',')[1]!)
        reader.onerror = reject
        reader.readAsDataURL(blob)
      })
    })

    const buffer = Buffer.from(base64Data, 'base64')
    expect(buffer.slice(0, 4).toString('hex')).toBe('504b0304')
    const zip = await JSZip.loadAsync(buffer)
    expect(Object.keys(zip.files).filter(k => !zip.files[k]!.dir).length).toBeGreaterThan(0)
    expect(errors.filter(e => !e.includes('favicon'))).toEqual([])
  })

  test('multi-block connected: 8 components ZIP valid', async ({ page }) => {
    await waitWorkbenchReady(page)
    const base64Data = await page.evaluate(async () => {
      const pngB64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
      const quad = { materialIndex: 0, vertices: [
        { x: 1, y: 1, z: 0, u: 0, v: 0 }, { x: 1, y: 1, z: 1, u: 1, v: 0 },
        { x: 1, y: 0, z: 0, u: 0, v: 1 }, { x: 1, y: 0, z: 1, u: 1, v: 1 }] }
      const S = 4
      const cellGrid: number[][][] = Array.from({length:S}, (_,z) =>
        Array.from({length:S}, (_,y) =>
          Array.from({length:S}, (_,x) => (x%2===0&&y%2===0&&z%2===0)?1:0)))
      const blockPalette = [
        { registryId:'air',meta:0,renderMode:'BakedModel',geometry:{encoding:'bakedQuadsJsonV1',quads:[]},occludesAdjacentFaces:false },
        { registryId:'test:block',meta:0,renderMode:'BakedModel',geometry:{encoding:'bakedQuadsJsonV1',quads:[quad]},occludesAdjacentFaces:true }]
      const doc = { geometryPhase:'baked',id:'t',cellGrid,blockPalette,
        materialPalette:[{textureBlobIndex:0,blend:'opaque'}],textureBlobs:[pngB64] }
      const { buildStructureBundleZip } = await import('/src/workbench/export/bundleMeshAssembly.ts')
      const { loadStructureOrWorld } = await import('/src/render/data/bundleResolve')
      const def = loadStructureOrWorld(doc, undefined)
      const blob = await buildStructureBundleZip(def, doc, { mode: 'connected' })
      return new Promise<string>((resolve, reject) => {
        const r = new FileReader()
        r.onloadend = () => resolve((r.result as string).split(',')[1]!)
        r.onerror = reject; r.readAsDataURL(blob)
      })
    })
    const buffer = Buffer.from(base64Data, 'base64')
    const hex = buffer.slice(0, 4).toString('hex')
    console.log(`Multi ZIP: ${buffer.length}b, hex=${hex}`)
    expect(hex).toBe('504b0304')
    const zip = await JSZip.loadAsync(buffer)
    const names = Object.keys(zip.files).filter(k => !zip.files[k]!.dir)
    expect(names.length).toBeGreaterThanOrEqual(10)
  })
})

test.describe('OBJ export — real download click (Chromium)', () => {
  test('connected mode: click button → capture download → validate ZIP', async ({ page }) => {
    const errors: string[] = []
    page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()) })

    await waitWorkbenchReady(page)
    await switchToExportTab(page)

    // 点击"连通模式 .zip" 按钮，捕获真实浏览器下载
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 60_000 }),
      page.click('button.ew-btn:has-text("连通模式")'),
    ])

    // Playwright 1.60: download.path() 返回 Promise<string | null>
    const downloadPath = await download.path()
    expect(downloadPath).toBeTruthy()
    console.log(`Download saved to: ${downloadPath}`)

    const buffer = fs.readFileSync(downloadPath!)
    console.log(`Downloaded file size: ${buffer.length}`)
    const hex = buffer.slice(0, 4).toString('hex')
    console.log(`Downloaded file header: ${hex}`)

    expect(hex).toBe('504b0304')
    const zip = await JSZip.loadAsync(buffer)
    const names = Object.keys(zip.files).filter(k => !zip.files[k]!.dir)
    console.log(`Files: ${names.join(', ')}`)
    expect(names.length).toBeGreaterThan(0)
    expect(errors.filter(e => !e.includes('favicon'))).toEqual([])
  })
})

test.describe('OBJ export — Firefox', () => {
  test('connected mode: blob capture in Firefox yields valid ZIP', async ({ page }) => {
    // 这个测试仅在 firefox project 下运行
    await waitWorkbenchReady(page)

    const base64Data = await page.evaluate(async () => {
      const ctx = (window as any).__vm__
      const doc = ctx.getDoc().value?.serialize()
      if (!doc) throw new Error('No document')
      const { buildStructureBundleZip } = await import('/src/workbench/export/bundleMeshAssembly.ts')
      const { loadStructureOrWorld } = await import('/src/render/data/bundleResolve')
      const def = loadStructureOrWorld(doc, undefined)
      const blob = await buildStructureBundleZip(def, doc, { mode: 'connected' })
      return new Promise<string>((resolve, reject) => {
        const r = new FileReader()
        r.onloadend = () => resolve((r.result as string).split(',')[1]!)
        r.onerror = reject; r.readAsDataURL(blob)
      })
    })

    const buffer = Buffer.from(base64Data, 'base64')
    const hex = buffer.slice(0, 4).toString('hex')
    console.log(`Firefox ZIP: ${buffer.length}b, hex=${hex}`)
    expect(hex).toBe('504b0304')
    // Also verify the ZIP contains correct OBJ structure
    const text = buffer.slice(0, 200).toString('utf-8')
    // ZIPs store filenames; look for structure.obj filename
    expect(text).toContain('structure.obj')
  })
})
