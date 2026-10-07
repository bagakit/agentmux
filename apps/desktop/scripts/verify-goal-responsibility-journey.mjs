import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { access, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { build } from 'vite'
import { readVisualSource } from './fixtures/goal-responsibility/source.mjs'
import { readOriginalEvidence, qualifyNativeEvidence, qualifyCostEvidence } from './fixtures/goal-responsibility/evidence.mjs'
import { listProbeProcesses, runProbeProcess, stopProbeProcesses } from './probe-process.mjs'

const desktop = resolve(import.meta.dirname, '..'), repository = resolve(desktop, '../..')
const fixture = join(desktop, 'scripts/fixtures/goal-responsibility')
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const exec = promisify(execFile)
const args = process.argv.slice(2), options = {}
for (let index = 0; index < args.length; index++) {
  const flag = args[index]
  if (flag === '--prepare-only') options.prepareOnly = true
  else if (flag === '--capture-only') options.captureOnly = true
  else if (['--source', '--electron', '--evidence', '--capture-receipt'].includes(flag)) {
    assert.ok(args[index + 1] && !args[index + 1].startsWith('--'), flag + ' requires one exact path.')
    options[flag.slice(2)] = args[++index]
  } else if (flag === '--help') {
    console.log('Usage: node apps/desktop/scripts/verify-goal-responsibility-journey.mjs [--source FILE] [--electron EXISTING_BINARY] [--evidence DIR] [--prepare-only | --capture-only | --capture-receipt FILE]\n'
      + 'Environment equivalents: AGENTMUX_GOAL_RESPONSIBILITY_JOURNEY, AGENTMUX_GOAL_RESPONSIBILITY_ELECTRON (or AGENTMUX_PROOF_ELECTRON_PATH), AGENTMUX_GOAL_RESPONSIBILITY_EVIDENCE.\n'
      + 'Default source: .tmp/goal-responsibility/t005/source/journey.json. --capture-only preserves strict source/build/candidate checks and produces recorded-transport images only.\n'
      + '--capture-receipt (or AGENTMUX_GOAL_RESPONSIBILITY_CAPTURE_RECEIPT) reads an exact original capture and combines current Native/workface/cost evidence without rebuilding or recapturing. Its output directory must be separate.\n'
      + 'The default gate consumes original Native, workface and cost receipts; it never reruns Native input or downloads Electron. Independent aesthetic review remains required.')
    process.exit(0)
  } else throw new Error('Unknown responsibility capture option: ' + flag)
}
const sourcePath = options.source ?? process.env.AGENTMUX_GOAL_RESPONSIBILITY_JOURNEY ?? join(repository, '.tmp/goal-responsibility/t005/source/journey.json')
const captureReceipt = options['capture-receipt'] ?? process.env.AGENTMUX_GOAL_RESPONSIBILITY_CAPTURE_RECEIPT
assert.ok([options.prepareOnly, options.captureOnly, Boolean(captureReceipt)].filter(Boolean).length <= 1, 'Preparation, capture-only and original capture combination are mutually exclusive.')
const electron = options.electron ?? process.env.AGENTMUX_GOAL_RESPONSIBILITY_ELECTRON ?? process.env.AGENTMUX_PROOF_ELECTRON_PATH
if (!options.prepareOnly && !captureReceipt) assert.ok(electron && isAbsolute(electron), 'Supply an existing absolute Electron binary path; this runner never installs or downloads one.')
const evidence = resolve(options.evidence ?? process.env.AGENTMUX_GOAL_RESPONSIBILITY_EVIDENCE ?? join(repository, '.tmp/goal-responsibility/t005', 'visual-' + randomUUID()))
assert.equal(await stat(join(evidence, 'receipt.json')).catch(error => { if (error.code === 'ENOENT') return null; throw error }), null, 'A new proof must not overwrite an existing receipt; choose a new evidence directory.')
const originalCapture = captureReceipt ? await readOriginalEvidence(resolve(captureReceipt), 'agentmux.goal-responsibility-visual-capture.v1', repository) : null
const captureEvidence = originalCapture ? dirname(originalCapture.reference.path) : evidence
if (originalCapture) {
  const destination = relative(captureEvidence, evidence)
  assert.ok(destination === '..' || destination.startsWith('..' + sep) || isAbsolute(destination), 'Combination must not write inside the original capture directory.')
}
await mkdir(evidence, { recursive: true })
const privateRoot = captureReceipt ? null : await mkdtemp(join(tmpdir(), 'amx-goal-responsibility-'))
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
result.artifactHashes = {}
async function currentHash(file) {
  if (!evidenceInputs.has(file)) evidenceInputs.set(file, hash(await readFile(file)))
  return evidenceInputs.get(file)
}
async function artifact(file) {
  const digest = await currentHash(file)
  if (originalCapture) assert.equal(digest, originalCapture.receipt.artifactHashes?.[file], 'Original capture artifact changed: ' + file)
  result.artifactHashes[file] = digest
  return digest
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
  if (captureReceipt) {
    const saved = originalCapture.receipt
    assert.equal(saved.captureOnly, true); assert.equal(saved.scope, result.scope); assert.equal(saved.prepared, true)
    assert.deepEqual(saved.candidate, result.candidate, 'The original capture belongs to another candidate.')
    assert.deepEqual(saved.processes.map(value => value.phase), ['capture', 'restore'])
    assert.equal(saved.privateProfileRemoved, true); assert.deepEqual(saved.remainingProcesses, [])
    assert.equal(saved.userRunTouched, false); assert.equal(saved.humanWindowFocusTaken, false)
    assert.ok(saved.sources && Object.keys(saved.sources).length > 0 && Object.keys(saved.artifactHashes ?? {}).length > 0)
    for (const [file, digest] of Object.entries(saved.sources)) { await remember(join(repository, file)); assert.equal(sourceFiles.get(file), digest) }
    result.schema = 'agentmux.goal-responsibility-visual-combined.v1'
    result.originalCapture = { path: originalCapture.reference.path, sha256: originalCapture.reference.sha256 }
    result.captureEvidence = captureEvidence
    for (const key of ['path', 'pointerPath']) if (originalCapture.reference[key]) assert.equal(await currentHash(originalCapture.reference[key]), originalCapture.reference[key === 'path' ? 'sha256' : 'pointerSha256'])
  }
  const inputPath = originalCapture?.receipt.input.path ?? resolve(sourcePath)
  if (originalCapture && options.source) assert.equal(resolve(options.source), inputPath)
  const source = await readVisualSource(inputPath, repository)
  result.input = { path: inputPath, sha256: source.sourceSha256, originalReceipt: source.originalReceipt, boundary: source.source.boundary }
  if (!originalCapture) await writeFile(join(evidence, 'source-input.json'), await readFile(inputPath))
  assert.equal(await artifact(join(captureEvidence, 'source-input.json')), result.input.sha256)
  if (originalCapture) assert.deepEqual(result.input, originalCapture.receipt.input)
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
    result.electron = originalCapture?.receipt.electron ?? { path: electron, sha256: hash(await readFile(electron)) }
    await access(result.electron.path, constants.X_OK)
    assert.equal(await currentHash(result.electron.path), result.electron.sha256)
    if (!options.captureOnly) {
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
  }
  for (const file of [import.meta.filename, join(fixture, 'source.mjs'), join(fixture, 'evidence.mjs'), join(fixture, 'entry.tsx'), join(fixture, 'index.html'), join(fixture, 'preload.cjs'), join(fixture, 'main.cjs'), join(desktop, 'scripts/probe-process.mjs'), join(desktop, 'scripts/verify-goal-responsibility-mutations.mjs')]) await remember(file)
  const outDir = join(captureEvidence, 'compiled')
  if (!originalCapture) await build({ configFile: false, root: fixture, base: './', logLevel: 'error',
    define: { __AGENTMUX_WEB_PREVIEW__: 'true', 'process.env.NODE_ENV': '"production"' }, esbuild: { jsx: 'automatic' }, worker: { format: 'es' },
    plugins: [{ name: 'responsibility-source-receipt', enforce: 'pre',
      async transform(_code, id) { if (!id.startsWith('\0')) await remember(id.split('?')[0]) } }],
    build: { outDir, minify: false, sourcemap: false, emptyOutDir: true,
      commonjsOptions: { include: [/node_modules/, /xterm-locked-925/] } } })
  result.compiled = await compiledFiles(outDir)
  if (!originalCapture) await writeFile(join(evidence, 'compiled.json'), JSON.stringify(result.compiled, null, 2))
  await artifact(join(captureEvidence, 'compiled.json'))
  assert.deepEqual(JSON.parse(await readFile(join(captureEvidence, 'compiled.json'), 'utf8')), result.compiled)
  if (originalCapture) assert.deepEqual(result.compiled, originalCapture.receipt.compiled)
  result.sources = Object.fromEntries([...sourceFiles].sort(([left], [right]) => left.localeCompare(right)))
  if (originalCapture) assert.deepEqual(result.sources, originalCapture.receipt.sources)
  await verifySources()
  result.prepared = true
  if (options.prepareOnly) {
    result.qualification = 'prepared-only; no Electron process or screenshots were produced'
  } else {
    const normalizedPath = privateRoot && join(privateRoot, 'source.json')
    if (!originalCapture) await writeFile(normalizedPath, JSON.stringify({ ...source, privateRoot }))
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    delete env.AGENTMUX_RPC_ENDPOINT
    delete env.AGENTMUX_SESSION_ID
    delete env.AGENTMUX_CAPABILITY
    delete env.AGENTMUX_AGENT_SESSION_ID
    delete env.AGENTMUX_AGENT_CAPABILITY
    for (const phase of ['capture', 'restore']) {
      const log = []
      let outcome = originalCapture?.receipt.processes.find(value => value.phase === phase)
      if (!originalCapture) try {
        outcome = await runProbeProcess(electron, [join(fixture, 'main.cjs'), join(outDir, 'index.html'), join(fixture, 'preload.cjs'),
          normalizedPath, privateRoot, evidence, phase], { cwd: repository, env, timeoutMs: 120_000, onLine: line => log.push(line) })
      } catch (error) {
        result.processes.push({ phase, ...(error.probe ?? { exitConfirmed: false }) })
        throw error
      } finally { await writeFile(join(evidence, phase + '-process.log'), log.join('\n')) }
      result.processes.push({ phase, ...outcome })
      const phaseFile = join(captureEvidence, phase + '-render.json')
      await artifact(phaseFile)
      const render = JSON.parse(await readFile(phaseFile, 'utf8'))
      assert.equal(render.schema, 'agentmux.goal-responsibility-visual-render.v1'); assert.equal(render.phase, phase)
      assert.equal(outcome.exitConfirmed, true); assert.equal(outcome.timedOut, false)
      assert.ok(Number.isSafeInteger(outcome.originalPid) && outcome.originalPid > 0)
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
        assert.equal(observation.windows.length, 1)
      }
      for (const frame of render.frames) {
        const file = resolve(captureEvidence, frame.file)
        assert.ok(relative(captureEvidence, file).length > 0 && !relative(captureEvidence, file).startsWith('..'))
        const bytes = await readFile(file)
        assert.ok(bytes.length > 4096 && frame.distinctSampleColors > 24)
        assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a')
        assert.equal(bytes.readUInt32BE(16), frame.width); assert.equal(bytes.readUInt32BE(20), frame.height)
        assert.equal(await artifact(file), frame.sha256)
      }
      result.frames.push(...render.frames)
    }
    assert.notEqual(result.processes[0].originalPid, result.processes[1].originalPid, 'Relaunch requires another real Electron process.')
    assert.equal(result.frames.length >= 27, true, 'Both original capture and a real process relaunch must have nonempty frames.')
    if (originalCapture) {
      assert.deepEqual(result.frames, originalCapture.receipt.frames); assert.deepEqual(result.processes, originalCapture.receipt.processes)
      result.privateProfileRemoved = originalCapture.receipt.privateProfileRemoved; result.remainingProcesses = originalCapture.receipt.remainingProcesses
    }
    await verifySources()
    for (const [file, expected] of evidenceInputs) assert.equal(hash(await readFile(file)), expected,
      'A qualified Native/cost source or build changed during the combined journey: ' + file)
    for (const qualification of Object.values(result.qualifications ?? {})) for (const [file, expected] of Object.entries(qualification.artifactHashes))
      assert.equal(hash(await readFile(file)), expected, 'Original qualification evidence changed during capture: ' + file)
    assert.equal(hash(await readFile(inputPath)), result.input.sha256, 'The original public journey input changed during capture.')
    assert.equal(hash(await readFile(result.input.originalReceipt.path)), result.input.originalReceipt.sha256,
      'The original public journey receipt changed during capture.')
    assert.deepEqual(await compiledFiles(outDir), result.compiled, 'Captured compiled product bytes changed.')
    assert.deepEqual(await candidate(), result.candidate, 'The exact candidate changed during capture.')
    result.passed = true
    if (!originalCapture) await writeFile(join(evidence, 'review.md'), [
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
  if (privateRoot) try {
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
  await writeFile(join(evidence, 'receipt.json'), JSON.stringify(result, null, 2), { flag: 'wx' })
}
console.log(JSON.stringify({ prepared: result.prepared, passed: result.passed, qualification: result.qualification,
  receipt: join(evidence, 'receipt.json'), review: result.passed ? join(captureEvidence, 'review.md') : null, failure: result.failure, cleanupFailure: result.cleanupFailure }))
if (!result.passed && !(options.prepareOnly && result.prepared && !result.cleanupFailure)) process.exitCode = 1
