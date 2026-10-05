import { createRoot } from 'react-dom/client'
import { ExcalidrawFilePreview } from '../../../src/renderer/src/components/file-preview/ExcalidrawFilePreview'
import { createVegaPreview } from '../../../src/renderer/src/lib/file-formats/vega-worker'
import * as Vega from 'vega'
import { expressionInterpreter } from 'vega-interpreter'
import { compileVegaRuntime } from '../../../src/renderer/src/lib/file-formats/vega-spec'

const target = document.getElementById('root')!, root = createRoot(target)
const frame = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
const globals = window as unknown as Record<string, unknown>
const blockedFonts: string[] = []
document.addEventListener('securitypolicyviolation', event => { if (event.violatedDirective === 'font-src') blockedFonts.push(event.blockedURI) })
const base = { angle: 0, strokeColor: '#222222', backgroundColor: '#dae8fc', fillStyle: 'solid', strokeWidth: 1, strokeStyle: 'solid', roughness: 1, opacity: 100, groupIds: [], frameId: null, roundness: null, seed: 1, version: 1, versionNonce: 1, isDeleted: false, boundElements: null, updated: 1, link: null, locked: false }

globals.__sceneBenchmark = async () => {
  const png = document.createElement('canvas'); png.width = 8; png.height = 8
  const ctx = png.getContext('2d')!; ctx.fillStyle = '#e02020'; ctx.fillRect(0, 0, 8, 8)
  const image = { ...base, id: 'image', type: 'image', x: 50, y: 50, width: 120, height: 100, fileId: 'red', status: 'saved', scale: [1, 1] }
  const scenes = [
    { type: 'excalidraw', version: 2, elements: [image], files: { red: { id: 'red', mimeType: 'image/png', dataURL: png.toDataURL(), created: 1 } } },
    { type: 'excalidraw', version: 2, elements: [
      ...Array.from({ length: 255 }, (_, i) => ({ ...base, id: `rectangle-${i}`, type: 'rectangle', x: i % 17 * 55, y: Math.floor(i / 17) * 45, width: 45, height: 35 })),
      { ...base, id: 'stroke', type: 'freedraw', x: 10, y: 10, width: 500, height: 300, points: Array.from({ length: 10_000 }, (_, i) => [i % 500, Math.sin(i / 10) * 150 + 150]), pressures: [], simulatePressure: true, lastCommittedPoint: null }
    ], files: {} },
    { type: 'excalidraw', version: 2, elements: [
      { ...base, id: 'fit-left', type: 'rectangle', x: 20, y: 80, width: 220, height: 180, backgroundColor: '#e02020' },
      { ...base, id: 'fit-right', type: 'ellipse', x: 420, y: 80, width: 220, height: 180, backgroundColor: '#20a020' }
    ], files: {} }
  ]
  const results = []
  let viewportFit
  for (const [index, scene] of scenes.entries()) {
    let previous = performance.now(), maxTimerGap = 0
    const timer = setInterval(() => { const now = performance.now(); maxTimerGap = Math.max(maxTimerGap, now - previous); previous = now }, 4)
    const start = performance.now()
    root.render(<ExcalidrawFilePreview content={JSON.stringify(scene)} />)
    await new Promise<void>((resolve, reject) => {
      const timer = setInterval(() => {
        if (target.querySelector('canvas')) { clearInterval(timer); resolve() }
        else if (target.querySelector('[role=alert]')) { clearInterval(timer); reject(new Error(target.textContent ?? 'Scene error')) }
        else if (performance.now() - start > 15_000) { clearInterval(timer); reject(new Error('Canvas did not mount')) }
      }, 10)
    })
    await document.fonts.ready
    for (let i = 0; i < 6; i++) await frame()
    clearInterval(timer)
    let redPixels = 0
    for (const canvas of target.querySelectorAll('canvas')) {
      const pixels = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data
      for (let i = 0; i < pixels.length; i += 4) if (pixels[i]! > 180 && pixels[i + 1]! < 80 && pixels[i + 2]! < 80 && pixels[i + 3]! > 100) redPixels++
    }
    results.push({ index, elapsedMs: performance.now() - start, maxTimerGap, redPixels, canvases: target.querySelectorAll('canvas').length })
    if (index === 2) {
      target.style.width = '320px'
      for (let i = 0; i < 10; i++) await frame()
      const colored = { red: 0, green: 0, left: Infinity, right: 0, width: 0 }
      for (const canvas of target.querySelectorAll('canvas')) {
        const pixels = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data
        colored.width = Math.max(colored.width, canvas.width)
        for (let i = 0; i < pixels.length; i += 4) {
          const red = pixels[i]! > 180 && pixels[i + 1]! < 80 && pixels[i + 2]! < 80 && pixels[i + 3]! > 100
          const green = pixels[i]! < 80 && pixels[i + 1]! > 120 && pixels[i + 2]! < 80 && pixels[i + 3]! > 100
          if (red || green) { colored.red += +red; colored.green += +green; const x = i / 4 % canvas.width; colored.left = Math.min(colored.left, x); colored.right = Math.max(colored.right, x) }
        }
      }
      if (colored.red < 100 || colored.green < 100 || colored.left < 5 || colored.right > colored.width - 5) throw new Error(`Wide-to-narrow scene did not fit both elements: ${JSON.stringify(colored)}`)
      viewportFit = colored
      target.style.width = '1000px'
    }
    root.render(null); await frame()
    if (target.querySelector('canvas')) throw new Error('Hidden scene retained a canvas')
  }
  const fontFaces = await Promise.all(Array.from(document.fonts).map(async font => {
    try { await font.load(); return { family: font.family, status: font.status } }
    catch (error) { return { family: font.family, status: font.status, error: String(error) } }
  }))
  if (!fontFaces.length || fontFaces.some(font => font.status !== 'loaded')) throw new Error(`Local official font failed: ${JSON.stringify(fontFaces)}`)
  const denied = async (): Promise<never> => { throw new Error('Unexpected resource') }
  const resourceCalls: string[] = []
  const pngBytes = Uint8Array.from(atob(png.toDataURL().split(',')[1]!), character => character.charCodeAt(0))
  const loader = { load: async (uri: string) => { resourceCalls.push(uri); if (uri !== 'data.csv') return denied(); return 'label\nCLICK DATUM' }, sanitize: async (uri: string) => { resourceCalls.push(uri); if (uri !== 'red.png') return denied(); return { href: uri, bytes: pngBytes, mimeType: 'image/png' } }, http: denied, file: denied }
  const controller = new AbortController()
  const spec = { $schema: 'https://vega.github.io/schema/vega/v6.json', width: 200, height: 150,
    signals: [{ name: 'selected', value: 'none', on: [{ events: '@bars:click', update: 'datum.label' }] }, { name: 'level', value: 2, bind: { input: 'range', min: 1, max: 5 } }],
    data: [{ name: 'table', url: 'data.csv', format: { type: 'csv' } }], marks: [
      { name: 'bars', type: 'rect', from: { data: 'table' }, encode: { update: { x: { value: 10 }, y: { value: 10 }, width: { value: 80 }, height: { value: 40 }, fill: { value: '#4682b4' } }, hover: { fill: { value: '#ff0000' } } } },
      { type: 'text', encode: { update: { x: { value: 10 }, y: { value: 100 }, text: { signal: "selected + ':' + level" } } } },
      { type: 'image', encode: { enter: { url: { value: 'red.png' }, x: { value: 110 }, y: { value: 20 } } } }
    ] }
  let latest = '', resolveFrame: ((svg: string) => void) | undefined
  const frameResult = () => new Promise<string>(resolve => { resolveFrame = resolve })
  const first = frameResult()
  const preview = createVegaPreview(JSON.stringify(spec), 'vega', loader, controller.signal, { snapshot(value) { latest = value.svg; resolveFrame?.(value.svg); resolveFrame = undefined }, error(error) { throw error } })
  await first
  const explicitWidth = Number(latest.match(/width="([\d.]+)"/)?.[1])
  const clicked = frameResult(); preview.event({ source: 'view', type: 'click', x: 30, y: 30 })
  await clicked
  if (!latest.includes('CLICK DATUM:2')) throw new Error('Worker did not deliver the actual click datum')
  const changed = frameResult(); preview.setSignal('level', 4); await changed
  if (!latest.includes('CLICK DATUM:4')) throw new Error('Worker did not deliver bound signal changes')
  const hovered = frameResult(); preview.event({ source: 'view', type: 'pointermove', x: 30, y: 30 }); await hovered
  if (!latest.includes('#ff0000')) throw new Error('Worker did not apply official hover encoding')
  const resized = frameResult(); preview.resize(333); await resized
  if (Number(latest.match(/width="([\d.]+)"/)?.[1]) !== explicitWidth || !latest.includes('data:image/png;base64,')) throw new Error(`Worker changed explicit chart width or lost the original image: ${latest}`)
  const painted = new Image(); painted.src = URL.createObjectURL(new Blob([latest], { type: 'image/svg+xml' })); await painted.decode()
  const paint = document.createElement('canvas'); paint.width = painted.width; paint.height = painted.height
  const paintContext = paint.getContext('2d')!; paintContext.drawImage(painted, 0, 0)
  const pixel = paintContext.getImageData(117, 27, 1, 1).data
  if (pixel[0]! < 180 || pixel[1]! > 80 || pixel[2]! > 80) throw new Error('Worker SVG lost the actual Workspace image pixels')
  URL.revokeObjectURL(painted.src)
  const vegaSvg = latest
  controller.abort(); preview.dispose()
  const lite = new AbortController(), liteFirst = frameResult()
  const litePreview = createVegaPreview(JSON.stringify({ $schema: 'https://vega.github.io/schema/vega-lite/v6.json', width: 'container', height: 100, data: { values: [{ x: 'a', y: 3 }, { x: 'b', y: 5 }] }, mark: 'bar', encoding: { x: { field: 'x', type: 'nominal' }, y: { field: 'y', type: 'quantitative' } } }), 'vega-lite', loader, lite.signal, { snapshot(value) { latest = value.svg; resolveFrame?.(value.svg); resolveFrame = undefined }, error(error) { throw error } })
  await liteFirst
  const liteSized = frameResult(); litePreview.resize(333, 222); await liteSized
  if (Number(latest.match(/width="([\d.]+)"/)?.[1]) !== 333 || !latest.includes('aria-label="x: a; y: 3"')) throw new Error(`Responsive Vega-Lite failed: ${latest}`)
  lite.abort(); litePreview.dispose()
  // Demonstrate the old dataflow cost in a private test Renderer, then cancel a larger worker job.
  const explosive = (stop: number) => JSON.stringify({ $schema: 'https://vega.github.io/schema/vega/v6.json', data: [{ name: 'large', transform: [{ type: 'sequence', start: 0, stop }] }] })
  let previous = performance.now(), maxGap = 0, ticks = 0
  const heartbeat = setInterval(() => { const now = performance.now(); maxGap = Math.max(maxGap, now - previous); previous = now; ticks++ }, 4)
  const baselineStart = performance.now()
  const old = new Vega.View(compileVegaRuntime(explosive(5_000_000), 'vega').runtime, { renderer: 'none', expr: expressionInterpreter, loader })
  await old.runAsync(); old.finalize(); await new Promise(resolve => setTimeout(resolve, 10))
  const baseline = { elapsedMs: performance.now() - baselineStart, maxGap }
  clearInterval(heartbeat)
  const busy = new AbortController()
  let evaluating!: () => void
  const started = new Promise<void>(resolve => { evaluating = resolve })
  const huge = createVegaPreview(explosive(100_000_000), 'vega', loader, busy.signal, { snapshot() { throw new Error('Explosive worker finished before cancellation') }, error(error) { throw error }, phase() { evaluating() } })
  await started
  previous = performance.now(); maxGap = 0; ticks = 0
  const alive = setInterval(() => { const now = performance.now(); maxGap = Math.max(maxGap, now - previous); previous = now; ticks++ }, 4)
  await new Promise(resolve => setTimeout(resolve, 24))
  const cancelStart = performance.now(); busy.abort(); huge.dispose()
  await new Promise(resolve => setTimeout(resolve, 20)); clearInterval(alive)
  const cancellation = { elapsedMs: performance.now() - cancelStart, maxGap, ticks }
  if (ticks < 4 || maxGap > 100) throw new Error('Busy chart starved the App Renderer heartbeat')
  return { scenes: results, viewportFit, fonts: { faces: fontFaces, blocked: blockedFonts }, vegaSvg, vegaInteraction: true, vegaLiteResponsive: true, resourceCalls, vegaImagePixel: Array.from(pixel), baseline, cancellation, remainingCanvases: target.querySelectorAll('canvas').length }
}
