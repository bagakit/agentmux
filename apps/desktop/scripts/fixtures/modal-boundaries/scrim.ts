import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { BrowserWindow, WebContentsView } from 'electron'
import { NativeOverlaySurfaces } from '../../../src/main/native-overlay-surfaces'
import { proof, output, delay, pixel, screenshot } from './common'

void proof(async receipt => {
  const window = new BrowserWindow({ width: 800, height: 600, useContentSize: true, show: false, webPreferences: { backgroundThrottling: false } })
  await window.loadURL('data:text/html,<style>html,body{margin:0;background:white}aside{position:fixed;left:300px;top:180px;width:200px;height:120px;background:rgb(32,48,64);border-radius:20px}</style><aside>Original modal content</aside>')
  const browsers = [{ x: 0, y: 0, width: 800, height: 600 }]
  const nativePages: WebContentsView[] = []
  const installPages = async () => {
    for (const page of nativePages.splice(0)) { window.contentView.removeChildView(page); page.webContents.close() }
    for (const bounds of browsers) {
      const page = new WebContentsView({ webPreferences: { backgroundThrottling: false } }); nativePages.push(page)
      page.setBounds(bounds); window.contentView.addChildView(page); await page.webContents.loadURL('data:text/html,<style>body{background:white}</style>')
    }
  }
  await installPages(); window.showInactive()
  const warnings: unknown[] = [], surfaces = new NativeOverlaySurfaces(window, { visibleNativeBounds: () => browsers,
    nativeOwner: (id: string) => { const index = nativePages.findIndex((_page, i) => id === 'scrim-browser-' + i), view = nativePages[index]; return view ? { browserId: id, bounds: view.getBounds(), view } : undefined },
    nativeOwnerForView: () => undefined } as any, message => warnings.push(message), () => {})
  for (const scenario of ['full', 'two-pages', 'overlapping-pages', 'opaque-exclusion', 'contained-page-hole', 'resized'] as const) {
    await surfaces.update([])
    if (scenario === 'two-pages') browsers.splice(0, browsers.length, { x: 20, y: 30, width: 330, height: 520 }, { x: 410, y: 20, width: 370, height: 550 })
    if (scenario === 'overlapping-pages') browsers.splice(0, browsers.length, { x: 0, y: 0, width: 600, height: 600 }, { x: 200, y: 100, width: 600, height: 500 })
    if (scenario === 'opaque-exclusion') browsers.splice(0, browsers.length, { x: 0, y: 0, width: 800, height: 600 })
    if (scenario === 'contained-page-hole') browsers.splice(0, browsers.length, { x: 340, y: 200, width: 80, height: 70 })
    if (scenario === 'resized') { window.setContentSize(640, 410); window.webContents.setZoomFactor(1.25); browsers.splice(0, browsers.length, { x: 0, y: 0, width: 640, height: 410 }) }
    await installPages()
    const { width, height } = window.getContentBounds()
    const hole = scenario === 'contained-page-hole', exclusion = scenario === 'opaque-exclusion' || hole
    await surfaces.update([...(exclusion ? [{ id: 'chrome-1', bounds: { x: 300, y: 180, width: 200, height: 120 }, radius: 20,
      ...(hole ? { browserStages: [{ browserId: 'scrim-browser-0', bounds: browsers[0]! }] } : {}) }] : []),
      { id: exclusion ? 'chrome-2' : 'chrome-1', bounds: { x: 0, y: 0, width, height }, radius: 0, scrim: 'rgba(0,0,0,0.5)' }])
    const projections = (surfaces as any).projections as Map<string, { view: WebContentsView }>, scrim = projections.get(exclusion ? 'chrome-2' : 'chrome-1')!.view
    await delay(100); const image = await scrim.webContents.capturePage()
    await writeFile(join(output, scenario + '-scrim.png'), image.toPNG())
    const samples: any[] = [], current = { scenario, width, height, browsers: structuredClone(browsers), samples }; receipt.cases.push(current)
    for (const browser of browsers) for (const [x, y] of [[browser.x + 2, browser.y + 2], [browser.x + browser.width - 3, browser.y + 2], [browser.x + 2, browser.y + browser.height - 3], [browser.x + browser.width - 3, browser.y + browser.height - 3], [browser.x + browser.width / 2, browser.y + browser.height / 2]]) {
      const bgra = pixel(image, x!, y!, width, height); samples.push({ x, y, bgra })
      assert.ok(bgra[3]! >= 126 && bgra[3]! <= 129, 'scrim pixel must cover each actual Browser corner and center exactly once: ' + JSON.stringify(samples.at(-1)))
    }
    if (scenario === 'two-pages') { const gap = pixel(image, 380, 300, width, height); samples.push({ gap }); assert.equal(gap[3], 0, 'scrim gap outside actual Browser pixels remains transparent') }
    if (scenario === 'opaque-exclusion') {
      const center = pixel(image, 400, 240, width, height), roundedCorner = pixel(image, 301, 181, width, height)
      samples.push({ excludedOpaqueCenter: center, roundedCorner })
      assert.equal(center[3], 0, 'scrim pixel excludes already captured opaque Chrome')
      assert.ok(roundedCorner[3]! >= 126 && roundedCorner[3]! <= 129, 'scrim pixel still dims Browser visible through a lower rounded corner')
    }
    if (hole) { const outsidePage = pixel(image, 320, 240, width, height); samples.push({ outsidePage }); assert.equal(outsidePage[3], 0, 'scrim pixel excludes lower Chrome while preserving its contained real Browser hole') }
    receipt.screenshots.push(await screenshot(window, scenario))
  }
  assert.deepEqual(warnings, []); surfaces.dispose()
})
