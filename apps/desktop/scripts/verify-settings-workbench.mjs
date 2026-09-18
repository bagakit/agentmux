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
const fixture = path.join(desktop, 'scripts/fixtures/settings-workbench')
const evidence = path.join(root, '.tmp/settings-workbench')
const require = createRequire(path.join(desktop, 'package.json'))
const { build } = await import(pathToFileURL(require.resolve('vite')).href)
const privateRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agentmux-settings-proof-'))
await fs.mkdir(evidence, { recursive: true })
const renderer = path.join(desktop, 'src/renderer/src')
const filesIn = async directory => (await Promise.all((await fs.readdir(directory, { withFileTypes: true })).map(entry => entry.isDirectory() ? filesIn(path.join(directory, entry.name)) : [path.join(directory, entry.name)]))).flat()
const inputs = [fileURLToPath(import.meta.url), ...await filesIn(fixture), path.join(renderer,'App.tsx'), path.join(renderer,'components/SettingsPanel.tsx'), ...await filesIn(path.join(renderer,'components/settings')), ...await filesIn(path.join(renderer,'styles'))]
const hashes = async () => Object.fromEntries(await Promise.all(inputs.map(async file => [path.relative(root,file),createHash('sha256').update(await fs.readFile(file)).digest('hex')])))
const sourceHashes = await hashes()
await fs.writeFile(path.join(evidence,'source-hashes.json'), JSON.stringify(sourceHashes,null,2))
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
try {
  await build({ configFile: false, root: fixture, base: './', logLevel: 'error', define: { __AGENTMUX_WEB_PREVIEW__: 'true', 'process.env.NODE_ENV': '"production"' }, build: { target: 'esnext', outDir: path.join(privateRoot, 'renderer'), emptyOutDir: true } })
  const render = await runProbeProcess(require('electron'), [path.join(fixture, 'main.cjs'), path.join(privateRoot, 'renderer/index.html'), privateRoot, evidence], { temporaryRoot: privateRoot, cwd: root, env, timeoutMs: 45000 })
  assert.equal(render.timedOut, false)
  assert.equal(render.exitCode, 0)
  const receipt = JSON.parse(await fs.readFile(path.join(evidence, 'render.json'), 'utf8'))
  assert.equal(receipt.passed, true, receipt.failure?.message)
  assert.equal(receipt.frames.length, 72)
  // The renderer fixture does not claim Runtime facts. This separate private desktop proof uses
  // actual Core and a healthy cat Run, kills the process and verifies durable split/focus restoration.
  if (!process.argv.includes('--render-only')) {
    const restart = await runProbeProcess(process.execPath, [path.join(desktop, 'scripts/verify-workbench-persistence-restart.mjs')], { temporaryRoot: privateRoot, cwd: root, env, timeoutMs: 125000 })
    assert.equal(restart.timedOut, false)
    assert.equal(restart.exitCode, 0)
    await fs.copyFile(path.join(root, '.tmp/workbench-persistence-last-crash.json'), path.join(evidence, 'restart.json'))
  }
  assert.deepEqual(await hashes(), sourceHashes, 'Proof inputs changed during verification')
  console.log(JSON.stringify({ passed: true, frames: receipt.frames.length, evidence, restart: !process.argv.includes('--render-only') }))
} finally {
  assert.deepEqual(await listProbeProcesses(-1, privateRoot), [])
  await fs.rm(privateRoot, { recursive: true, force: true })
}
