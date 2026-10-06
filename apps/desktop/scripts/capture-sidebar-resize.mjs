import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, relative, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { runProbeProcess, listProbeProcesses } from './probe-process.mjs'
const root = resolve(import.meta.dirname, '../../..'), require = createRequire(resolve(root, 'apps/desktop/package.json'))
const { build } = await import(pathToFileURL(require.resolve('vite')).href)
const evidence = resolve(root, '.tmp/reference-surfaces/sidebar-resize-cancel')
const privateRoot = await mkdtemp(resolve(tmpdir(), 'agentmux-sidebar-resize-')), compiled = resolve(privateRoot, 'renderer')
const hash = bytes => createHash('sha256').update(bytes).digest('hex'), source = {}
const receipt = { passed: false, captureOnly: true, aestheticReview: 'not-performed', source, frames: [], phases: [],
  scope: 'Complete original App, five resize consumers, original client width persistence and public Core durable spatial store. Two private Electron processes; controlled read-only file Regions and empty Runtime, no Provider, remote Host or user application.' }
await mkdir(evidence, { recursive: true })
try {
  await build({ configFile: false, base: './', logLevel: 'error', worker: { format: 'es' }, root: resolve(root, 'apps/desktop/scripts/fixtures/sidebar-resize-cancel'),
    define: { __AGENTMUX_WEB_PREVIEW__: 'true' }, esbuild: { jsx: 'automatic' }, build: { outDir: compiled, emptyOutDir: true, target: 'esnext' },
    plugins: [{ name: 'sidebar-resize-input-identity', enforce: 'pre', transform(code, id) {
      if (id.startsWith(root + sep) && !id.includes('/node_modules/') && !id.includes('?') && /\.(tsx?|css)$/.test(id)) source[relative(root, id)] = hash(code)
    }, async generateBundle() {
      for (const path of this.getWatchFiles()) if (path.startsWith(root + sep) && !path.includes('/node_modules/') && path.endsWith('.css')) source[relative(root, path)] = hash(await readFile(path))
    } }] })
  assert.ok(source['apps/desktop/src/renderer/src/hooks/useSidebarResize.ts'])
  for (const path of ['apps/desktop/scripts/capture-sidebar-resize.mjs', 'apps/desktop/scripts/fixtures/cross-device-project-groups/main.cjs',
    'apps/desktop/scripts/fixtures/cross-device-project-groups/preload.cjs', 'apps/desktop/scripts/fixtures/sidebar-resize-cancel/scenario.cjs',
    'packages/core/src/spatial-state.ts', 'packages/core/dist/spatial-state.js']) source[path] = hash(await readFile(resolve(root, path)))
  const config = { version: 9, hosts: [{ id: 'local', kind: 'local', label: 'Private spatial proof' }], executors: {},
    workspaces: ['groups-local', 'groups-remote', 'groups-archive'].map((id, index) => ({ id, hostId: 'local', name: ['Original work', 'Reference work', 'Retained work'][index], path: resolve(privateRoot, id), kind: 'folder' })),
    appearance: { terminalTheme: 'graphite' }, browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } } }
  for (const workspace of config.workspaces) await mkdir(workspace.path)
  const input = resolve(privateRoot, 'input.json')
  await writeFile(input, JSON.stringify({ config, retainedGroupId: 'original-project-group', unknownProjectId: 'retained-unregistered-project' }))
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  for (const phase of ['seed', 'restore']) {
    const logs = []
    const process = await runProbeProcess(require('electron'), [resolve(root, 'apps/desktop/scripts/fixtures/cross-device-project-groups/main.cjs'),
      resolve(compiled, 'index.html'), privateRoot, phase, resolve(root, 'apps/desktop/scripts/fixtures/cross-device-project-groups/preload.cjs'), evidence, input,
      resolve(root, 'packages/core/dist/spatial-state.js'), resolve(root, 'apps/desktop/scripts/fixtures/sidebar-resize-cancel/scenario.cjs')],
    { temporaryRoot: privateRoot, cwd: root, env, timeoutMs: 120_000, onLine: line => logs.push(line) })
    const processReceipt = { phase, process, logs }
    receipt.phases.push(processReceipt)
    assert.equal(process.exitCode, 0, `Original sidebar ${phase} failed`)
    const actual = JSON.parse(await readFile(resolve(evidence, phase + '.json'), 'utf8'))
    assert.equal(actual.passed, true, JSON.stringify(actual.failure)); assert.deepEqual(actual.runtimeCalls, [])
    Object.assign(processReceipt, { electronPid: actual.electronPid, operations: actual.operations })
    receipt.frames.push(...actual.images.map(frame => ({ file: frame.file, sha256: frame.sha256 })))
  }
  assert.notEqual(receipt.phases[0].electronPid, receipt.phases[1].electronPid)
  for (const [path, digest] of Object.entries(source)) assert.equal(hash(await readFile(resolve(root, path))), digest, 'Captured source changed: ' + path)
  for (const frame of receipt.frames) assert.equal(hash(await readFile(resolve(evidence, frame.file))), frame.sha256)
  receipt.passed = true
} catch (error) { receipt.failure = { name: error.name, message: error.message }; process.exitCode = 1 }
finally {
  const remaining = await listProbeProcesses(-1, privateRoot)
  receipt.cleanup = { remaining, removed: remaining.length === 0 }
  if (!remaining.length) await rm(privateRoot, { recursive: true, force: true })
  await writeFile(resolve(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
  console.log(JSON.stringify({ captured: receipt.passed, evidence: relative(root, evidence), failure: receipt.failure, pendingIndependentVisualReview: true }))
}
