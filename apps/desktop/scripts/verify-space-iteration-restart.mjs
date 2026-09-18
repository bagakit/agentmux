import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { runProbeProcess, listProbeProcesses } from './probe-process.mjs'

const script = fileURLToPath(import.meta.url)
const desktop = path.resolve(path.dirname(script), '..')
const root = path.resolve(desktop, '../..')
const fixture = path.join(desktop, 'scripts/fixtures/space-iteration-restart')
// Runtime output is ignored; running a gate must not mutate its tracked input receipts.
const evidence = path.join(root, '.tmp/space-iteration-restart/last')
const require = createRequire(path.join(desktop, 'package.json'))
const ts = require('typescript')
const execFileAsync = promisify(execFile)
const { build } = await import(pathToFileURL(require.resolve('vite')).href)
const electron = require('electron')
const provisional = process.argv.includes('--provisional')
const caseIndex = process.argv.indexOf('--case')
const selectedCase = caseIndex < 0 ? null : process.argv[caseIndex + 1]
assert.ok(selectedCase === null || (provisional && ['empty-restore', 'timeout-restore', 'recovery-timeout-restore'].includes(selectedCase)),
  'A case selection is only a provisional diagnostic; the canonical gate must run all restart cases')
const phases = selectedCase ? ['seed', selectedCase] : ['seed', 'empty-restore', 'timeout-restore', 'recovery-timeout-restore']
const privateRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agentmux-space-restart-'))
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
function sourceScope(source, file, symbol, kind, contains) {
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
  const matches = []
  const match = node => {
    switch (kind) {
      case 'function': return ts.isFunctionDeclaration(node) && node.name?.getText(ast) === symbol
      case 'method': return ts.isMethodDeclaration(node) && node.name?.getText(ast) === symbol
      case 'if': return ts.isIfStatement(node) && node.expression.getText(ast) === symbol
      case 'call': return ts.isCallExpression(node) && node.expression.getText(ast) === symbol
      case 'for-of': return ts.isForOfStatement(node) && node.expression.getText(ast) === symbol
      case 'variable': return ts.isVariableDeclaration(node) && node.name.getText(ast) === symbol
      default: throw new Error(`Unknown source scope kind: ${kind}`)
    }
  }
  const visit = node => {
    const text = source.slice(node.getStart(ast), node.end)
    if (match(node) && (!contains || text.includes(contains))) matches.push(text)
    ts.forEachChild(node, visit)
  }
  visit(ast)
  assert.equal(matches.length, 1, `A scoped binding must identify exactly one ${kind} ${symbol}`)
  assert.ok(matches[0].length > 0)
  return matches[0]
}
async function validateScopedBindings(proof) {
  const results = []
  for (const binding of proof.scoped_bindings ?? []) {
    const { stdout: original } = await execFileAsync('git', ['show', `${binding.proven_source.commit}:${binding.file}`], { cwd: root, maxBuffer: 16 * 1024 * 1024 })
    assert.equal(hash(original), binding.proven_source.sha256, 'The historical blob must match the actual mutation receipt SHA')
    const oldScope = sourceScope(original, binding.file, binding.symbol, binding.kind, binding.contains)
    const currentScope = sourceScope(await fs.readFile(path.join(root, binding.file), 'utf8'), binding.file, binding.symbol, binding.kind, binding.contains)
    assert.equal(hash(oldScope), binding.scope_sha256)
    assert.equal(currentScope, oldScope, `${binding.symbol} changed since its behavior mutation`)
    results.push({ file: binding.file, symbol: binding.symbol, scopeSha256: hash(currentScope), provenSource: binding.proven_source })
  }
  return results
}
async function consumeTerminalAppProof() {
  const file = path.join(root, '.tmp/topic-terminal-open-close-restart/last/receipt.json')
  let bytes
  try { bytes = await fs.readFile(file) } catch (error) {
    if (error.code !== 'ENOENT') throw error
    return { missing: true, path: path.relative(root, file) }
  }
  const terminal = JSON.parse(bytes)
  const result = { path: path.relative(root, file), digest: hash(bytes), passed: false, staleInputs: [] }
  try {
    assert.equal(terminal.schema, 'agentmux.topic-terminal-open-close-restart.v1')
    assert.equal(terminal.passed, true)
    assert.ok(Object.keys(terminal.inputs ?? {}).length > 0, 'Actual App receipt must bind nonempty production inputs')
    for (const [name, digest] of Object.entries(terminal.inputs)) {
      try { if (hash(await fs.readFile(path.join(root, name))) !== digest) result.staleInputs.push(name) }
      catch (error) { if (error.code !== 'ENOENT') throw error; result.staleInputs.push(name) }
    }
    assert.deepEqual(result.staleInputs, [], 'Actual App/Core/ctxmux receipt must belong to this joined candidate')
    assert.equal(terminal.phases.length, 2)
    assert.deepEqual(terminal.phases.map(phase => phase.phase), ['seed', 'restore'])
    assert.equal(new Set(terminal.phases.map(phase => phase.native.pid)).size, 2)
    assert.ok(terminal.originalRuns.length > 0 && terminal.survivingRuns.length > 0)
    for (const run of terminal.originalRuns) assert.ok(Number.isInteger(run.pid) && run.pid > 0)
    assert.equal(terminal.survivingRuns.length + 1, terminal.originalRuns.length)
    for (const survivor of terminal.survivingRuns) assert.ok(terminal.originalRuns.some(original => original.runId === survivor.runId && original.pid === survivor.pid), 'Healthy private Runs must retain original identity and PID')
    for (const phase of terminal.phases) {
      assert.equal(phase.exit.exitCode, 0); assert.equal(phase.exit.timedOut, false); assert.equal(phase.native.passed, true)
      const native = phase.native, ui = native.initial.ui
      assert.ok(Number.isInteger(native.pid) && native.pid > 0)
      assert.ok(ui.regions.length > 0)
      assert.equal(new Set(ui.regions).size, ui.regions.length)
      assert.equal(ui.sessionPanes, ui.terminals.length)
      assert.equal(ui.terminals.length, terminal.originalRuns.length)
      assert.equal(new Set(ui.terminals.map(terminal => terminal.regionId)).size, ui.terminals.length)
      for (const terminal of ui.terminals) assert.ok(ui.regions.includes(terminal.regionId))
      assert.deepEqual(native.floating.regions, ui.regions)
      assert.equal(native.floating.sessionPanes, ui.sessionPanes)
      assert.ok(native.reading.length >= 5, 'Continuous history reading must include five actual wheel movements')
      for (const movement of native.reading) {
        assert.ok(movement.after < movement.before); assert.equal(movement.protocolOperations, 0)
      }
      assert.ok(Object.keys(native.eventConsumers.raw).length > 0)
      for (const count of Object.values(native.eventConsumers.raw)) assert.ok(Number.isInteger(count) && count > 0)
      assert.deepEqual(native.eventConsumers.delivered, native.eventConsumers.raw, 'Each real Run must reach one actual terminal consumer')
      const expectedOwners = phase.phase === 'seed' ? terminal.originalRuns.length : terminal.survivingRuns.length
      assert.equal(native.owners.sessionAttachmentOwners, expectedOwners)
      assert.equal(native.owners.sessionAttachmentLeases, expectedOwners)
    }
    assert.deepEqual(terminal.cleanup.errors, []); assert.deepEqual(terminal.cleanup.remaining, [])
    assert.equal(terminal.cleanup.temporaryRootRemoved, true)
    result.passed = true
    result.inputCount = Object.keys(terminal.inputs).length
    result.phases = terminal.phases.map(phase => ({ phase: phase.phase, pid: phase.native.pid, reading: phase.native.reading,
      eventConsumers: phase.native.eventConsumers, owners: phase.native.owners }))
    result.originalRuns = terminal.originalRuns; result.survivingRuns = terminal.survivingRuns
    result.cleanup = terminal.cleanup
  } catch (error) { result.failure = error.message }
  return result
}
const receipt = { schema: 'agentmux.space-iteration-restart.v1', passed: false, completeGate: false,
  provisional, phases: [], inputs: null, prerequisiteProofs: [], cleanup: null,
  limitations: ['Real Electron process restart and production initialize/persistence/UI/filesystem are exercised.',
    'Session snapshots, attachment and recovery use a controlled public API boundary. No actual Core/ctxmux Run survival is claimed.',
    'Initial workface topology is a private seeded fixture; restoration is performed only by the ordinary production initialize path.',
    'No user application, user profile, user Session or healthy user Run is accessed.'] }
const files = async directory => {
  const entries = await fs.readdir(directory, { withFileTypes: true })
  return (await Promise.all(entries.map(entry => entry.isDirectory()
    ? files(path.join(directory, entry.name)) : [path.join(directory, entry.name)]))).flat()
}
const hashes = async () => {
  // Re-read the inventory as well as bytes: a source added during the run changes the candidate.
  const inputs = [script, ...await files(fixture), ...await files(path.join(desktop, 'src')), electron]
  return Object.fromEntries(await Promise.all(inputs.map(async file => [
    path.relative(root, file), hash(await fs.readFile(file))
  ])))
}
await fs.mkdir(evidence, { recursive: true })
try {
  receipt.inputs = await hashes()
  await build({ configFile: false, root: fixture, base: './', logLevel: 'error',
    define: { __AGENTMUX_WEB_PREVIEW__: 'true', 'process.env.NODE_ENV': '"production"' },
    build: { target: 'esnext', outDir: path.join(privateRoot, 'renderer'), emptyOutDir: true } })
  await build({ configFile: false, root: fixture, logLevel: 'error',
    build: { ssr: path.join(fixture, 'main.ts'), target: 'node22', outDir: path.join(privateRoot, 'main'), emptyOutDir: true,
      rollupOptions: { external: ['electron'], output: { format: 'cjs', entryFileNames: 'main.cjs' } } } })
  const preload = path.join(fixture, 'preload.cjs')
  const scratch = { id: '__scratch__', hostId: 'local', name: 'Topics', path: path.join(privateRoot, 'topics'), kind: 'folder' }
  await fs.mkdir(scratch.path, { recursive: true })
  // Seed private authored files; production ScratchTopics performs discovery and all subsequent reads.
  // Their paths and contents are durable inputs, never relocated or rewritten during restart.
  for (const [name, title, summary] of [['topic--view--original', 'Original Topic', 'Original shared goal'],
    ['topic--view--other', 'Other Topic', 'Other shared goal'], ['topic--launcher--leader', 'Mote', 'Global coordination']]) {
    const directory = path.join(scratch.path, name)
    for (const child of ['', '.agents', 'refs', 'outcome']) await fs.mkdir(path.join(directory, child), { recursive: true })
    await fs.writeFile(path.join(directory, 'topic.md'), `# ${title}\n\n${summary}\n`)
  }
  await fs.writeFile(path.join(scratch.path, 'topic--launcher--leader/SOUL.md'), '# Durable Mote identity\n\nPMO is one default role.\n')
  await fs.writeFile(path.join(scratch.path, 'topic--view--original/.agents/codex.private-live-agent.identity.md'), '# Existing Agent\n\n- Provider: codex\n- Session: private-live-agent\n')
  const topicFiles = await files(scratch.path)
  receipt.topicFilesBefore = Object.fromEntries(await Promise.all(topicFiles.map(async file => [path.relative(scratch.path, file), hash(await fs.readFile(file))])))
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  for (const phase of phases) {
    // A process that never publishes its own result cannot inherit a previous invocation's pass.
    await fs.rm(path.join(evidence, `${phase}.json`), { force: true })
    await fs.rm(path.join(evidence, `${phase}.png`), { force: true })
    const stderr = []
    const exit = await runProbeProcess(electron, [path.join(privateRoot, 'main/main.cjs'), path.join(privateRoot, 'renderer/index.html'),
      privateRoot, phase, preload, evidence], { temporaryRoot: privateRoot, cwd: root, env, timeoutMs: 25000,
      onLine: line => stderr.push(line.slice(0, 1500)) })
    const native = JSON.parse(await fs.readFile(path.join(evidence, `${phase}.json`), 'utf8'))
    receipt.phases.push({ phase, exit, stderr, native })
    assert.equal(exit.timedOut, false, `${phase} watchdog fired`)
    assert.equal(exit.exitCode, 0, native.failure?.message)
    assert.equal(native.passed, true)
  }
  assert.equal(new Set(receipt.phases.map(phase => phase.native.pid)).size, phases.length, 'Every restart must use a distinct real Electron PID')
  receipt.topicFilesAfter = Object.fromEntries(await Promise.all(topicFiles.map(async file => [path.relative(scratch.path, file), hash(await fs.readFile(file))])))
  assert.deepEqual(receipt.topicFilesAfter, receipt.topicFilesBefore, 'Restart must preserve Topic, Agent plaque and Mote SOUL contents')
  assert.deepEqual(await hashes(), receipt.inputs, 'Source changed while verifying this candidate')
  const ownProofPath = path.join(root, 'docs/reviews/evidence/space-topic-role-iteration/T-008/proof.json')
  const ownProofBytes = await fs.readFile(ownProofPath)
  const ownProof = JSON.parse(ownProofBytes)
  const ownScopedBindings = await validateScopedBindings(ownProof)
  assert.ok(ownScopedBindings.length > 0, 'Restart mutation evidence must have nonempty exact source scope bindings')
  assert.equal(ownProof.mutations.length, 2)
  for (const mutation of ownProof.mutations) {
    assert.equal(mutation.result, 'red'); assert.equal(mutation.exit_code, 1)
    assert.equal(mutation.source_restored_exactly, true)
    assert.ok(ownScopedBindings.some(binding => binding.file === mutation.file && binding.provenSource.sha256 === mutation.original_sha256),
      'The original mutation SHA must be retained by an exact historical source comparison')
    assert.ok((await fs.readFile(path.join(root, mutation.log))).length > 0)
    assert.ok((await fs.readFile(path.join(root, mutation.file), 'utf8')).includes(mutation.original))
  }
  receipt.restartMutationProof = { digest: hash(ownProofBytes), scopedBindings: ownScopedBindings }
  for (const task of ['T-001', 'T-002', 'T-003', 'T-004', 'T-005', 'T-006', 'T-007', 'T-009', 'T-010']) {
    const file = path.join(root, 'docs/reviews/evidence/space-topic-role-iteration', task, 'proof.json')
    let proof
    try { proof = JSON.parse(await fs.readFile(file, 'utf8')) } catch (error) {
      if (error.code !== 'ENOENT') throw error
      receipt.prerequisiteProofs.push({ task, missing: true }); continue
    }
    // These are the actual task receipts, authored by different task owners. Normalize their
    // explicit evidence fields; a missing candidate binding must never become a green gate.
    const mutations = proof.mutations ?? (Array.isArray(proof.mutation) ? proof.mutation : proof.mutation ? [proof.mutation] : [])
    const mutationFiles = [...new Set(mutations.map(one => one.file ?? proof.file).filter(Boolean))]
    const bindings = { ...proof.candidate_files }
    if (proof.file && proof.digest) bindings[proof.file] = proof.digest
    if (proof.binding?.source_file && proof.binding.source_sha256) bindings[proof.binding.source_file] = proof.binding.source_sha256
    if (proof.binding?.test_file && proof.binding.test_sha256) bindings[proof.binding.test_file] = proof.binding.test_sha256
    if (proof.source_sha256 && mutationFiles.length === 1) bindings[mutationFiles[0]] = proof.source_sha256
    const scopedBindings = await validateScopedBindings(proof)
    const stale = []
    const scopedFileChanges = []
    for (const [name, digest] of Object.entries(bindings)) {
      if (hash(await fs.readFile(path.join(root, name))) !== digest) {
        if (scopedBindings.some(binding => binding.file === name && binding.provenSource.sha256 === digest)) scopedFileChanges.push(name)
        else stale.push(name)
      }
    }
    const mutationEvidence = []
    for (const one of mutations) {
      const source = one.file ?? proof.file
      const originalPresent = one.original && source ? (await fs.readFile(path.join(root, source), 'utf8')).includes(one.original) : null
      let logDigest = null
      if (one.log) logDigest = hash(await fs.readFile(path.join(root, one.log)))
      mutationEvidence.push({ source, exitCode: one.exit_code, originalPresent, logDigest })
    }
    const callerGroups = Array.isArray(proof.production_callers)
      ? proof.production_callers.map(one => typeof one === 'string'
        ? { callers: [one], excluded: proof.definition_excluded ?? proof.file ?? mutationFiles[0] }
        : { callers: one.callers ?? [], excluded: one.excluded_definition })
      : Object.entries(proof.production_callers ?? {}).map(([symbol, callers]) => ({ symbol, callers, excluded: mutationFiles.find(file => path.basename(file, path.extname(file)) === symbol) }))
    const externalCallers = callerGroups.map(group => group.callers.filter(caller => {
      const file = typeof caller === 'string' ? caller.split(':')[0] : caller.file
      return file && (!group.excluded || (file !== group.excluded && path.basename(file) !== path.basename(group.excluded)))
    }))
    receipt.prerequisiteProofs.push({ task, digest: hash(await fs.readFile(file)),
      candidateBindings: bindings, scopedBindings, scopedFileChanges, mutationEvidence,
      mutationsRed: mutationEvidence.length > 0 && mutationEvidence.every(one => Number.isInteger(one.exitCode) && one.exitCode > 0 && one.logDigest && one.originalPresent !== false),
      productionCallersPresent: externalCallers.length > 0 && externalCallers.every(callers => callers.length > 0),
      staleCandidateFiles: stale })
  }
  receipt.terminalAppProof = await consumeTerminalAppProof()
  if (!provisional) {
    assert.equal(receipt.prerequisiteProofs.length, 9)
    for (const proof of receipt.prerequisiteProofs) {
      assert.equal(proof.missing, undefined, `${proof.task} proof missing`)
      assert.equal(proof.mutationsRed, true, `${proof.task} lacks nonempty red mutations`)
      assert.equal(proof.productionCallersPresent, true, `${proof.task} lacks real callers`)
      assert.ok(Object.keys(proof.candidateBindings).length > 0, `${proof.task} lacks an explicit candidate digest`)
      assert.deepEqual(proof.staleCandidateFiles, [], `${proof.task} proof was not rebound to this final candidate`)
    }
    assert.equal(receipt.terminalAppProof.passed, true, receipt.terminalAppProof.failure ?? 'Joined-candidate actual App/Core/ctxmux proof is missing')
  }
  assert.deepEqual(await hashes(), receipt.inputs, 'Source changed while binding final prerequisite proofs')
  receipt.passed = true
  receipt.completeGate = !provisional
} catch (error) { receipt.failure = { name: error.name, message: error.message, stack: error.stack } }
finally {
  receipt.cleanup = { remaining: await listProbeProcesses(-1, privateRoot), temporaryRootRemoved: false }
  if (receipt.cleanup.remaining.length === 0) {
    await fs.rm(privateRoot, { recursive: true, force: true })
    receipt.cleanup.temporaryRootRemoved = true
  }
  await fs.writeFile(path.join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2))
}
assert.equal(receipt.cleanup.remaining.length, 0)
assert.equal(receipt.cleanup.temporaryRootRemoved, true)
assert.equal(receipt.passed, true, receipt.failure?.message)
console.log(JSON.stringify({ passed: receipt.passed, completeGate: receipt.completeGate,
  phases: receipt.phases.map(phase => ({ phase: phase.phase, pid: phase.native.pid })), cleanup: receipt.cleanup }))
