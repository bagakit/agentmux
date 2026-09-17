import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { runProbeProcess, listProbeProcesses } from './probe-process.mjs'

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const root = path.resolve(desktop, '../..')
const fixture = path.join(desktop, 'scripts/fixtures/focus-workspace')
const require = createRequire(path.join(desktop, 'package.json'))
const { build } = await import(pathToFileURL(require.resolve('vite')).href)
const electron = require('electron')
const expectation = process.argv.includes('--baseline') ? 'baseline' : 'fixed'
const privateRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agentmux-focus-probe-'))
const inputs = [fileURLToPath(import.meta.url), ...['main.cjs', 'entry.mjs', 'index.html'].map(name => path.join(fixture, name)), ...['components/GlobalFocusSurface.tsx', 'components/FocusToolbar.tsx', 'components/FocusProjectLanes.tsx', 'components/FocusRecoveryGroup.tsx', 'components/RecentFocusTimeline.tsx', 'lib/focus-project-lanes.ts', 'lib/use-focus-hierarchy.ts', 'lib/focus-timeline-height.ts', 'store.ts', 'components/WorkspaceWorkbench.tsx', 'components/SessionPane.tsx', 'lib/focus-tab-projection.ts', 'styles/focus.css', 'styles/workbench.css'].map(file => path.join(desktop, 'src/renderer/src', file))]
const hashes = async () => Object.fromEntries(await Promise.all(inputs.map(async file => [path.relative(root, file), createHash('sha256').update(await fs.readFile(file)).digest('hex')])))
const result = { passed: false, expectation, inputs: null, phases: [], cleanup: null }
try {
  result.inputs = await hashes()
  await build({ configFile: false, root: fixture, base: './', logLevel: 'error', define: { __AGENTMUX_WEB_PREVIEW__: 'true', 'process.env.NODE_ENV': '"production"' }, build: { target: 'esnext', outDir: path.join(privateRoot, 'renderer'), emptyOutDir: true } })
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  for (const phase of expectation === 'baseline' ? ['seed'] : ['seed', 'restore']) {
    const stderr = []
    const exit = await runProbeProcess(electron, [path.join(fixture, 'main.cjs'), path.join(privateRoot, 'renderer/index.html'), privateRoot, phase, expectation], { temporaryRoot: privateRoot, cwd: root, env, timeoutMs: 20000, onLine: line => stderr.push(line.slice(0, 1000)) })
    result.phases.push({ exit, stderr })
    await fs.copyFile(path.join(privateRoot, `${phase}-focus.png`), path.join(root, '.tmp', `focus-workspace-${phase}.png`)).catch(() => {})
    const native = JSON.parse(await fs.readFile(path.join(privateRoot, `${phase}-result.json`), 'utf8'))
    result.phases.at(-1).native = native
    assert.equal(exit.timedOut, false)
    assert.equal(exit.exitCode, 0, native.failure?.message)
    assert.equal(native.passed, true)
  }
  if (expectation !== 'baseline') assert.notEqual(result.phases[0].native.pid, result.phases[1].native.pid)
  assert.deepEqual(await hashes(), result.inputs)
  result.passed = true
} catch (error) { result.failure = { name: error.name, message: error.message, stack: error.stack } }
finally {
  result.cleanup = { remaining: await listProbeProcesses(-1, privateRoot), rootRemoved: false }
  if (result.cleanup.remaining.length === 0) { await fs.rm(privateRoot, { recursive: true, force: true }); result.cleanup.rootRemoved = true }
  await fs.writeFile(path.join(root, '.tmp', `focus-workspace-${expectation}.json`), JSON.stringify(result, null, 2))
}
assert.equal(result.cleanup.remaining.length, 0)
assert.equal(result.cleanup.rootRemoved, true)
assert.equal(result.passed, true, result.failure?.message)
console.log(JSON.stringify({ passed: true, expectation, phases: result.phases.map(phase => ({ pid: phase.native.pid, geometry: phase.native.geometry, scroll: phase.native.scroll })), cleanup: result.cleanup }))
