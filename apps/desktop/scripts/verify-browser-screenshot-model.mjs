import { browserSourceBuild } from '../../../packages/browser/scripts/source-build.mjs'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { resolve, join, dirname } from 'node:path'
import { mkdir, mkdtemp, readFile, writeFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
const require = createRequire(resolve('apps/desktop/package.json'))
const { build } = browserSourceBuild(createRequire(require.resolve('vite'))('esbuild'))
const sourcePaths = {
  'drawing-model.ts': 'packages/client-ui/src/image-annotation/drawing-model.ts',
  'geometry.ts': 'packages/client-ui/src/image-annotation/geometry.ts',
  'view.ts': 'packages/client-ui/src/image-annotation/view.ts',
  'selection-geometry.ts': 'packages/client-ui/src/image-annotation/selection-geometry.ts',
  'canvas-render.ts': 'packages/client-ui/src/image-annotation/canvas-render.ts',
  'drawing-renderer.ts': 'packages/client-ui/src/image-annotation/drawing-renderer.ts',
  'compose.ts': 'apps/desktop/src/renderer/src/components/image-annotation/compose.ts',
  'magic-wand.ts': 'packages/client-ui/src/image-annotation/magic-wand.ts'
}
const output = resolve(process.env.AGENTMUX_SCREENSHOT_PROOF_OUT ?? '.local/browser-screenshot-workface/model-proof')
const work = await mkdtemp(join(tmpdir(), 'amx-screenshot-model-'))
await mkdir(output, { recursive: true })
await rm(join(output, 'receipt.json'), { force: true })
const sources = Object.fromEntries(await Promise.all(Object.entries(sourcePaths).map(async ([file, path]) => [file, await readFile(path, 'utf8')])))
const evidence = { passed: false, sourceHashes: Object.fromEntries(Object.entries(sources).map(([file, source]) => [file, createHash('sha256').update(source).digest('hex')])), cases: [] }
const proofInputs = ['apps/desktop/scripts/verify-browser-screenshot-model.mjs', 'apps/desktop/scripts/fixtures/browser-screenshot-workface/model.ts']
evidence.proofInputs = Object.fromEntries(await Promise.all(proofInputs.map(async file => [file, createHash('sha256').update(await readFile(file)).digest('hex')])))
async function run(label, mutation) {
  const compiled = join(work, label); await mkdir(compiled, { recursive: true })
  await mkdir(join(compiled, 'user-data'))
  await symlink(resolve('apps/desktop/node_modules'), join(compiled, 'node_modules'))
  const plugins = mutation ? [{ name: label, setup(build) { build.onLoad({ filter: /(?:drawing-model|drawing-renderer|canvas-render|selection-geometry|compose)\.ts$/ }, args => {
    const name = args.path.split('/').at(-1), source = sources[name]
    if (name !== mutation.file) return
    assert.equal(args.path, resolve(sourcePaths[name]), 'The mutation belongs to the original source owner')
    assert.equal(source.split(mutation.find).length, 2, 'Actual source mutation must be unique: ' + label)
    return { contents: source.replace(mutation.find, mutation.replace), loader: 'ts', resolveDir: dirname(resolve(sourcePaths[name])) }
  }) } }] : []
  await build({ bundle: true, logLevel: 'silent', absWorkingDir: process.cwd(), platform: 'browser', format: 'iife', plugins,
    entryPoints: ['apps/desktop/scripts/fixtures/browser-screenshot-workface/model.ts'], outfile: join(compiled, 'model.js') })
  await writeFile(join(compiled, 'index.html'), '<!doctype html><script src="model.js"></script>')
  await writeFile(join(compiled, 'main.cjs'), `const { app, BrowserWindow } = require('electron'); const { writeFile } = require('node:fs/promises');
process.on('uncaughtException', error => { console.error(error); app.exit(1); });
app.setPath('userData', ${JSON.stringify(join(compiled, 'user-data'))});
(async () => { await app.whenReady(); console.log('model-app-ready');
const window = new BrowserWindow({ show:false, webPreferences:{ sandbox:true, backgroundThrottling:false }});
window.webContents.on('console-message', (_event, _level, message) => console.log(message));
window.showInactive(); await window.loadFile(${JSON.stringify(join(compiled, 'index.html'))}); console.log('model-loaded');
const result = await window.webContents.executeJavaScript('window.modelProof'); console.log('model-finished');
await writeFile(${JSON.stringify(join(compiled, 'receipt.json'))}, JSON.stringify(result)); window.destroy(); app.exit(result.passed ? 0 : 1);
})().catch(error => { console.error(error); app.exit(1); });`)
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  const result = await new Promise((done, reject) => {
    const child = spawn(require('electron'), [join(compiled, 'main.cjs')], { env, stdio: ['ignore', 'pipe', 'pipe'] }); let output = '', escalation
    for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { output += bytes })
    const timer = setTimeout(() => { child.kill('SIGTERM'); escalation = setTimeout(() => child.kill('SIGKILL'), 1500) }, 20000)
    child.on('error', reject); child.on('exit', code => { clearTimeout(timer); clearTimeout(escalation); done({ code, output }) })
  })
  const receipt = JSON.parse(await readFile(join(compiled, 'receipt.json'), 'utf8').catch(error => { throw new Error('Model child produced no receipt: ' + JSON.stringify(result), { cause: error }) }))
  if (mutation) { assert.equal(result.code, 1, JSON.stringify(receipt)); assert.equal(receipt.passed, false); assert.match(receipt.failure, mutation.failure) }
  else { assert.equal(result.code, 0, result.output + JSON.stringify(receipt)); assert.equal(receipt.passed, true); assert.equal(receipt.cases.length, 14); assert.equal(receipt.enhancements.length, 4); assert.equal(receipt.pointing.length, 7); assert.equal(receipt.wand.length, 19) }
  if (receipt.png) { await writeFile(join(output, label + '.png'), Buffer.from(receipt.png.dataUrl.split(',')[1], 'base64')); delete receipt.png }
  await writeFile(join(output, label + '.json'), JSON.stringify({ ...receipt, process: result }, null, 2))
  evidence.cases.push({ label, result: mutation ? 'RED' : 'GREEN' }); console.log(label + ': ' + (mutation ? 'expected RED' : 'GREEN'))
}
try {
  await run('source')
  if (process.argv.includes('--mutations')) {
    await run('crop-omitted', { file: 'compose.ts', find: 'if (!input.crop) return output', replace: 'return output', failure: /crop must change/ })
    await run('pixelation-omitted', { file: 'drawing-renderer.ts', find: "case 'pixelate': drawPixelate(context, shape); break", replace: "case 'pixelate': break", failure: /pixelate must change/ })
    await run('move-omitted', { file: 'drawing-model.ts', find: 'const move = (at: ScreenshotPoint) => ({ x: at.x + dx, y: at.y + dy })', replace: 'const move = (at: ScreenshotPoint) => at', failure: /move must preserve/ })
    await run('cover-omitted', { file: 'drawing-renderer.ts', find: "case 'cover': drawCover(context, shape); break", replace: "case 'cover': break", failure: /fractional cover must be opaque/ })
    await run('masked-note-filter-omitted', { file: 'drawing-model.ts', find: 'return !masks.some(mask => maskIntersectsRect(mask, shapeBounds(shape)))', replace: 'return true', failure: /cover output must omit masked note data/ })
    await run('mask-protection-omitted', { file: 'canvas-render.ts', find: 'if (moving.length && !moving.some(isScreenshotMask) && masks.length)', replace: 'if (false)', failure: /live ink must not replace processed cover/ })
    await run('brush-clip-omitted', { file: 'drawing-renderer.ts', find: 'clipPixelateBrush(context, shape)', replace: 'void shape', failure: /brush pixelation must preserve the empty corridor/ })
    await run('multiline-raster-omitted', { file: 'drawing-renderer.ts', find: 'shape.at.y + index * shape.fontSize * SCREENSHOT_TEXT_LINE_HEIGHT', replace: 'shape.at.y', failure: /multiline text must paint its actual second line/ })
    await run('viewport-allocation-magnified', { file: 'canvas-render.ts', find: 'Math.round(viewport.width * dpr)', replace: 'Math.round(viewport.width * dpr * viewport.view.scale)', failure: /viewport allocation must use visible area/ })
    await run('blur-filter-omitted', { file: 'drawing-renderer.ts', find: 'context.filter = `blur(${radius}px)`', replace: "context.filter = 'none'", failure: /blur must remove the actual stripe contrast/ })
    await run('spotlight-under-masks', { file: 'drawing-model.ts', find: "  return shape.kind === 'callout' ? 2 : shape.kind === 'spotlight' ? 3 : 0", replace: "  return shape.kind === 'callout' ? 2 : 0", failure: /spotlight must dim masks outside it/ })
    await run('callout-under-masks', { file: 'drawing-model.ts', find: "  return shape.kind === 'callout' ? 2 : shape.kind === 'spotlight' ? 3 : 0", replace: "  return shape.kind === 'spotlight' ? 3 : 0", failure: /callout bubble must show the pixelated pixels/ })
    await run('outline-clip-omitted', { file: 'drawing-renderer.ts', find: "if ('outline' in shape && shape.outline && shape.kind !== 'spotlight') clipOutline(context, shape.outline)", replace: 'void clipOutline', failure: /an outlined mask must leave its notch original/ })
    await run('outline-even-odd-lost', { file: 'drawing-model.ts', find: '    for (let index = 0; index + 1 < xs.length; index += 2) if (xs[index + 1]! > xs[index]!) rects.push({ x: xs[index]!, y: top, width: xs[index + 1]! - xs[index]!, height })', replace: '    if (xs.length > 1) rects.push({ x: xs[0]!, y: top, width: xs.at(-1)! - xs[0]!, height })', failure: /an outline hole must keep its original pixels/ })
    await run('outline-clip-antialiased', { file: 'drawing-renderer.ts', find: 'function clipOutline(context: CanvasRenderingContext2D, outline: ScreenshotOutline): void {\n', replace: "function clipOutline(context: CanvasRenderingContext2D, outline: ScreenshotOutline): void {\n  context.beginPath(); outlinePath(context, outline); context.clip('evenodd'); return\n", failure: /an outlined mask must cover every device pixel an outline touches at a fractional scale/ })
    await run('outline-protection-by-rect', { file: 'canvas-render.ts', find: 'applyView(context, viewport); clipMarkArea(context, mask); context.setTransform(1, 0, 0, 1, 0, 0)', replace: "if (mask.kind === 'pixelate-brush') { applyView(context, viewport); clipMarkArea(context, mask); context.setTransform(1, 0, 0, 1, 0, 0) }", failure: /live ink must show in an outlined mask's notch/ })
    await run('adjust-filter-omitted', { file: 'drawing-renderer.ts', find: '    target.filter = filter\n', replace: '\n', failure: /brightness must lift the actual dark stripe/ })
    await run('adjust-region-unclipped', { file: 'drawing-renderer.ts', find: "case 'adjust': drawAdjust(context, shape); break", replace: "case 'adjust': context.restore(); context.save(); drawAdjust(context, shape); break", failure: /region adjustment must keep every pixel outside/ })
    await run('adjust-after-callouts', { file: 'drawing-model.ts', find: "  if (shape.kind === 'adjust') return -1", replace: "  if (shape.kind === 'adjust') return 4", failure: /callout must magnify the adjusted pixels/ })
    await run('region-highlight-omitted', { file: 'drawing-renderer.ts', find: "case 'region-highlight': {", replace: "case 'region-highlight': break; {", failure: /region highlight must tint the source/ })
    await run('region-highlight-opaque', { file: 'drawing-renderer.ts', find: "case 'region-highlight': {\n        context.globalAlpha = HIGHLIGHT_ALPHA", replace: "case 'region-highlight': {\n        context.globalAlpha = 1", failure: /region highlight must tint the source/ })
    await run('region-highlight-unclipped', { file: 'drawing-renderer.ts', find: "if ('outline' in shape && shape.outline && shape.kind !== 'spotlight') clipOutline(context, shape.outline)", replace: "if ('outline' in shape && shape.outline && shape.kind !== 'spotlight' && shape.kind !== 'region-highlight') clipOutline(context, shape.outline)", failure: /region highlight must leave its hole, notch and every outside pixel unchanged/ })

    await run('restored-source')
  }
  for (const [file, source] of Object.entries(sources)) assert.equal(await readFile(sourcePaths[file], 'utf8'), source, 'Model source changed during native verification: ' + file)
  for (const [file, hash] of Object.entries(evidence.proofInputs)) assert.equal(createHash('sha256').update(await readFile(file)).digest('hex'), hash, 'Model proof changed during verification: ' + file)
  evidence.passed = true; await writeFile(join(output, 'receipt.json'), JSON.stringify(evidence, null, 2))
} finally { await rm(work, { recursive: true, force: true }) }
