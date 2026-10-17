import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { captureReadingDensity } from './fixtures/conversation-reading-density/capture.mjs'

const root = resolve(import.meta.dirname, '../../..'), area = join(root, '.local/conversation-duplication')
const config = 'apps/desktop/scripts/fixtures/conversation-reading-density/vitest.owning.config.mts'
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const read = async file => JSON.parse(await readFile(file, 'utf8'))
const own = 'apps/desktop/scripts/verify-conversation-reading-density.mjs'
const command = promisify(execFile)
async function consumeQualifiedCandidate(candidateRoot) {
  const candidate = resolve(candidateRoot)
  assert.notEqual(candidate, root, 'The explicit candidate must name its own checkout')
  const git = async (cwd, ...args) => (await command('git', args, { cwd, maxBuffer: 8 * 1024 * 1024 })).stdout.trim()
  const allowedTooling = new Set([own, 'apps/desktop/scripts/fixtures/conversation-reading-density/main.cjs'])
  const dirty = new Set(((await git(candidate, 'diff', '--name-only', 'HEAD')) + '\n' + (await git(candidate, 'diff', '--cached', '--name-only'))).split('\n').filter(Boolean))
  assert.equal(await git(candidate, 'diff', '--name-only', '--diff-filter=U'), '', 'An unresolved merge is not a qualified candidate')
  for (const file of dirty) assert.ok(allowedTooling.has(file), 'Only the two reviewed main tooling overlays are allowed: ' + file)
  const delivery = await read(join(area, 'delivery-main.json'))
  assert.equal(typeof delivery.head, 'string', 'The accepted delivery main snapshot is explicit')
  const mainHead = await git(root, 'rev-parse', delivery.head), observedMainHead = await git(root, 'rev-parse', 'refs/heads/main'), candidateHead = await git(candidate, 'rev-parse', 'HEAD')
  await git(root, 'merge-base', '--is-ancestor', mainHead, observedMainHead)
  await git(root, 'merge-base', '--is-ancestor', candidateHead, mainHead)
  const pointer = await read(join(candidate, '.local/conversation-duplication/reading-current.json'))
  const candidateDirectory = resolve(candidate, pointer.directory)
  assert.ok(candidateDirectory.startsWith(join(candidate, '.local/conversation-duplication/reading-')), 'The source receipt belongs to the original candidate')
  const receiptFile = join(candidateDirectory, 'receipt.json'), receipt = await read(receiptFile)
  assert.equal(hash(await readFile(receiptFile)), pointer.receiptSha256)
  assert.equal(receipt.schema, 'agentmux.conversation-reading-density.v1'); assert.equal(receipt.passed, true)
  for (const file of [own, config, 'packages/client-ui/src/components/ConversationView.tsx', 'apps/desktop/src/renderer/src/components/ActivityView.tsx', 'apps/mobile/src/conversation/MobileConversationSurface.tsx']) assert.ok(receipt.sources[file], 'The original task owner and product consumers must be qualified: ' + file)
  const tree = async (cwd, head) => new Map((await git(cwd, 'ls-tree', '-rz', '--full-tree', head)).split('\0').filter(Boolean).map(entry => {
    const tab = entry.indexOf('\t'); return [entry.slice(tab + 1), entry.slice(0, tab).split(' ')[2]]
  }))
  const candidateTree = await tree(candidate, candidateHead), mainTree = await tree(root, mainHead), observedMainTree = await tree(root, observedMainHead)
  const toolingOverlaySha = []
  const effectiveTree = new Map(candidateTree)
  for (const file of dirty) {
    const blob = await git(candidate, 'hash-object', '--', file)
    assert.equal(blob, observedMainTree.get(file), 'A tooling overlay must exactly match its committed main blob: ' + file)
    effectiveTree.set(file, blob)
    toolingOverlaySha.push({ path: file, blob, sha256: hash(await readFile(join(candidate, file))) })
  }
  const featureOwners = [own, config,
    'packages/core/src/providers/codex-saved-history.ts', 'packages/core/src/session-history.ts', 'packages/core/src/types.ts', 'packages/core/src/conversation-timeline.ts',
    'packages/core/test/codex-native-collaboration.test.ts', 'packages/core/test/vitest.native-collaboration.config.mts',
    'packages/client-ui/src/components/ConversationView.tsx', 'packages/client-ui/src/components/ConversationMessage.tsx',
    'packages/client-ui/src/components/CapturedConversationMessage.tsx', 'packages/client-ui/src/components/NativeProcessObservation.tsx',
    'packages/client-ui/src/components/WorkflowObservation.tsx', 'packages/client-ui/src/lib/conversation-reply-preview.ts', 'packages/client-ui/src/styles/conversation-message.css',
    'apps/desktop/src/renderer/src/components/ActivityView.tsx', 'apps/mobile/src/conversation/MobileConversationSurface.tsx',
    'apps/desktop/test/conversation-reading-density.test.tsx', 'apps/desktop/test/conversation-reading-activity-density.test.tsx',
    'apps/desktop/test/conversation-source-roles.test.tsx', 'apps/desktop/test/conversation-process-collapse.test.tsx', 'apps/desktop/test/conversation-chronological-reading.test.tsx',
    ...[...candidateTree.keys()].filter(file => file.startsWith('apps/desktop/scripts/fixtures/conversation-reading-density/'))]
  const ownerPaths = new Set(featureOwners)
  for (const file of ownerPaths) {
    assert.ok(candidateTree.has(file), 'The accepted contribution must exist in the qualified candidate: ' + file)
    assert.equal(effectiveTree.get(file), (allowedTooling.has(file) ? observedMainTree : mainTree).get(file), 'An accepted contribution differs from its explicit delivery/tooling main snapshot: ' + file)
  }
  let trackedInputs = 0
  const laterMainDrift = []
  for (const file of Object.keys(receipt.sources)) {
    if (!candidateTree.has(file)) continue // Generated dist remains bound by the original candidate's source hashes.
    trackedInputs++
    if (effectiveTree.get(file) !== observedMainTree.get(file)) laterMainDrift.push({ path: file, candidateBlob: effectiveTree.get(file), mainBlob: observedMainTree.get(file) ?? null })
  }
  assert.ok(trackedInputs > 0, 'Nonempty exact main/candidate source comparison')
  const action = process.argv.includes('--verify') ? '--verify' : '--check-prepared'
  assert.ok(process.argv.includes('--prepare') || process.argv.includes('--check-prepared') || process.argv.includes('--verify'), 'Explicit candidate routing consumes prepared proof only')
  const env = { ...process.env }; delete env.AGENTMUX_READING_DENSITY_CANDIDATE_ROOT
  const result = await command(process.execPath, [join(candidate, own), action], { cwd: candidate, env, maxBuffer: 8 * 1024 * 1024 })
  process.stdout.write(result.stdout)
  console.log(JSON.stringify({ consumedOriginalCandidate: true, deliveryMainHead: mainHead, observedMainHead, candidateHead, candidateRoot: candidate, trackedInputs,
    baseHead: candidateHead, toolingOverlaySha, ownerInputs: ownerPaths.size, laterMainDrift, action,
    boundary: 'Qualifies this contribution at the explicit delivery main ancestor with only the listed reviewed main tooling overlays. Product/test owners and actual consumers match that delivery snapshot; later observed main changes are listed, not claimed tested. All candidate source/build/artifact identities stay exact. No workspace adoption, expensive rerun, Tracker mutation or claim about root worktree edits.' }))
}
const configText = await readFile(join(root, config), 'utf8')
const mutations = [...configText.matchAll(/^\s*'([^']+)': \[/gmu)].map(match => match[1])
assert.ok(mutations.length > 0 && new Set(mutations).size === mutations.length, 'Nonempty unique mutations from the actual owning config')
const hookUrlPath = 'packages/core/bin/agentmux-hook.js'
const hookUrlExport = 'export default "/packages/core/bin/agentmux-hook.js"'
const hookUrlHash = hash(hookUrlExport)
const isHookUrl = input => input.path === hookUrlPath && !input.mutation && input.originalSHA256 === hookUrlHash && input.sha256 === hookUrlHash
const sourceInputs = inputs => Object.fromEntries(inputs.filter(input => !isHookUrl(input)).map(input => [input.path, input.originalSHA256]))
const sourceHash = (sources, virtualInputs = []) => hash(JSON.stringify({ sources: Object.fromEntries(Object.entries(sources).sort(([a], [b]) => a.localeCompare(b))), virtualInputs }))
function mergeSources(target, inputs) {
  for (const [file, sha] of Object.entries(inputs)) {
    if (target[file]) assert.equal(target[file], sha, 'Candidate source changed between proofs: ' + file)
    target[file] = sha
  }
}
async function execute(command, args, log, env = {}) {
  const result = await new Promise((yes, no) => {
    const child = spawn(command, args, { cwd: root, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''; child.stdout.on('data', chunk => { output += chunk }); child.stderr.on('data', chunk => { output += chunk })
    child.on('error', no); child.on('close', (code, signal) => yes({ code, signal, output }))
  })
  await writeFile(log, result.output)
  return { exit: result.code, signal: result.signal, argv: [command, ...args], log: relative(root, log) }
}
async function tests(directory, name, mutation, adjacent = false) {
  const report = join(directory, name + '.json'), loaded = join(directory, name + '.loaded.jsonl')
  const execution = await execute(process.execPath, [join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config', config,
    '--maxWorkers=1', '--reporter=json', '--outputFile=' + report], join(directory, name + '.log'),
  { AGENTMUX_READING_DENSITY_ADJACENT: adjacent ? '1' : '', AGENTMUX_READING_DENSITY_MUTATION: mutation ?? '', AGENTMUX_READING_DENSITY_LOADED: loaded })
  assert.equal(execution.signal, null, 'A terminated process is not semantic proof')
  const value = await read(report), cases = value.testResults.flatMap(item => item.assertionResults)
  assert.ok(cases.length > 0 && value.numTotalTests === cases.length, 'Nonempty exact test collection')
  const inputs = (await readFile(loaded, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  assert.ok(inputs.length > 0, 'Actual loaded candidate inputs')
  for (const input of inputs) assert.ok(!input.path.startsWith('.worktrees/'), 'The actual candidate is used')
  return { ...execution, report: relative(root, report), loaded: relative(root, loaded), cases: cases.map(item => ({ name: item.fullName, status: item.status })),
    assertionFailures: cases.filter(item => item.status === 'failed' && item.failureMessages.some(message => message.includes('AssertionError'))).length, inputs }
}
async function typeProof(types) {
  assert.equal(types.exit, 0); assert.equal(types.signal, null)
  assert.ok(types.inputs?.length > 0, 'Actual candidate type inputs must be recorded')
  for (const input of types.inputs) assert.equal(hash(await readFile(join(root, input.path))), input.sha256, 'A checked type input changed: ' + input.path)
  await readFile(join(root, types.log))
}
async function typecheck(directory) {
  const paths = {}, manifests = []
  for (const name of ['core', 'client-ui', 'demand', 'diagnostic-evidence', 'relay', 'identity', 'git']) {
    const file = join(root, 'packages', name, 'package.json'), manifest = await read(file)
    manifests.push(file)
    for (const [key, entry] of Object.entries(manifest.exports)) {
      const target = typeof entry === 'string' ? entry : entry.types
      assert.equal(typeof target, 'string', 'Exact candidate type export: ' + manifest.name + key)
      paths[key === '.' ? manifest.name : manifest.name + key.slice(1)] = [join(root, 'packages', name, target)]
    }
  }
  const original = join(root, 'packages/client-ui/tsconfig.json'), configFile = join(directory, 'types.tsconfig.json')
  await writeFile(configFile, JSON.stringify({ extends: original, compilerOptions: { baseUrl: root, paths } }) + '\n')
  const result = await execute(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '--noEmit', '--pretty', 'false', '--listFiles', '-p', configFile], join(directory, 'types.log'))
  assert.equal(result.signal, null); assert.equal(result.exit, 0, 'Exact candidate shared types: ' + result.log)
  const files = (await readFile(join(root, result.log), 'utf8')).split('\n').filter(file => /\.[cm]?tsx?$/u.test(file.trim())).map(file => file.trim())
  assert.ok(files.length > 0, 'TypeScript reports its actual input files')
  const inputs = new Set([original, configFile, ...manifests])
  for (const file of files) {
    if (file.includes('/node_modules/')) continue
    assert.ok(file.startsWith(root + sep), 'First-party type input lies outside the candidate: ' + file)
    inputs.add(file)
  }
  return { ...result, inputs: await Promise.all([...inputs].map(async file => ({ path: relative(root, file), sha256: hash(await readFile(file)) }))) }
}
async function testProof(receipt, includeTypes = true) {
  assert.ok(receipt.baseline && receipt.adjacent && receipt.restored, 'Every original test stage must have completed')
  assert.deepEqual(receipt.mutants.map(mutant => mutant.name), mutations, 'Every current implementation mutation was proved')
  const runs = [receipt.baseline, ...receipt.mutants, receipt.adjacent, receipt.restored]
  const virtualInputs = []
  for (const run of runs) {
    const report = await read(join(root, run.report)), cases = report.testResults.flatMap(item => item.assertionResults)
    assert.ok(cases.length > 0 && report.numTotalTests === cases.length)
    assert.deepEqual(cases.map(item => ({ name: item.fullName, status: item.status })), run.cases)
    const inputs = (await readFile(join(root, run.loaded), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    assert.ok(inputs.length > 0); assert.deepEqual(inputs, run.inputs)
    for (const input of inputs) {
      if (isHookUrl(input)) {
        assert.equal(run, receipt.adjacent, 'The retained exact URL representation belongs only to the original adjacent read')
        const baseHead = (await command('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim()
        const blob = (await command('git', ['rev-parse', baseHead + ':' + hookUrlPath], { cwd: root })).stdout.trim()
        const target = await readFile(join(root, hookUrlPath))
        const original = await command('git', ['show', baseHead + ':' + hookUrlPath], { cwd: root, encoding: 'buffer' })
        assert.deepEqual(target, original.stdout, 'The original URL target must still equal the exact candidate base blob')
        virtualInputs.push({ path: hookUrlPath, representation: 'vite-url-export', representedSHA256: hookUrlHash,
          baseHead, targetBlob: blob, targetSHA256: hash(target) })
      } else assert.equal(hash(await readFile(join(root, input.path))), input.originalSHA256, 'Original tested candidate changed: ' + input.path)
    }
    assert.equal(run.signal, null)
    if (receipt.mutants.includes(run)) {
      assert.deepEqual(run.cases.map(item => item.name), receipt.baseline.cases.map(item => item.name), 'Every mutation uses the original complete collection')
      assert.ok(run.exit > 0 && run.assertionFailures > 0); assert.equal(report.success, false)
      assert.equal(cases.filter(item => item.status === 'failed' && item.failureMessages.some(message => message.includes('AssertionError'))).length, run.assertionFailures)
      const changed = inputs.filter(input => input.mutation === run.name)
      assert.equal(changed.length, 1); assert.notEqual(changed[0].sha256, changed[0].originalSHA256)
    } else { assert.equal(run.exit, 0); assert.equal(report.success, true); assert.ok(report.numPassedTests > 0 && report.numFailedTests === 0) }
  }
  assert.deepEqual(receipt.restored.cases, receipt.baseline.cases)
  if (includeTypes) await typeProof(receipt.types)
  if (receipt.virtualInputs) assert.deepEqual(virtualInputs, receipt.virtualInputs, 'Original URL representation and exact target remain bound')
  return virtualInputs
}
async function currentReceipt(requirePassed = true) {
  const pointer = await read(join(area, 'reading-current.json')), directory = resolve(root, pointer.directory)
  assert.ok(directory.startsWith(area + '/reading-'), 'The qualification belongs to this local owner')
  const file = join(directory, 'receipt.json'), receipt = await read(file)
  assert.equal(hash(await readFile(file)), pointer.receiptSha256)
  assert.equal(receipt.schema, 'agentmux.conversation-reading-density.v1')
  if (requirePassed) { assert.equal(pointer.passed, true); assert.equal(receipt.passed, true) }
  return { pointer, directory, receipt }
}
async function prepare(resumeCapture = false) {
  const directory = join(area, 'reading-' + Date.now()); await mkdir(directory, { recursive: true })
  const receipt = { schema: 'agentmux.conversation-reading-density.v1', passed: false, sources: {}, baseline: null, mutants: [], restored: null, capture: null }
  try {
    for (const file of [own, config]) receipt.sources[file] = hash(await readFile(join(root, file)))
    if (resumeCapture) {
      const original = await currentReceipt(false)
      assert.equal(original.receipt.sources[config], receipt.sources[config], 'The original owning test contract is unchanged')
      receipt.virtualInputs = await testProof(original.receipt, false)
      for (const [file, sha] of Object.entries(original.receipt.sources)) {
        if (file === own) continue
        if (file === hookUrlPath && sha === hookUrlHash) { assert.ok(receipt.virtualInputs.length === 1); continue }
        assert.equal(hash(await readFile(join(root, file))), sha, 'An original test proof input changed: ' + file)
      }
      for (const field of ['baseline', 'mutants', 'adjacent', 'restored']) receipt[field] = original.receipt[field]
      mergeSources(receipt.sources, sourceInputs([receipt.baseline, ...receipt.mutants, receipt.adjacent, receipt.restored].flatMap(run => run.inputs)))
      receipt.reusedTests = { receipt: relative(root, join(original.directory, 'receipt.json')), sha256: original.pointer.receiptSha256,
        boundary: 'Only the complete unchanged original tests and actual implementation mutations are reused. Exact candidate types and capture always run again; no earlier type or capture failure is treated as passing.' }
      console.log('Original test/config/loaded-source proof verified; exact types and capture remain unqualified.')
    } else {
    receipt.baseline = await tests(directory, 'baseline')
    assert.equal(receipt.baseline.exit, 0, 'Owning baseline: ' + receipt.baseline.log)
    mergeSources(receipt.sources, sourceInputs(receipt.baseline.inputs))
    for (const mutation of mutations) {
      const mutant = await tests(directory, mutation, mutation)
      assert.ok(mutant.exit > 0 && mutant.assertionFailures > 0, 'The actual implementation mutation must fail a behavioral assertion: ' + mutation)
      assert.deepEqual(mutant.cases.map(item => item.name), receipt.baseline.cases.map(item => item.name), 'Same baseline and mutant collection')
      const changed = mutant.inputs.filter(input => input.mutation === mutation)
      assert.equal(changed.length, 1, 'One actual transformed owning module: ' + mutation)
      assert.notEqual(changed[0].sha256, changed[0].originalSHA256)
      receipt.mutants.push({ name: mutation, ...mutant })
      console.log(mutation + ': assertion RED')
    }
    receipt.adjacent = await tests(directory, 'adjacent', undefined, true)
    assert.equal(receipt.adjacent.exit, 0, 'Owning adjacent reading checks: ' + receipt.adjacent.log)
    mergeSources(receipt.sources, sourceInputs(receipt.adjacent.inputs))
    receipt.restored = await tests(directory, 'restored')
    assert.equal(receipt.restored.exit, 0, 'Restored actual implementation')
    assert.deepEqual(receipt.restored.cases.map(item => item.name), receipt.baseline.cases.map(item => item.name))
    mergeSources(receipt.sources, sourceInputs(receipt.restored.inputs))
    receipt.virtualInputs = await testProof(receipt, false)
    }
    receipt.types = await typecheck(directory)
    mergeSources(receipt.sources, Object.fromEntries(receipt.types.inputs.map(input => [input.path, input.sha256])))
    receipt.capture = await captureReadingDensity(join(directory, 'visual'))
    mergeSources(receipt.sources, receipt.capture.sources)
    for (const [file, sha] of Object.entries(receipt.sources)) assert.equal(hash(await readFile(join(root, file))), sha, 'Source changed during qualification: ' + file)
    receipt.sourceSha256 = sourceHash(receipt.sources, receipt.virtualInputs)
    receipt.captureSha256 = hash(await readFile(join(directory, 'visual/capture.json')))
    receipt.artifacts = {}
    const runs = [receipt.baseline, ...receipt.mutants, receipt.adjacent, receipt.restored]
    const files = [...runs.flatMap(run => [run.report, run.loaded, run.log]), receipt.types.log,
      ...['capture.json', 'actual.json', 'public-reading.json'].map(file => relative(root, join(directory, 'visual', file)))]
    if (receipt.reusedTests) files.push(receipt.reusedTests.receipt)
    for (const file of files) receipt.artifacts[file] = hash(await readFile(join(root, file)))
    receipt.passed = true
  } catch (error) { receipt.failure = { message: error.message, stack: error.stack }; console.error(receipt.failure.message) }
  const receiptPath = join(directory, 'receipt.json')
  await writeFile(receiptPath, JSON.stringify(receipt, null, 2) + '\n')
  await writeFile(join(area, 'reading-current.json'), JSON.stringify({ directory: relative(root, directory), passed: receipt.passed,
    receiptSha256: hash(await readFile(receiptPath)), sourceSha256: receipt.sourceSha256 ?? null, captureSha256: receipt.captureSha256 ?? null,
    independentVisualReview: 'pending', independentCodeReview: 'pending' }, null, 2) + '\n')
  assert.equal(receipt.passed, true, receipt.failure?.message)
  console.log(JSON.stringify({ prepared: true, directory: relative(root, directory), sourceSha256: receipt.sourceSha256, captureSha256: receipt.captureSha256,
    tests: receipt.baseline.cases.length, mutants: receipt.mutants.length, images: receipt.capture.frames.length, independentReview: 'pending', boundary: receipt.capture.boundary }))
}
async function verify(preparedOnly = false) {
  const { pointer, directory, receipt } = await currentReceipt()
  assert.equal(sourceHash(receipt.sources, receipt.virtualInputs), pointer.sourceSha256)
  for (const [file, sha] of Object.entries(receipt.sources)) assert.equal(hash(await readFile(join(root, file))), sha, 'Qualified source changed: ' + file)
  assert.ok(Object.keys(receipt.artifacts).length > 0, 'Nonempty exact proof artifacts')
  for (const [file, sha] of Object.entries(receipt.artifacts)) assert.equal(hash(await readFile(join(root, file))), sha, 'Qualified proof changed: ' + file)
  await testProof(receipt)
  const captureFile = join(directory, 'visual/capture.json'), capture = await read(captureFile)
  assert.equal(hash(await readFile(captureFile)), pointer.captureSha256); assert.equal(capture.passed, true)
  assert.ok(capture.frames.length > 0)
  for (const frame of capture.frames) assert.equal(hash(await readFile(join(directory, 'visual', frame.file))), frame.sha256, 'Exact original captured image: ' + frame.file)
  if (preparedOnly) {
    console.log(JSON.stringify({ prepared: true, independentReview: 'pending', directory: pointer.directory, tests: receipt.baseline.cases.length,
      mutants: receipt.mutants.length, images: capture.frames.length, sourceSha256: pointer.sourceSha256, captureSha256: pointer.captureSha256 }))
    return
  }
  const visual = await read(join(area, 'visual-review.json'))
  assert.ok(visual.reviewer && visual.reviewer !== 'plan_review', 'Independent full-image reviewer identity')
  assert.equal(visual.passed, true); assert.equal(visual.captureSha256, pointer.captureSha256)
  assert.ok(capture.frames.length > 0); assert.equal(visual.images.length, capture.frames.length)
  for (const frame of capture.frames) {
    const sha = hash(await readFile(join(directory, 'visual', frame.file)))
    assert.equal(sha, frame.sha256); assert.ok(visual.images.some(image => image.file === frame.file && image.sha256 === sha && image.passed === true), 'Actually reviewed complete image: ' + frame.file)
  }
  const code = await read(join(area, 'code-review.json'))
  assert.ok(code.reviewer && code.reviewer !== 'plan_review', 'Independent code reviewer identity')
  assert.equal(code.passed, true); assert.equal(code.sourceSha256, pointer.sourceSha256); assert.deepEqual(code.unresolvedP0P1, [])
  console.log(JSON.stringify({ passed: true, directory: pointer.directory, tests: receipt.baseline.cases.length, mutants: receipt.mutants.length,
    images: capture.frames.length, sourceSha256: pointer.sourceSha256, captureSha256: pointer.captureSha256 }))
}
await mkdir(area, { recursive: true })
if (process.env.AGENTMUX_READING_DENSITY_CANDIDATE_ROOT) await consumeQualifiedCandidate(process.env.AGENTMUX_READING_DENSITY_CANDIDATE_ROOT)
else if (process.argv.includes('--resume-capture')) await prepare(true)
else if (process.argv.includes('--prepare')) await prepare()
else if (process.argv.includes('--check-prepared')) await verify(true)
else if (process.argv.includes('--verify')) await verify()
else throw Error('Use --prepare, --resume-capture, --check-prepared or --verify')
