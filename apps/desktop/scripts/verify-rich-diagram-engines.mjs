import { fixturePath as _hygiene_fixturePath } from "./lib/fixture-values.mjs"
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { deflateRawSync } from 'node:zlib'

const desktop = resolve(import.meta.dirname, '..'), require = createRequire(join(desktop, 'package.json'))
const { build, createServer } = await import(pathToFileURL(require.resolve('vite')).href)
const { build: bundle } = createRequire(require.resolve('vite/package.json'))('esbuild')
const privateRoot = await mkdtemp(_hygiene_fixturePath("tmp/amx-rich-engines-"))
const pluginModule = join(desktop, '.tmp', `rich-assets-${process.pid}.mjs`)
let child, devServer
try {
  await mkdir(dirname(pluginModule), { recursive: true })
  await bundle({ entryPoints: [join(desktop, 'scripts/file-diagram-assets.ts')], outfile: pluginModule, bundle: true, platform: 'node', format: 'esm', logLevel: 'error' })
  const { fileDiagramAssets } = await import(pathToFileURL(pluginModule).href)
  const out = join(privateRoot, 'renderer')
  await build({ configFile: false, root: join(desktop, 'src/renderer'), base: './', logLevel: 'error',
    build: { outDir: out, emptyOutDir: true, rollupOptions: { input: join(desktop, 'src/renderer/file-diagram/index.html') } } })
  await cp(join(desktop, 'vendor/drawio/v32.4.1'), join(out, 'diagram-assets/drawio'), { recursive: true })
  const plantuml = join(out, 'diagram-assets/plantuml')
  await mkdir(plantuml, { recursive: true })
  for (const file of ['plantuml.js', 'viz-global.js', 'themes.js', 'emoji.js', 'openiconic.js', 'LICENSE']) {
    await cp(join(desktop, 'node_modules/@plantuml/core', file), join(plantuml, file))
  }
  const native = join(privateRoot, 'native.mjs')
  await bundle({ entryPoints: [join(desktop, 'src/main/file-diagram-renderer.ts')], outfile: native, bundle: true, platform: 'node', format: 'esm', external: ['electron'], logLevel: 'error' })
  // An .mjs under fixtureRoot/tmp resolves electron through this private link, never through a different app.
  const { symlink } = await import('node:fs/promises')
  await mkdir(join(privateRoot, 'node_modules'), { recursive: true })
  await symlink(join(desktop, 'node_modules/electron'), join(privateRoot, 'node_modules/electron'))
  const sceneOut = join(privateRoot, 'scene-renderer')
  await build({ configFile: false, root: join(desktop, 'test/fixtures/rich-file-preview'), base: './', logLevel: 'error', esbuild: { jsx: 'automatic' },
    plugins: [fileDiagramAssets(desktop)],
    build: { outDir: sceneOut, emptyOutDir: true } })
  devServer = await createServer({ configFile: false, root: join(desktop, 'test/fixtures/rich-file-preview'), cacheDir: join(privateRoot, 'dev-cache'), logLevel: 'error',
    esbuild: { jsx: 'automatic' }, plugins: [fileDiagramAssets(desktop)], server: { host: '127.0.0.1', port: 0 } })
  await devServer.listen()
  const devUrl = `http://127.0.0.1:${devServer.httpServer.address().port}/`
  const model = label => `<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/><mxCell id="2" value="${label}" style="rounded=1;whiteSpace=wrap;html=1;fillColor=#dae8fc" vertex="1" parent="1"><mxGeometry x="40" y="40" width="200" height="80" as="geometry"/></mxCell></root></mxGraphModel>`
  const compressed = deflateRawSync(encodeURIComponent(model('Unsaved compressed second page'))).toString('base64')
  const drawio = `<mxfile><diagram name="One">${model('Unsaved first page')}</diagram><diagram name="Two">${compressed}</diagram></mxfile>`
  const requests = [
    { id: 'drawio-first', kind: 'drawio', content: drawio, page: 0 },
    { id: 'drawio-second', kind: 'drawio', content: drawio, page: 1 },
    { id: 'drawio-invalid', kind: 'drawio', content: '<config />' },
    { id: 'plantuml-sequence', kind: 'plantuml', content: '@startuml\nAlice -> Bob : Unsaved sequence\n@enduml' },
    { id: 'plantuml-class', kind: 'plantuml', content: '@startuml\nclass DraftClass\nclass Dependency\nDraftClass --> Dependency\n@enduml' },
    { id: 'plantuml-activity', kind: 'plantuml', content: '@startuml\nstart\n:Draft activity;\nstop\n@enduml' },
    { id: 'plantuml-theme', kind: 'plantuml', content: '@startuml\n!theme cerulean\nAlice -> Bob : Local theme\n@enduml' },
    { id: 'mermaid-flow', kind: 'mermaid', content: 'flowchart LR\nDraft[Unsaved flow] --> Result' },
    { id: 'mermaid-sequence', kind: 'mermaid', content: 'sequenceDiagram\nAlice->>Bob: Unsaved message' }
  ].map(item => ({ ...item, theme: 'light' }))
  const requestFile = join(privateRoot, 'requests.json')
  await writeFile(requestFile, JSON.stringify(requests))
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  const output = await new Promise((yes, no) => {
    child = spawn(require('electron'), [join(desktop, 'test/fixtures/rich-file-preview/main.cjs'), native, join(out, 'file-diagram/index.html'), requestFile, join(privateRoot, 'user-data'), join(sceneOut, 'index.html'), devUrl], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    const timeout = setTimeout(() => { child.kill('SIGKILL'); no(new Error(`Native engine verification timed out. ${stderr}`)) }, 60_000)
    child.stdout.on('data', bytes => { stdout += bytes }); child.stderr.on('data', bytes => { stderr += bytes })
    child.on('error', error => { clearTimeout(timeout); no(error) })
    child.on('close', (code, signal) => { clearTimeout(timeout); if (code !== 0) no(new Error(`Electron exit ${code}/${signal}: ${stderr}\n${stdout}`)); else yes(stdout) })
  })
  const report = JSON.parse(output.split('\n').find(line => line.startsWith('AMX_RICH_RESULTS=')).slice('AMX_RICH_RESULTS='.length))
  console.log(JSON.stringify({ observed: report.results.map(({ id, svg, ...rest }) => ({ id, svgBytes: svg.length, ...rest })) }))
  for (const result of report.results) {
    assert.equal(result.remainingWindows, 0, result.id)
    if (result.id === 'drawio-invalid') { assert.match(result.error, /model/); continue }
    assert.equal(result.error, undefined, `${result.id}: ${result.error}`)
    assert.match(result.svg, /<svg/)
    const expected = {
      'drawio-first': 'Unsaved first page', 'drawio-second': 'Unsaved compressed second page',
      'plantuml-sequence': 'Unsaved sequence', 'plantuml-class': 'DraftClass', 'plantuml-activity': 'Draft activity',
      'plantuml-theme': 'Local theme', 'mermaid-flow': 'Unsaved flow', 'mermaid-sequence': 'Unsaved message'
    }[result.id]
    assert.ok(result.svg.includes(expected) || result.svg.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').includes(expected), `${result.id} lost the current source`)
    if (result.id.startsWith('drawio')) assert.equal(result.pageCount, 2)
  }
  assert.ok(report.bridges.length >= 8)
  for (const bridge of report.bridges) assert.deepEqual(bridge, { agentmux: 'undefined', require: 'undefined' })
  assert.match(report.cancelled.error, /cancelled/)
  assert.equal(report.remainingWindows, 0)
  assert.ok(report.scene.scenes[0].redPixels > 1000, 'The real embedded image did not paint')
  assert.ok(report.scene.viewportFit.red > 100 && report.scene.viewportFit.green > 100)
  assert.ok(report.scene.fonts.faces.length > 0 && report.scene.fonts.faces.every(font => font.status === 'loaded'))
  assert.deepEqual(report.scene.fonts.blocked, [])
  assert.ok(report.scene.fonts.requests.every(url => url.startsWith('file:')))
  assert.ok(report.sceneDev.fonts.faces.length > 0 && report.sceneDev.fonts.faces.every(font => font.status === 'loaded'))
  assert.deepEqual(report.sceneDev.fonts.blocked, [])
  assert.ok(report.sceneDev.fonts.requests.every(url => url.startsWith(devUrl)))
  assert.equal(report.sceneDev.remainingCanvases, 0)
  assert.equal(report.scene.remainingCanvases, 0)
  assert.match(report.scene.vegaSvg, /<svg/)
  assert.match(report.scene.vegaSvg, /a/)
  assert.equal(report.scene.vegaInteraction, true)
  assert.equal(report.scene.vegaLiteResponsive, true)
  assert.deepEqual(report.scene.resourceCalls, ['data.csv', 'red.png'])
  assert.deepEqual(report.scene.vegaImagePixel, [224, 32, 32, 255])
  assert.ok(report.scene.cancellation.ticks >= 4)
  console.log(JSON.stringify({ passed: true, results: report.results.map(({ id, svg, ...rest }) => ({ id, svgBytes: svg.length, ...rest })), bridges: report.bridges.length, cancelled: report.cancelled.error, scene: { ...report.scene, vegaSvg: report.scene.vegaSvg.length }, sceneDev: { ...report.sceneDev, vegaSvg: report.sceneDev.vegaSvg.length } }))
} finally { if (child?.exitCode === null) child.kill('SIGKILL'); await devServer?.close(); await rm(pluginModule, { force: true }); await rm(privateRoot, { recursive: true, force: true }) }
