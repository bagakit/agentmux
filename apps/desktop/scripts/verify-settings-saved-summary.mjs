import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { runProbeProcess, listProbeProcesses } from './probe-process.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const desktop = path.join(root, 'apps/desktop')
const fixture = path.join(desktop, 'scripts/fixtures/settings-saved-summary')
const require = createRequire(path.join(desktop, 'package.json'))
const { build, loadConfigFromFile } = await import(pathToFileURL(require.resolve('vite')).href)
const configFile = path.join(desktop, 'scripts/fixtures/settings-search-refinement/vitest.config.mts')
const { config } = await loadConfigFromFile({ command: 'build', mode: 'production' }, configFile, root)
const privateRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agentmux-settings-saved-summary-'))
const evidence = path.join(root, '.tmp/settings-saved-summary', `run-${Date.now()}`)
await fs.mkdir(evidence, { recursive: true })
const hash = content => createHash('sha256').update(content).digest('hex')
const sources = new Map(await Promise.all(['copy', 'browser'].map(async kind => {
  const file = path.join(desktop, 'src/renderer/src/components/settings', kind === 'copy' ? 'CopyPathsSettingsPane.tsx' : 'BrowserSettingsPane.tsx')
  const original = await fs.readFile(file, 'utf8')
  assert.equal(original.split('Saved: ').length, 2, 'Mutation binds exactly one owning summary')
  return [kind, { file, original, mutated: original.replace('Saved: ', '') }]
})))
const inputs = new Map(await Promise.all([
  fileURLToPath(import.meta.url), path.join(fixture, 'main.cjs'), path.join(fixture, 'index.html'), path.join(fixture, 'entry.ts'), configFile,
  path.join(desktop, 'scripts/probe-process.mjs'), path.join(desktop, 'src/renderer/src/components/SettingsPanel.tsx')
].map(async file => [file, hash(await fs.readFile(file))])))
const runs = []
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
try {
  for (const mode of ['control', 'copy-mutant', 'copy-restored', 'browser-mutant', 'browser-restored']) {
    const directory = path.join(evidence, mode); await fs.mkdir(directory)
    const consumed = new Map([...sources.keys()].map(kind => [kind, 0]))
    await build({ configFile: false, root: fixture, base: './', logLevel: 'error', resolve: config.resolve, define: { ...config.define, 'process.env.NODE_ENV': '"production"' },
      plugins: [{ name: 'bound-owning-saved-summary-proof', enforce: 'pre', async transform(code, id) {
        const file = id.split('?')[0]
        if (file.startsWith(root + '/') && !file.includes('/node_modules/')) {
          const digest = hash(await fs.readFile(file)); if (inputs.has(file)) assert.equal(digest, inputs.get(file), `Proof source changed: ${file}`); else inputs.set(file, digest)
        }
        for (const [kind, source] of sources) if (file === source.file) {
          assert.equal(code, source.original); consumed.set(kind, consumed.get(kind) + 1)
          return mode === `${kind}-mutant` ? source.mutated : code
        }
      } }], build: { target: 'esnext', outDir: path.join(privateRoot, mode), emptyOutDir: true } })
    assert.deepEqual([...consumed.values()], [1, 1], 'Both actual owning Pane sources were consumed')
    const processReceipt = await runProbeProcess(require('electron'), [path.join(fixture, 'main.cjs'), path.join(privateRoot, mode, 'index.html'), path.join(privateRoot, mode), directory], { temporaryRoot: privateRoot, cwd: root, env, timeoutMs: 45000 })
    const render = JSON.parse(await fs.readFile(path.join(directory, 'render.json'), 'utf8'))
    assert.equal(processReceipt.timedOut, false)
    if (mode.endsWith('-mutant')) {
      const kind = mode.split('-')[0]
      assert.equal(processReceipt.exitCode, 1); assert.equal(render.passed, false); assert.equal(render.failure.name, 'AssertionError')
      assert.ok(render.failure.message.includes(`${kind} summary identifies the saved fact`))
    } else { assert.equal(processReceipt.exitCode, 0, render.failure?.message); assert.equal(render.passed, true); assert.equal(render.frames.length, 6) }
    runs.push({ mode, process: processReceipt, passed: render.passed, assertion: render.failure?.message, frames: render.frames.length,
      owningSourceSha256: Object.fromEntries([...sources].map(([kind, source]) => [kind, hash(mode === `${kind}-mutant` ? source.mutated : source.original)])) })
  }
  const ts = require('typescript')
  const callerFile = 'apps/desktop/src/renderer/src/components/SettingsPanel.tsx'
  const text = await fs.readFile(path.join(root, callerFile), 'utf8')
  const tree = ts.createSourceFile(callerFile, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const callers = []
  for (const symbol of ['CopyPathsSettingsPane', 'BrowserSettingsPane']) {
    const uses = []
    const visit = node => {
      if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && node.tagName.getText(tree) === symbol)
        uses.push({ file: callerFile, symbol, line: tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1 })
      ts.forEachChild(node, visit)
    }
    visit(tree); assert.ok(uses.length > 0, `No actual external product JSX caller: ${symbol}`); callers.push(...uses)
  }
  assert.ok(inputs.size > 0)
  for (const source of sources.values()) { assert.ok(inputs.has(source.file)); assert.equal(await fs.readFile(source.file, 'utf8'), source.original) }
  for (const [file, digest] of inputs) assert.equal(hash(await fs.readFile(file)), digest, `Proof inputs changed: ${file}`)
  const receipt = { passed: true, boundary: 'Actual renderer/CSS with preview configuration publication; no Runtime, Native capability, restart or installation claim.', runs,
    actualProductCallers: callers, inputs: Object.fromEntries([...inputs].map(([file, digest]) => [path.relative(root, file), digest])), sourceUnchanged: true }
  await fs.writeFile(path.join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2))
  console.log(JSON.stringify({ passed: true, evidence, inputs: inputs.size, runs: runs.map(run => ({ mode: run.mode, frames: run.frames, assertion: run.assertion })) }))
} finally {
  const remaining = await listProbeProcesses(-1, privateRoot)
  assert.deepEqual(remaining, [], 'Owned renderer proof processes remain')
  await fs.rm(privateRoot, { recursive: true, force: true })
  await assert.rejects(fs.stat(privateRoot), { code: 'ENOENT' })
  await fs.writeFile(path.join(evidence, 'cleanup.json'), JSON.stringify({ privateRoot, privateProcessesReaped: true, temporaryRootRemoved: true }))
}
