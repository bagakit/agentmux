import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { access, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { promisify } from 'node:util'
import { build } from 'vite'
import { readVisualSource } from './fixtures/goal-responsibility/source.mjs'
import { qualifyNativeEvidence, qualifyCostEvidence } from './fixtures/goal-responsibility/evidence.mjs'
import { listProbeProcesses, runProbeProcess, stopProbeProcesses } from './probe-process.mjs'

const desktop = resolve(import.meta.dirname, '..'), repository = resolve(desktop, '../..')
const fixture = join(desktop, 'scripts/fixtures/goal-responsibility')
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const exec = promisify(execFile)
const args = process.argv.slice(2), options = {}
for (let index = 0; index < args.length; index++) {
  const flag = args[index]
  if (flag === '--prepare-only') options.prepareOnly = true
  else if (['--source', '--electron', '--evidence'].includes(flag)) {
    assert.ok(args[index + 1] && !args[index + 1].startsWith('--'), flag + ' requires one exact path.')
    options[flag.slice(2)] = args[++index]
  } else if (flag === '--help') {
    console.log('Usage: node apps/desktop/scripts/verify-goal-responsibility-journey.mjs --source FILE --electron EXISTING_BINARY [--evidence DIR] [--prepare-only]\n'
      + 'Environment equivalents: AGENTMUX_GOAL_RESPONSIBILITY_JOURNEY, AGENTMUX_GOAL_RESPONSIBILITY_ELECTRON (or AGENTMUX_PROOF_ELECTRON_PATH), AGENTMUX_GOAL_RESPONSIBILITY_EVIDENCE.\n'
      + 'Default source: .tmp/goal-responsibility/t005/source/journey.json. The default gate consumes original Native, workface and cost receipts before capture; it never reruns Native input or downloads Electron. Independent aesthetic review remains required.')
    process.exit(0)
  } else throw new Error('Unknown responsibility capture option: ' + flag)
}
const sourcePath = options.source ?? process.env.AGENTMUX_GOAL_RESPONSIBILITY_JOURNEY ?? join(repository, '.tmp/goal-responsibility/t005/source/journey.json')
const electron = options.electron ?? process.env.AGENTMUX_GOAL_RESPONSIBILITY_ELECTRON ?? process.env.AGENTMUX_PROOF_ELECTRON_PATH
if (!options.prepareOnly) assert.ok(electron && isAbsolute(electron), 'Supply an existing absolute Electron binary path; this runner never installs or downloads one.')
const evidence = resolve(options.evidence ?? process.env.AGENTMUX_GOAL_RESPONSIBILITY_EVIDENCE ?? join(repository, '.tmp/goal-responsibility/t005', 'visual-' + randomUUID()))
await mkdir(evidence, { recursive: true })
const privateRoot = await mkdtemp(join(tmpdir(), 'amx-goal-responsibility-'))
const result = { schema: 'agentmux.goal-responsibility-visual-capture.v1', scope: 'production-renderer-recorded-transport',
  captureOnly: true, aestheticReview: 'not-performed', prepared: false, passed: false, userRunTouched: false,
  humanWindowFocusTaken: false, privateRoot, evidence, processes: [], frames: [], limits: [
    'Actual production App, Goal, Mote and Region consumers and CSS in hidden Chromium; transport replies are captured original public results.',
    'The pointer action proves the accurate original patrol request consumer. It does not submit a second live PMO input.',
    'Reload and process relaunch exercise a private Renderer profile and production layout projection. Core/Native lifecycle remains separately owned.',
    'Aesthetic acceptance requires an independent reviewer to open these exact full images.'
  ] }
const sourceFiles = new Map()
const evidenceInputs = new Map()
async function currentHash(file) {
  if (!evidenceInputs.has(file)) evidenceInputs.set(file, hash(await readFile(file)))
  return evidenceInputs.get(file)
}
const git = async (...arguments_) => (await exec('git', arguments_, { cwd: repository, maxBuffer: 32 * 1024 * 1024 })).stdout
const candidate = async () => ({ commit: (await git('rev-parse', 'HEAD')).trim(), tree: (await git('rev-parse', 'HEAD^{tree}')).trim(),
  trackedDiffSha256: hash(await git('diff', '--binary', 'HEAD')), statusSha256: hash(await git('status', '--porcelain=v1', '-z')) })
async function remember(file) {
  const absolute = resolve(file), key = relative(repository, absolute)
  if (key.startsWith('..') || key.includes('node_modules/') || !(await stat(absolute).catch(() => null))?.isFile()) return
  const digest = hash(await readFile(absolute)), existing = sourceFiles.get(key)
  if (existing) assert.equal(digest, existing, 'A production source changed while Vite was reading it: ' + key)
  sourceFiles.set(key, digest)
}
async function verifySources() {
  assert.ok(sourceFiles.size > 0, 'The actual loaded production graph must be nonempty.')
  for (const [file, digest] of sourceFiles) assert.equal(hash(await readFile(join(repository, file))), digest,
    'The captured production source changed: ' + file)
}
async function compiledFiles(directory) {
  const files = {}
  for (const entry of await readdir(directory, { recursive: true, withFileTypes: true })) if (entry.isFile()) {
    const file = join(entry.parentPath, entry.name), bytes = await readFile(file)
    assert.ok(bytes.length > 0, 'Compiled product files must be nonempty.')
    files[relative(directory, file)] = hash(bytes)
  }
  assert.ok(Object.keys(files).length > 0)
  return files
}
try {
  result.candidate = await candidate()
  const source = await readVisualSource(resolve(sourcePath), repository)
  result.input = { path: resolve(sourcePath), sha256: source.sourceSha256, originalReceipt: source.originalReceipt, boundary: source.source.boundary }
  await writeFile(join(evidence, 'source-input.json'), await readFile(sourcePath))
  // A prior receipt remains useful history; changed source cannot qualify this candidate capture.
  const originalReceipt = JSON.parse(await readFile(source.originalReceipt.path, 'utf8'))
  result.originalSourceMismatches = []
  for (const original of originalReceipt.source) {
    const actual = hash(await readFile(join(repository, original.file)))
    if (actual !== original.sha256) result.originalSourceMismatches.push({ file: original.file, expected: original.sha256, actual })
    await remember(join(repository, original.file))
  }
  result.actualCliSha256 = hash(await readFile(join(repository, 'packages/core/dist/agentmux.js')))
  if (!options.prepareOnly) {
    assert.deepEqual(result.originalSourceMismatches, [], 'The original public journey source is stale; obtain a fresh original recording, do not replay a send.')
    assert.equal(result.actualCliSha256, source.source.cliSha256, 'The source public CLI does not belong to this compiled candidate.')
    await access(electron, constants.X_OK)
    result.electron = { path: electron, sha256: hash(await readFile(electron)) }
    result.qualifications = {
      native: await qualifyNativeEvidence(resolve(process.env.AGENTMUX_GOAL_RESPONSIBILITY_NATIVE_RECEIPT ?? join(repository, '.tmp/goal-responsibility/t005/native/receipt.json')),
        'responsibility', repository, currentHash),
      workface: await qualifyNativeEvidence(resolve(process.env.AGENTMUX_GOAL_RESPONSIBILITY_WORKFACE_RECEIPT ?? join(repository, '.tmp/typed-native-restart/last/receipt.json')),
        'workface', repository, currentHash),
      cost: await qualifyCostEvidence(resolve(process.env.AGENTMUX_GOAL_RESPONSIBILITY_COST_RECEIPT ?? join(repository, '.tmp/goal-responsibility/t005/cost-receipt.json')),
        repository, currentHash)
    }
    result.scope = 'combined-original-public-native-workface-cost-and-renderer'
    result.captureOnly = false
  }
  for (const file of [import.meta.filename, join(fixture, 'source.mjs'), join(fixture, 'evidence.mjs'), join(fixture, 'entry.tsx'), join(fixture, 'index.html'), join(fixture, 'preload.cjs'), join(fixture, 'main.cjs'), join(desktop, 'scripts/probe-process.mjs'), join(desktop, 'scripts/verify-goal-responsibility-mutations.mjs')]) await remember(file)
  const outDir = join(evidence, 'compiled')
  await build({ configFile: false, root: fixture, base: './', logLevel: 'error',
    define: { __AGENTMUX_WEB_PREVIEW__: 'true', 'process.env.NODE_ENV': '"production"' }, esbuild: { jsx: 'automatic' }, worker: { format: 'es' },
    plugins: [{ name: 'responsibility-source-receipt', enforce: 'pre',
      async transform(_code, id) { if (!id.startsWith('\0')) await remember(id.split('?')[0]) } }],
    build: { outDir, minify: false, sourcemap: false, emptyOutDir: true,
      commonjsOptions: { include: [/node_modules/, /xterm-locked-925/] } } })
  result.compiled = await compiledFiles(outDir)
  await writeFile(join(evidence, 'compiled.json'), JSON.stringify(result.compiled, null, 2))
  result.sources = Object.fromEntries([...sourceFiles].sort(([left], [right]) => left.localeCompare(right)))
  await verifySources()
  result.prepared = true
  if (options.prepareOnly) {
    result.qualification = 'prepared-only; no Electron process or screenshots were produced'
  } else {
    const normalizedPath = join(privateRoot, 'source.json')
    await writeFile(normalizedPath, JSON.stringify({ ...source, privateRoot }))
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    delete env.AGENTMUX_RPC_ENDPOINT
    delete env.AGENTMUX_SESSION_ID
    delete env.AGENTMUX_CAPABILITY
    delete env.AGENTMUX_AGENT_SESSION_ID
    delete env.AGENTMUX_AGENT_CAPABILITY
    for (const phase of ['capture', 'restore']) {
      const log = []
      let outcome
      try {
        outcome = await runProbeProcess(electron, [join(fixture, 'main.cjs'), join(outDir, 'index.html'), join(fixture, 'preload.cjs'),
          normalizedPath, privateRoot, evidence, phase], { cwd: repository, env, timeoutMs: 120_000, onLine: line => log.push(line) })
      } catch (error) {
        result.processes.push({ phase, ...(error.probe ?? { exitConfirmed: false }) })
        throw error
      } finally { await writeFile(join(evidence, phase + '-process.log'), log.join('\n')) }
      result.processes.push({ phase, ...outcome })
      const render = JSON.parse(await readFile(join(evidence, phase + '-render.json'), 'utf8'))
      assert.equal(outcome.exitCode, 0, JSON.stringify(render.failure))
      assert.equal(render.passed, true, JSON.stringify(render.failure))
      assert.ok(render.frames.length > 0)
      assert.equal(render.windowShown, false)
      assert.equal(render.windowFocused, false)
      assert.ok(render.windowFacts.length > render.frames.length, 'Each real process needs nonempty Window visibility/focus observations.')
      for (const observation of render.windowFacts) {
        assert.equal(observation.visible, false)
        assert.equal(observation.focused, false)
        assert.equal(observation.focusable, false)
        assert.equal(observation.focusedWindowId, null)
      }
      result.frames.push(...render.frames)
    }
    assert.notEqual(result.processes[0].originalPid, result.processes[1].originalPid, 'Relaunch requires another real Electron process.')
    assert.equal(result.frames.length >= 27, true, 'Both original capture and a real process relaunch must have nonempty frames.')
    await verifySources()
    for (const [file, expected] of evidenceInputs) assert.equal(hash(await readFile(file)), expected,
      'A qualified Native/cost source or build changed during the combined journey: ' + file)
    for (const qualification of Object.values(result.qualifications)) for (const [file, expected] of Object.entries(qualification.artifactHashes))
      assert.equal(hash(await readFile(file)), expected, 'Original qualification evidence changed during capture: ' + file)
    assert.equal(hash(await readFile(sourcePath)), result.input.sha256, 'The original public journey input changed during capture.')
    assert.equal(hash(await readFile(result.input.originalReceipt.path)), result.input.originalReceipt.sha256,
      'The original public journey receipt changed during capture.')
    assert.deepEqual(await compiledFiles(outDir), result.compiled, 'Captured compiled product bytes changed.')
    assert.deepEqual(await candidate(), result.candidate, 'The exact candidate changed during capture.')
    result.passed = true
    await writeFile(join(evidence, 'review.md'), [
      '# Goal responsibility screenshots — independent review pending', '',
      `Candidate commit: ${result.candidate.commit}. Exact source and compiled bytes: [receipt.json](receipt.json).`, '',
      'Production App and CSS; original public journey facts; recorded transport only. Native lifecycle and actual PMO input proof remain with the original journey owner.',
      'The hidden window did not take human focus. The private Renderer profile retained its own layout, drafts and patrol feedback through reload and a second process.', '',
      ...result.frames.map(frame => `- ${frame.name}: [complete image](${frame.file})`), '',
      'Open every listed image and review hierarchy, density, responsibility/next action, error and delivery/report distinctions, clipping, and width/brightness behavior. Capture does not grant aesthetic approval.', ''
    ].join('\n'))
  }
} catch (error) {
  result.failure = { name: error.name, message: error.message, stack: error.stack, ...(error.probe ? { probe: error.probe } : {}) }
} finally {
  try {
    // The unique private root identifies this invocation; never signal the user's Electron or Run.
    await stopProbeProcesses(process.pid + 1000000000, privateRoot)
    result.remainingProcesses = await listProbeProcesses(process.pid + 1000000000, privateRoot)
    assert.deepEqual(result.remainingProcesses, [])
    if (result.passed || result.prepared && options.prepareOnly) {
      await rm(privateRoot, { recursive: true })
      result.privateProfileRemoved = true
    } else result.privateProfileRetained = true
  } catch (error) {
    result.passed = false
    result.cleanupFailure = { name: error.name, message: error.message }
  }
  await writeFile(join(evidence, 'receipt.json'), JSON.stringify(result, null, 2))
}
console.log(JSON.stringify({ prepared: result.prepared, passed: result.passed, qualification: result.qualification,
  receipt: join(evidence, 'receipt.json'), review: result.passed ? join(evidence, 'review.md') : null, failure: result.failure, cleanupFailure: result.cleanupFailure }))
if (!result.passed && !(options.prepareOnly && result.prepared && !result.cleanupFailure)) process.exitCode = 1
