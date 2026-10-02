import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'

const repository = resolve(import.meta.dirname, '../../..')
const codeOnly = process.argv.slice(2).join(' ') === '--code-only'
assert.ok(process.argv.length === 2 || codeOnly, 'Use [--code-only]; the full gate also consumes independent visual evidence')
const evidence = join(repository, '.tmp/file-save-recovery', 'attempt-' + globalThis.crypto.randomUUID())
await mkdir(evidence, { recursive: true })
const clone = await mkdtemp(join(repository, '.tmp/file-save-recovery-source-'))
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const base = 'apps/desktop/src/renderer/src/'
const owned = ['components/EditorPane.tsx', 'lib/file-workbench-state.ts', 'lib/editor-save-shortcut.ts', 'store.ts'].map(path => base + path)
const tests = ['file-save-store.test.ts', 'file-preview-pane.test.tsx', 'file-save-recovery-filesystem.test.ts']
const result = { schema: 'agentmux.file-save-recovery-verification.v1', passed: false, codeVerified: false, mode: codeOnly ? 'code-only' : 'full',
  userFilesOrRunTouched: false, callers: {}, mutations: [], limitations: [
    'The filesystem tests use private directories and the actual ordinary WorkspaceFiles owner, including a truly published write with a lost receipt.',
    'App/Editor consumers use controlled desktop transport, Monaco/native terminal boundaries. They do not certify a user Run, native Run state.',
    'Code-only success does not approve visual delivery. The full gate requires independently approved, candidate-bound actual Renderer capture.'
  ] }
async function run(name, selected = tests, pattern) {
  const args = ['node_modules/vitest/vitest.mjs', 'run', '--config', 'apps/desktop/scripts/fixtures/file-save-recovery/vitest.config.mts',
    ...selected.map(path => 'test/' + path), '--maxWorkers=1', '--reporter=verbose', ...(pattern ? ['-t', pattern] : [])]
  const child = spawn(process.execPath, args, { cwd: clone, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''; child.stdout.on('data', bytes => { output += bytes }); child.stderr.on('data', bytes => { output += bytes })
  const timeout = setTimeout(() => child.kill('SIGTERM'), 90000)
  const exit = await new Promise((accept, reject) => { child.once('error', reject); child.once('close', accept) }); clearTimeout(timeout)
  const log = name + '.log'; await writeFile(join(evidence, log), output)
  return { exit, output, log, sha256: hash(output) }
}
async function sources(directory) {
  const found = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) found.push(...await sources(path))
    else if (/\.[jt]sx?$/.test(entry.name)) found.push(path)
  }
  return found
}
const mutations = [
  ['unknown-save-barrier', 'store.ts', "    if (issue?.kind === 'write-unknown') return", '', 'file-save-store.test.ts', 'checks same disk contents'],
  ['unknown-is-not-write-error', 'store.ts', "kind: 'write-unknown', code: result.code", "kind: 'write-error', code: result.code", 'file-save-store.test.ts', 'checks same disk contents'],
  ['later-draft-stays-dirty', 'lib/file-workbench-state.ts', 'unknown.attempted.generation, result.document.revision', '(state.documentGenerations[key] ?? 0), result.document.revision', 'file-save-store.test.ts', 'confirms the attempted bytes while retaining input'],
  ['old-read-cannot-settle', 'lib/file-workbench-state.ts', 'if (unknown !== checkedWrite) return state', '', 'file-save-store.test.ts', 'does not use a read started before'],
  ['resource-aba-cannot-settle', 'store.ts', 'resourceChanged || resource?.hostId', 'resource?.hostId', 'file-save-store.test.ts', 'rejects a check across resource A'],
  ['editor-check-is-callable', 'components/EditorPane.tsx', 'aria-label="Check saved file" onClick={() => void reload(tabId, surface.regionId)}', 'aria-label="Check saved file" onClick={() => {}}', 'file-preview-pane.test.tsx', 'the original Editor checks an unconfirmed save']
]

async function visualEvidence() {
  const path = join(repository, "docs/reviews/evidence/file-save-receipt-recovery/visual.json")
  const input = JSON.parse(await readFile(path, 'utf8'))
  assert.equal(input.schema, 'agentmux.file-save-recovery-visual.v1')
  assert.ok(Array.isArray(input.source) && input.source.length > 0)
  const source = [...input.source].sort((a, b) => a.path.localeCompare(b.path))
  assert.equal(new Set(source.map(item => item.path)).size, source.length)
  for (const item of source) {
    assert.ok(typeof item.path === 'string' && !item.path.startsWith('/') && !item.path.split('/').includes('..'))
    assert.equal(hash(await readFile(join(repository, item.path))), item.sha256, 'Visual Source is current: ' + item.path)
  }
  for (const path of owned) assert.ok(source.some(item => item.path === path), 'Visual evidence covers the actual owner: ' + path)
  const sourceSha256 = hash(JSON.stringify(source))
  assert.ok(Array.isArray(input.screenshots) && input.screenshots.length > 0)
  for (const scenario of ['normal', 'narrow', 'reduced', 'unknown-check', 'failed-check', 'conflict']) {
    assert.ok(input.screenshots.some(item => item.scenario === scenario), 'Required actual file visual scenario: ' + scenario)
  }
  for (const item of input.screenshots) assert.equal(hash(await readFile(join(repository, item.path))), item.sha256, 'Actual PNG hash: ' + item.path)
  const review = await readFile(join(repository, input.review_ref))
  assert.equal(hash(review), input.review_sha256)
  assert.match(review.toString('utf8'), /^Decision:\s*approved\s*$/im)
  assert.match(review.toString('utf8'), new RegExp('^Candidate source SHA256:\\s*' + sourceSha256 + '\\s*$', 'im'))
  const reviewer = review.toString('utf8').match(/^Reviewer:\s*(\S+)\s*$/im)?.[1]
  assert.ok(reviewer && !['/root'].includes(reviewer), 'Independent reviewer did not implement this UI')
  const captureBytes = await readFile(join(repository, input.capture_receipt.path))
  assert.equal(hash(captureBytes), input.capture_receipt.sha256)
  const capture = JSON.parse(captureBytes)
  assert.equal(capture.passed, true); assert.equal(capture.sourceSha256, sourceSha256)
  assert.ok((capture.compiledImports?.length ?? capture.bundles?.length ?? 0) > 0, 'Actual compiled Renderer evidence is nonempty')
  for (const path of owned) assert.ok(capture.compiledImports.some(item => item.path === path && item.sourceSha256 === source.find(entry => entry.path === path)?.sha256), 'Compiled original file owner: ' + path)
  result.visual = { path: relative(repository, path), sha256: hash(await readFile(path)), sourceSha256, review_ref: input.review_ref, screenshotCount: input.screenshots.length }
}
try {
  for (const path of ['apps/desktop/src', 'apps/desktop/resources', 'apps/desktop/test', 'apps/desktop/scripts/fixtures/file-save-recovery']) await cp(join(repository, path), join(clone, path), { recursive: true })
  for (const name of ['core', 'demand', 'layout', 'client-ui']) await cp(join(repository, 'packages', name), join(clone, 'packages', name), { recursive: true,
    filter: path => !path.split('/').some(part => part === 'node_modules' || part === 'dist') })
  for (const path of ['package.json', 'tsconfig.base.json', 'vitest.setup.ts', 'apps/desktop/package.json', 'apps/desktop/tsconfig.json', 'apps/desktop/tsconfig.test.json']) {
    await mkdir(resolve(clone, path, '..'), { recursive: true }); await cp(join(repository, path), join(clone, path))
  }
  for (const path of ['node_modules', 'apps/desktop/node_modules', 'packages/core/node_modules', 'packages/layout/node_modules', 'packages/client-ui/node_modules']) {
    await mkdir(resolve(clone, path, '..'), { recursive: true }); await symlink(join(repository, path), join(clone, path), 'dir')
  }
  result.source = await Promise.all(owned.map(async path => ({ path, sha256: hash(await readFile(join(clone, path))) })))
  const product = await sources(join(repository, 'apps/desktop/src'))
  assert.ok(product.length > 0)
  for (const [symbol, definition] of [['FileSurfaceView', 'components/FileSurfaceView.tsx'], ['reduceDocumentRead', 'lib/file-workbench-state.ts'], ['editorSaveAction', 'lib/editor-save-shortcut.ts']]) {
    const hits = []
    for (const file of product) if (relative(repository, file) !== base + definition) {
      const lines = (await readFile(file, 'utf8')).split('\n')
      lines.forEach((line, index) => { if (!/^\s*(?:import|export|\/\/|\*)/.test(line) && new RegExp(symbol === 'FileSurfaceView' ? '<FileSurfaceView\\b' : '\\b' + symbol + '\\s*\\(').test(line)) hits.push({ path: relative(repository, file), line: index + 1, text: line.trim() }) })
    }
    assert.ok(hits.length > 0, 'Definition-external production callers are nonempty: ' + symbol); result.callers[symbol] = hits
  }
  const baseline = await run('baseline-green'); assert.equal(baseline.exit, 0, baseline.output)
  assert.match(baseline.output, /Tests\s+\d+ passed/); result.baseline = { ...baseline, output: undefined }
  const typecheck = spawn(process.execPath, ['node_modules/typescript/bin/tsc', '--noEmit', '-p', 'apps/desktop/scripts/fixtures/file-save-recovery/tsconfig.json'], { cwd: clone, stdio: ['ignore', 'pipe', 'pipe'] })
  let typeOutput = ''
  typecheck.stdout.on('data', bytes => { typeOutput += bytes }); typecheck.stderr.on('data', bytes => { typeOutput += bytes })
  const typeTimeout = setTimeout(() => typecheck.kill('SIGTERM'), 90000)
  const typeExit = await new Promise((accept, reject) => { typecheck.once('error', reject); typecheck.once('close', accept) })
  clearTimeout(typeTimeout); await writeFile(join(evidence, 'typecheck.log'), typeOutput)
  assert.equal(typeExit, 0, typeOutput); result.typecheck = { exit: typeExit, log: 'typecheck.log', sha256: hash(typeOutput) }
  for (const [name, file, anchor, replacement, test, pattern] of mutations) {
    const path = join(clone, base + file), original = await readFile(path, 'utf8')
    assert.equal(original.split(anchor).length - 1, 1, 'The actual Source mutation anchor is unique: ' + name)
    const changed = original.replace(anchor, replacement); assert.notEqual(changed, original)
    await writeFile(path, changed)
    const red = await run(name + '-red', [test], pattern)
    assert.notEqual(red.exit, 0, 'Broken behavior fails: ' + name); assert.match(red.output, /AssertionError:/)
    assert.doesNotMatch(red.output, /No test files found|Failed to load url|failed to resolve import|Transform failed|SyntaxError:|ReferenceError:/)
    await writeFile(path, original)
    const green = await run(name + '-restored-green', [test], pattern); assert.equal(green.exit, 0, green.output)
    assert.match(green.output, /Tests\s+\d+ passed/)
    assert.equal(hash(await readFile(join(repository, base + file))), hash(original), 'The candidate owner was not mutated')
    result.mutations.push({ name, path: base + file, originalSha256: hash(original), mutatedSha256: hash(changed), red: { ...red, output: undefined }, green: { ...green, output: undefined } })
  }
  assert.equal(result.mutations.length, mutations.length); result.codeVerified = true
  if (!codeOnly) await visualEvidence()
  result.passed = true
} catch (error) { result.failure = { name: error.name, message: error.message, stack: error.stack } }
finally { await rm(clone, { recursive: true, force: true }); result.temporarySourceRemoved = true; await writeFile(join(evidence, 'receipt.json'), JSON.stringify(result, null, 2) + '\n') }
console.log(JSON.stringify({ passed: result.passed, codeVerified: result.codeVerified, mode: result.mode, mutations: result.mutations.length, receipt: relative(repository, join(evidence, 'receipt.json')), failure: result.failure?.message }))
if (!result.passed) process.exitCode = 1
