import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { runProbeProcess, listProbeProcesses } from './probe-process.mjs'

const testCase = process.argv[process.argv.indexOf('--case') + 1]
assert.ok(['clear-focus', 'copy-intro'].includes(testCase), 'Use --case clear-focus|copy-intro')
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const desktop = path.join(root, 'apps/desktop')
const fixture = path.join(desktop, 'scripts/fixtures/settings-search-refinement')
const require = createRequire(path.join(desktop, 'package.json'))
const { build, loadConfigFromFile } = await import(pathToFileURL(require.resolve('vite')).href)
const { config } = await loadConfigFromFile({ command: 'build', mode: 'production' }, path.join(fixture, 'vitest.config.mts'), root)
const privateRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agentmux-settings-search-'))
const evidence = path.join(root, '.tmp/settings-search-craft', `${testCase}-${Date.now()}`)
await fs.mkdir(evidence, { recursive: true })
const hash = content => createHash('sha256').update(content).digest('hex')
const source = path.join(desktop, 'src/renderer/src/components', testCase === 'clear-focus' ? 'SettingsPanel.tsx' : 'settings/CopyPathsSettingsPane.tsx')
const original = await fs.readFile(source, 'utf8')
const anchor = testCase === 'clear-focus' ? '    searchInput.current?.focus()' : '<div className="settings-pane-stack">'
assert.equal(original.split(anchor).length, 2, 'Mutation must bind exactly one actual owning source block')
const mutated = testCase === 'clear-focus' ? original.replace(anchor, '') : original.replace(anchor, `${anchor}\n      <p className="settings-lead">Choose how paths look when you share them.</p>`)
const inputs = new Map(await Promise.all([
  fileURLToPath(import.meta.url), path.join(fixture, 'main.cjs'), path.join(fixture, 'index.html'), path.join(fixture, 'vitest.config.mts'),
  path.join(desktop, 'scripts/probe-process.mjs'), path.join(desktop, 'src/renderer/src/App.tsx')
].map(async file => [file, hash(await fs.readFile(file))])))
const runs = []
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
try {
  for (const mode of ['control', 'mutant', 'restored']) {
    const directory = path.join(evidence, mode); await fs.mkdir(directory)
    let mutationCount = 0
    await build({ configFile: false, root: fixture, base: './', logLevel: 'error', resolve: config.resolve, define: { ...config.define, 'process.env.NODE_ENV': '"production"' },
      plugins: [{ name: 'bound-owning-settings-proof', enforce: 'pre', async transform(code, id) {
        const file = id.split('?')[0]
        if (file.startsWith(root + '/') && !file.includes('/node_modules/')) {
          const digest = hash(await fs.readFile(file)); if (inputs.has(file)) assert.equal(digest, inputs.get(file), `Proof source changed: ${file}`); else inputs.set(file, digest)
        }
        if (file === source) { assert.equal(code, original); mutationCount++; return mode === 'mutant' ? mutated : code }
      } }], build: { target: 'esnext', outDir: path.join(privateRoot, mode), emptyOutDir: true } })
    assert.equal(mutationCount, 1)
    const processReceipt = await runProbeProcess(require('electron'), [path.join(fixture, 'main.cjs'), path.join(privateRoot, mode, 'index.html'), path.join(privateRoot, mode), directory, testCase], { temporaryRoot: privateRoot, cwd: root, env, timeoutMs: 45000 })
    const render = JSON.parse(await fs.readFile(path.join(directory, 'render.json'), 'utf8'))
    assert.equal(processReceipt.timedOut, false)
    if (mode === 'mutant') {
      assert.equal(processReceipt.exitCode, 1); assert.equal(render.passed, false); assert.equal(render.failure.name, 'AssertionError')
      assert.ok(render.failure.message.includes(testCase === 'clear-focus' ? 'Clear returns focus' : 'Copy Paths has one introduction'))
    } else { assert.equal(processReceipt.exitCode, 0, render.failure?.message); assert.equal(render.passed, true); assert.equal(render.frames.length, 3) }
    runs.push({ mode, process: processReceipt, owningSourceSha256: hash(mode === 'mutant' ? mutated : original), passed: render.passed, assertion: render.failure?.message, frames: render.frames.length })
  }
  // Product callers are actual JSX uses, separate from definitions, imports and this fixture.
  const ts = require('typescript')
  const callers = []
  for (const [relative, symbol] of [['apps/desktop/src/renderer/src/App.tsx', 'SettingsPanel'], ['apps/desktop/src/renderer/src/components/SettingsPanel.tsx', 'CopyPathsSettingsPane']]) {
    const text = await fs.readFile(path.join(root, relative), 'utf8')
    const tree = ts.createSourceFile(relative, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
    const uses = []
    const visit = node => {
      if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && node.tagName.getText(tree) === symbol)
        uses.push({ file: relative, symbol, line: tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1 })
      ts.forEachChild(node, visit)
    }
    visit(tree); assert.ok(uses.length > 0, `No actual product JSX consumer: ${symbol}`); callers.push(...uses)
  }
  assert.ok(inputs.size > 0 && inputs.has(source))
  for (const [file, digest] of inputs) assert.equal(hash(await fs.readFile(file)), digest, `Proof inputs changed: ${file}`)
  assert.equal(await fs.readFile(source, 'utf8'), original)
  const receipt = { passed: true, testCase, boundary: 'Actual renderer/source proof; no compiled Core, Native, Runtime, restart or installation claim.', runs, actualProductCallers: callers, inputs: Object.fromEntries([...inputs].map(([file, digest]) => [path.relative(root, file), digest])), sourceUnchanged: true }
  await fs.writeFile(path.join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2))
  console.log(JSON.stringify({ passed: true, testCase, evidence, inputs: inputs.size, controlFrames: 3, restoredFrames: 3, owningMutantAssertion: runs[1].assertion }))
} finally {
  const remaining = await listProbeProcesses(-1, privateRoot)
  assert.deepEqual(remaining, [], 'Owned renderer proof processes remain')
  await fs.rm(privateRoot, { recursive: true, force: true })
  await assert.rejects(fs.stat(privateRoot), { code: 'ENOENT' })
  await fs.writeFile(path.join(evidence, 'cleanup.json'), JSON.stringify({ privateRoot, privateProcessesReaped: true, temporaryRootRemoved: true }))
}
