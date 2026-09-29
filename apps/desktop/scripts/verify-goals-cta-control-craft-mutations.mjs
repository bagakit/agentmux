import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { build } from 'vite'
import { listProbeProcesses, runProbeProcess, stopProbeProcesses } from './probe-process.mjs'

const desktop = resolve(import.meta.dirname, '..'), repository = resolve(desktop, '../..'), require = createRequire(import.meta.url)
const copy = await realpath(await mkdtemp('/tmp/amx-goals-craft-mutation-')), copiedDesktop = join(copy, 'apps/desktop')
const evidence = join(repository, '.tmp/goals-cta-control-craft-mutations', `attempt-${Date.now()}`)
const board = 'src/renderer/src/components/GlobalBoardSurface.tsx', css = 'src/renderer/src/styles/goals.css'
const inputs = [board, css, 'scripts/fixtures/goals-surface/entry.tsx', 'scripts/fixtures/goals-surface/controls.cjs']
const original = new Map(await Promise.all(inputs.map(async file => [file, await readFile(join(desktop, file))])))
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const hashes = values => Object.fromEntries([...values].map(([file, bytes]) => [file, digest(bytes)]))
const receipt = { schema: 'agentmux.goals-cta-control-craft-mutations.v1', passed: false, sharedTreeMutations: 0, userRunTouched: false, sourceBefore: hashes(original), cases: [] }
const mutations = [
  { label: 'complete-request-unreadable', file: css, before: 'font: var(--fs-prose)/1.5 var(--font-sans);', after: 'font: 8px/1.5 var(--font-sans);', assertion: 'Complete request understand keeps readable prose size' },
  { label: 'acting-project-metadata-hidden', file: css, before: '.goals-entry__actions small { display: block;', after: '.goals-entry__actions small { display: none;', assertion: 'Exact acting Project metadata is actually visible' }
]
async function run(label) {
  const output = join(copy, label), runEvidence = join(evidence, label), fixture = join(copiedDesktop, 'scripts/fixtures/goals-surface')
  await mkdir(runEvidence, { recursive: true })
  let outputBytes = 0
  try {
  await build({ configFile: false, root: fixture, base: './', logLevel: 'error', define: { __AGENTMUX_WEB_PREVIEW__: 'true', 'process.env.NODE_ENV': '"production"' }, esbuild: { jsx: 'automatic' }, build: { outDir: output, minify: false, sourcemap: true, emptyOutDir: true, commonjsOptions: { include: [/node_modules/, /xterm-locked-925/] } } })
  const compiled = {}
  for (const entry of await readdir(output, { recursive: true, withFileTypes: true })) if (entry.isFile()) { const file = join(entry.parentPath, entry.name), bytes = await readFile(file); outputBytes += bytes.length; compiled[file.slice(output.length + 1)] = digest(bytes) }
  assert.ok(Object.keys(compiled).length > 0); await writeFile(join(runEvidence, 'compiled.json'), JSON.stringify(compiled, null, 2))
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  const log = [], outcome = await runProbeProcess(require('electron'), [join(fixture, 'controls.cjs'), join(output, 'index.html'), copy, runEvidence, 'assertions-only'], { temporaryRoot: copy, cwd: repository, env, timeoutMs: 30000, onLine: line => log.push(line) })
  await writeFile(join(runEvidence, 'process.log'), log.join('\n'))
  const render = JSON.parse(await readFile(join(runEvidence, 'render.json'), 'utf8'))
  return { outcome, render, evidence: runEvidence, compiledOutput: { files: Object.keys(compiled).length, bytes: outputBytes, removedAfterProcessExit: true } }
  } finally {
    // runProbeProcess resolves only after exit and owned descendants are reaped.
    // Keep the saved identities and results; retain at most one compiled build.
    await rm(output, { recursive: true, force: true })
  }
}
try {
  await mkdir(evidence, { recursive: true }); await mkdir(copiedDesktop, { recursive: true })
  await cp(join(desktop, 'src'), join(copiedDesktop, 'src'), { recursive: true })
  await cp(join(desktop, 'resources'), join(copiedDesktop, 'resources'), { recursive: true })
  await cp(join(desktop, 'scripts/fixtures/goals-surface'), join(copiedDesktop, 'scripts/fixtures/goals-surface'), { recursive: true })
  await symlink(join(desktop, 'node_modules'), join(copiedDesktop, 'node_modules'))
  await cp(join(desktop, 'package.json'), join(copiedDesktop, 'package.json'))
  await cp(join(desktop, 'tsconfig.json'), join(copiedDesktop, 'tsconfig.json'))
  await cp(join(repository, 'tsconfig.base.json'), join(copy, 'tsconfig.base.json'))
  for (const [file, bytes] of original) await writeFile(join(copiedDesktop, file), bytes)
  const baseline = await run('baseline-green'); assert.equal(baseline.outcome.exitCode, 0, JSON.stringify(baseline.render.failure)); assert.equal(baseline.render.passed, true); receipt.baseline = baseline
  for (const mutation of mutations) {
    const source = original.get(mutation.file).toString(); assert.equal(source.split(mutation.before).length - 1, 1, `Unique private Source anchor: ${mutation.label}`)
    let red
    try {
      await writeFile(join(copiedDesktop, mutation.file), source.replace(mutation.before, mutation.after))
      red = await run(`${mutation.label}-red`)
      assert.ok(red.outcome.exitCode > 0); assert.equal(red.render.passed, false)
      assert.equal(red.render.failure?.name, 'AssertionError', 'A setup/import error cannot satisfy the behavioral mutation')
      assert.ok(red.render.failure.message.includes(mutation.assertion), `Expected concrete Renderer assertion: ${mutation.assertion}`)
    } finally { await writeFile(join(copiedDesktop, mutation.file), original.get(mutation.file)) }
    assert.equal(digest(await readFile(join(copiedDesktop, mutation.file))), receipt.sourceBefore[mutation.file], 'Exact private Source bytes restored')
    const green = await run(`${mutation.label}-restore-green`); assert.equal(green.outcome.exitCode, 0, JSON.stringify(green.render.failure)); assert.equal(green.render.passed, true)
    receipt.cases.push({ ...mutation, red, restore: green })
  }
  receipt.sourceAfter = hashes(new Map(await Promise.all(inputs.map(async file => [file, await readFile(join(desktop, file))])))); assert.deepEqual(receipt.sourceAfter, receipt.sourceBefore)
  receipt.copyAfter = hashes(new Map(await Promise.all(inputs.map(async file => [file, await readFile(join(copiedDesktop, file))])))); assert.deepEqual(receipt.copyAfter, receipt.sourceBefore)
  receipt.passed = true
} catch (error) { receipt.failure = { name: error.name, message: error.message, stack: error.stack } }
finally {
  await stopProbeProcesses(process.pid + 1000000000, copy); receipt.remaining = await listProbeProcesses(process.pid + 1000000000, copy); assert.deepEqual(receipt.remaining, [])
  await rm(copy, { recursive: true, force: true }); receipt.cleanup = { privateCopyRemoved: true }
  await writeFile(join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2))
}
console.log(JSON.stringify({ passed: receipt.passed, mutants: receipt.cases.length, receipt: join(evidence, 'receipt.json'), failure: receipt.failure })); if (!receipt.passed) process.exitCode = 1
