import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { runProbeProcess, listProbeProcesses } from './probe-process.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const desktop = path.join(root, 'apps/desktop'), fixture = path.join(desktop, 'scripts/fixtures/settings-general-search')
const require = createRequire(path.join(desktop, 'package.json'))
const { build, loadConfigFromFile } = await import(pathToFileURL(require.resolve('vite')).href)
const configFile = path.join(fixture, 'vitest.config.mts')
const { config } = await loadConfigFromFile({ command: 'build', mode: 'production' }, configFile, root)
const privateRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agentmux-settings-general-search-'))
const evidence = path.join(root, '.tmp/settings-general-search', `run-${Date.now()}`)
await fs.mkdir(evidence, { recursive: true })
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const sourceFile = path.join(desktop, 'src/renderer/src/components/SettingsPanel.tsx')
const original = await fs.readFile(sourceFile, 'utf8')
const ts = require('typescript'), callers = [], entries = []
const panel = ts.createSourceFile(sourceFile, original, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
let sections, generalKeywords
const find = node => { if (ts.isVariableDeclaration(node) && node.name.getText(panel) === 'SECTIONS') sections = node.initializer; ts.forEachChild(node, find) }; find(panel)
assert.ok(sections && ts.isArrayLiteralExpression(sections))
for (const entry of sections.elements) {
  assert.ok(ts.isObjectLiteralExpression(entry))
  const fields = new Map(entry.properties.filter(ts.isPropertyAssignment).map(property => [property.name.getText(panel), property]))
  const string = node => { assert.ok(node); while (ts.isAsExpression(node)) node = node.expression; assert.ok(ts.isStringLiteral(node)); return node.text }
  const id = string(fields.get('id')?.initializer), keyword = fields.get('keywords'); assert.ok(keyword)
  entries.push({ id, keywords: ts.isStringLiteral(keyword.initializer) ? keyword.initializer.text : keyword.initializer.getText(panel) })
  if (id === 'general') { assert.equal(generalKeywords, undefined); generalKeywords = keyword }
}
assert.deepEqual(entries.map(entry => entry.id), ['appearance', 'notifications', 'browser', 'general', 'agents', 'prompts', 'workspaces', 'hosts'])
assert.ok(generalKeywords && ts.isStringLiteral(generalKeywords.initializer))
const diagnosticKeywords = 'show crash log session recovery'
const keywords = generalKeywords.getText(panel), keywordValue = generalKeywords.initializer.text
assert.equal(keywordValue.split(diagnosticKeywords).length, 2, 'The actual General registration contains the diagnostic keywords once')
assert.equal(original.split(keywords).length, 2, 'One actual owning General keyword block')
const mutated = original.replace(keywords, `keywords: ${JSON.stringify(keywordValue.replace(diagnosticKeywords, '').trim())}`)
const inputs = new Map(), runs = []
async function bind(file) {
  const bytes = await fs.readFile(file), digest = hash(bytes)
  if (inputs.has(file)) assert.equal(digest, inputs.get(file), `Proof source changed: ${file}`)
  else {
    inputs.set(file, digest)
    const target = path.join(evidence, 'source', path.relative(root, file))
    await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, bytes)
  }
}
async function compiledFiles(directory, prefix = '') {
  const entries = []
  for (const entry of await fs.readdir(path.join(directory, prefix), { withFileTypes: true })) {
    const file = path.join(prefix, entry.name)
    if (entry.isDirectory()) entries.push(...await compiledFiles(directory, file))
    else { const bytes = await fs.readFile(path.join(directory, file)); entries.push({ file, bytes: bytes.length, sha256: hash(bytes) }) }
  }
  return entries
}
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
try {
  for (const file of [fileURLToPath(import.meta.url), path.join(fixture, 'main.cjs'), path.join(fixture, 'index.html'), configFile,
    path.join(desktop, 'scripts/fixtures/settings-search-refinement/vitest.config.mts'), path.join(desktop, 'scripts/probe-process.mjs'),
    path.join(root, 'pnpm-lock.yaml'), path.join(root, 'package.json'), path.join(root, 'packages/core/package.json'), path.join(desktop, 'package.json'),
    path.join(desktop, 'src/renderer/src/App.tsx')]) await bind(file)
  for (const mode of ['control', 'mutant', 'restored']) {
    const directory = path.join(evidence, mode); await fs.mkdir(directory)
    let consumed = 0
    const output = path.join(privateRoot, mode)
    await build({ configFile: false, root: fixture, base: './', logLevel: 'error', resolve: config.resolve,
      define: { ...config.define, 'process.env.NODE_ENV': '"production"' },
      plugins: [{ name: 'bound-owning-general-search-proof', enforce: 'pre', async transform(code, id) {
        const file = id.split('?')[0]
        if (file.startsWith(root + '/') && !file.includes('/node_modules/')) await bind(file)
        if (file === sourceFile) { assert.equal(code, original); consumed++; return mode === 'mutant' ? mutated : code }
      } }], build: { target: 'esnext', outDir: output, emptyOutDir: true } })
    assert.equal(consumed, 1, 'The actual owning SettingsPanel source is consumed exactly once')
    const compiled = await compiledFiles(output)
    assert.ok(compiled.length > 0)
    await fs.cp(output, path.join(directory, 'compiled'), { recursive: true })
    assert.deepEqual(await compiledFiles(path.join(directory, 'compiled')), compiled)
    await fs.writeFile(path.join(directory, 'compiled-manifest.json'), JSON.stringify(compiled, null, 2))
    const stderr = []
    const execution = await runProbeProcess(require('electron'), [path.join(fixture, 'main.cjs'), path.join(output, 'index.html'), privateRoot, directory],
      { temporaryRoot: privateRoot, cwd: root, env, timeoutMs: 30000, onLine: line => stderr.push(line) })
    await fs.writeFile(path.join(directory, 'execution.json'), JSON.stringify(execution, null, 2))
    await fs.writeFile(path.join(directory, 'stderr.log'), stderr.join('\n'))
    const render = JSON.parse(await fs.readFile(path.join(directory, 'render.json'), 'utf8'))
    assert.equal(execution.timedOut, false)
    if (mode === 'mutant') {
      assert.equal(execution.exitCode, 1); assert.equal(render.passed, false); assert.equal(render.failure.name, 'AssertionError')
      assert.ok(render.failure.message.includes('General search reaches the original controls'))
    } else { assert.equal(execution.exitCode, 0, render.failure?.message); assert.equal(render.passed, true); assert.equal(render.frames.length, 8) }
    runs.push({ mode, execution, assertion: render.failure?.message, frames: render.frames.length, compiled,
      owningSourceSha256: hash(mode === 'mutant' ? mutated : original) })
  }
  for (const [symbol, file] of [['SettingsPanel', path.join(desktop, 'src/renderer/src/App.tsx')], ['GeneralSettingsPane', sourceFile]]) {
    const source = await fs.readFile(file, 'utf8'), tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX), uses = []
    const visit = node => {
      if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && node.tagName.getText(tree) === symbol)
        uses.push({ file: path.relative(root, file), symbol, line: tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1 })
      ts.forEachChild(node, visit)
    }
    visit(tree); assert.ok(uses.length > 0, `No actual external product JSX caller: ${symbol}`); callers.push(...uses)
  }
  assert.ok(inputs.size > 0)
  for (const file of [sourceFile, path.join(desktop, 'src/renderer/src/components/settings/GeneralSettingsPane.tsx'), path.join(desktop, 'src/renderer/src/styles/index.css')]) assert.ok(inputs.has(file))
  for (const [file, digest] of inputs) assert.equal(hash(await fs.readFile(file)), digest, `Proof inputs changed: ${file}`)
  await fs.writeFile(path.join(evidence, 'receipt.json'), JSON.stringify({ passed: true, captureOnly: true, aestheticReview: 'not-performed',
    boundary: 'Finite actual renderer/CSS/Preview; no compiled Core, Runtime, file manager, restart or installation claim.', runs,
    sourceSections: entries, actualExternalProductJSXCallers: callers, inputs: Object.fromEntries([...inputs].map(([file, digest]) => [path.relative(root, file), digest])),
    sourceUnchanged: true, privateCompiledBytesArchived: true }, null, 2))
  console.log(JSON.stringify({ passed: true, evidence, inputs: inputs.size, runs: runs.map(run => ({ mode: run.mode, frames: run.frames, assertion: run.assertion })) }))
} catch (error) {
  await fs.writeFile(path.join(evidence, 'failure.json'), JSON.stringify({ name: error.name, message: error.message, stack: error.stack, runs }, null, 2)); throw error
} finally {
  assert.deepEqual(await listProbeProcesses(-1, privateRoot), [], 'Owned renderer proof processes remain')
  await fs.rm(privateRoot, { recursive: true, force: true }); await assert.rejects(fs.stat(privateRoot), { code: 'ENOENT' })
  await fs.writeFile(path.join(evidence, 'cleanup.json'), JSON.stringify({ privateRoot, privateProcessesReaped: true, temporaryRootRemoved: true }))
}
