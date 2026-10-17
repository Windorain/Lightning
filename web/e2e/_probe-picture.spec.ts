import { expect, test } from '@playwright/test'
import { gotoWorkbench, waitForDocLoaded, waitForViewportMounted, waitForRenderedGrid } from './helpers/multiblock'

test('probe geometry scale', async ({ page }) => {
  test.skip(test.info().project.name !== 'desktop-chrome', 'desktop only')
  await page.setViewportSize({ width: 1280, height: 800 })
  await gotoWorkbench(page)
  await page.getByRole('button', { name: '设置', exact: true }).click()
  const drawer = page.locator('.drawer-panel')
  await drawer.getByRole('button', { name: '内置示例', exact: true }).click()
  await drawer.locator('select').selectOption('builtin-multiblock-ebf')
  await drawer.getByRole('button', { name: '加载到工作台' }).click()
  await waitForDocLoaded(page)
  await waitForViewportMounted(page)
  await waitForRenderedGrid(page)
  await drawer.getByRole('button', { name: '关闭' }).click()
  await page.waitForTimeout(1200)
  const info = await page.evaluate(() => {
    const vm = (window as any).__vm__
    const slot = vm.viewports?.get('r-viewport');
    const surf = slot?.presenterSurface;
    const inputs = surf?.inputsSnapshot?.();
    const boxes: unknown[] = [];
    const grp = slot?.contentGroup?.value;
    if (grp) grp.traverse((o: any) => { if (o?.isMesh) { const pos = o.geometry?.getAttribute?.('position'); if (pos) { let min = Infinity, max = -Infinity; for (let i = 0; i < pos.count; i++) { const y = pos.getY(i); if (y < min) min = y; if (y > max) max = y; } let xmin = Infinity, xmax = -Infinity, zmin = Infinity, zmax = -Infinity; for (let i = 0; i < pos.count; i++) { const x = pos.getX(i), z = pos.getZ(i); if (x < xmin) xmin = x; if (x > xmax) xmax = x; if (z < zmin) zmin = z; if (z > zmax) zmax = z; } boxes.push({ y: [min, max], x: [xmin, xmax], z: [zmin, zmax], verts: pos.count }); } } });
    const prim = inputs?.primitives?.map((p: any) => ({ geo: p.geometry.id, bounds: p.bounds, mat: p.material.id }));
    return { boxes, prim } ;
  });
  console.log('PROBE ' + JSON.stringify(info));
  expect(info.boxes.length).toBeGreaterThan(0)
})
