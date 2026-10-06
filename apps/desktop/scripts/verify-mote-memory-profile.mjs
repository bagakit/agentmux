import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { cp, mkdir, mkdtemp, readFile, readdir, rm, statfs, symlink, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'

// Mutations and the extra Dock consumer run only in a private Source copy.
// The Native transport in the context tests is controlled; this is not a model test.
const repository = resolve(import.meta.dirname, '../../..')
const args = process.argv.slice(2)
assert.ok(args.length === 0 || args.length === 1 && args[0] === '--functional-only', 'Use only --functional-only, or no arguments for the complete gate.')
const functionalOnly = args.length === 1
const output = join(repository, '.local/state/mote-memory-profile/memory-proof')
await mkdir(output, { recursive: true })
const evidence = await mkdtemp(join(output, 'attempt-'))
const isolated = join(evidence, 'source'), owner = 'apps/desktop/src/renderer/src/components/MoteMemory.tsx'
const memoryTest = 'apps/desktop/test/mote-memory-profile.test.tsx', contextTest = 'apps/desktop/test/mote-context-files.test.ts'
const memoryCases = 13, contextCases = 20
const config = 'memory-gate.config.mts', sha = bytes => createHash('sha256').update(bytes).digest('hex')
const packages = ['core', 'demand', 'git', 'identity', 'layout', 'client-ui', 'relay', 'diagnostic-evidence']
const receipt = { schema: 'agentmux.mote-memory-profile-gate.v1', passed: false, functionalOnly,
  functional: null, visual: null, failure: null, cleanup: null,
  boundary: 'Original Profile/Editor and shipping Files CLI/CAS -> ScratchTopics/RuntimeController/real Core context path with controlled Host/native I/O; private Source mutation and actual shared Dock consumer. Separate independent operated Renderer review. No live model use, user App/Run, package/install or whole-8P claim.' }
const functional = { schema: 'agentmux.mote-memory-functional.v1', passed: false,
  runtime: { node: process.version, platform: process.platform, arch: process.arch }, source: {},
  isolatedInputs: {}, runs: [], callers: [], mutations: [], cleanup: null }

async function files(directory) {
  const entries = await readdir(join(repository, directory), { withFileTypes: true })
  return (await Promise.all(entries.map(entry => entry.isDirectory() ? files(join(directory, entry.name)) : [join(directory, entry.name)]))).flat()
}
async function locator(file) {
  const bytes = await readFile(file)
  return { path: relative(repository, file), sha256: sha(bytes) }
}
async function readPinned(ref) {
  assert.ok(ref && typeof ref.path === 'string' && /^[a-f0-9]{64}$/.test(ref.sha256), 'An evidence locator needs its original path and SHA256.')
  const bytes = await readFile(resolve(repository, ref.path))
  assert.equal(sha(bytes), ref.sha256, 'Evidence changed: ' + ref.path)
  return JSON.parse(bytes)
}
async function run(label, tests, expected, testName) {
  const report = join(evidence, label + '.json'), log = join(evidence, label + '.log')
  const command = [join(repository, 'node_modules/vitest/vitest.mjs'), 'run', '--config', config,
    ...tests, '--maxWorkers=1', '--reporter=json', '--outputFile=' + report, ...(testName ? ['-t', testName] : [])]
  const child = spawn(process.execPath, command, { cwd: isolated, env: { ...process.env, AGENTMUX_MOTE_CONTEXT_ADJACENT: '' }, stdio: ['ignore', 'pipe', 'pipe'] })
  let text = ''; child.stdout.on('data', bytes => { text += bytes }); child.stderr.on('data', bytes => { text += bytes })
  const status = await new Promise((accept, reject) => { child.once('error', reject); child.once('close', (code, signal) => accept({ code, signal })) })
  await writeFile(log, text)
  const result = JSON.parse(await readFile(report, 'utf8'))
  const entry = { label, command: [process.execPath, ...command], ...status, tests: result.numTotalTests,
    passed: result.numPassedTests, failed: result.numFailedTests, pending: result.numPendingTests,
    report: await locator(report), log: await locator(log) }
  functional.runs.push(entry)
  assert.equal(status.signal, null, 'Process termination is not behavioral evidence: ' + label)
  assert.equal(entry.tests, expected, 'All nonempty intended cases must be collected: ' + label)
  return { entry, result }
}
function green(value, executed = value.entry.tests) {
  const failures = value.result.testResults.flatMap(suite => [suite.message,
    ...suite.assertionResults.filter(test => test.status === 'failed').flatMap(test => test.failureMessages)]).filter(Boolean)
  assert.equal(value.entry.code, 0, failures.join('\n').slice(0, 2400))
  assert.equal(value.result.success, true); assert.equal(value.entry.failed, 0)
  assert.equal(value.entry.passed, executed, 'The selected consumer must actually run.')
}
function red(value, name) {
  assert.notEqual(value.entry.code, 0, 'The behavior mutant stayed green: ' + name)
  const suites = value.result.testResults
  const failed = suites.flatMap(suite => suite.assertionResults.filter(test => test.status === 'failed'))
  assert.ok(failed.some(test => test.fullName.includes(name)), 'The exact owning assertion did not reject the mutant: ' + name)
  assert.match(failed.flatMap(test => test.failureMessages).join('\n'), /AssertionError:/, 'RED requires behavioral assertions.')
  assert.doesNotMatch(JSON.stringify(suites), /Cannot find module|Failed to resolve import|No test files found|Transform failed|SyntaxError:|ReferenceError:/, 'Setup or compilation failure is not RED.')
  assert.equal(value.entry.passed + value.entry.failed, value.entry.tests, 'A mutant cannot hide skipped owning cases.')
}

try {
  const capacity = await statfs(repository)
  receipt.availableBytes = Number(capacity.bavail) * Number(capacity.bsize)
  const trees = ['apps/desktop/src', 'apps/desktop/test/fixtures', 'apps/desktop/test/helpers', ...packages.map(name => 'packages/' + name + '/src')]
  const selected = ['package.json', 'pnpm-lock.yaml', 'tsconfig.base.json', 'vitest.config.ts', 'vitest.setup.ts', 'test/fixture-values.mjs',
    'apps/desktop/package.json', 'apps/desktop/tsconfig.json', memoryTest, contextTest, 'apps/desktop/test/vitest.mote-context.config.mts',
    'apps/desktop/scripts/lib/fixture-values.mjs', relative(repository, import.meta.filename),
    ...packages.flatMap(name => ['package.json', 'tsconfig.json'].map(file => 'packages/' + name + '/' + file))]
  const inputs = [...new Set([...selected, ...(await Promise.all(trees.map(files))).flat()])].sort()
  let inputBytes = 0
  for (const path of inputs) { const bytes = await readFile(join(repository, path)); functional.source[path] = sha(bytes); inputBytes += bytes.length }
  assert.ok(receipt.availableBytes > inputBytes * 2, 'Insufficient space for this private Source copy and bounded outputs; no product capacity limit is implied.')
  const fingerprint = sha(JSON.stringify({ source: functional.source, runtime: functional.runtime }))
  receipt.functionalFingerprint = fingerprint
  let reused = false
  try {
    const latest = JSON.parse(await readFile(join(output, 'functional-latest.json'), 'utf8'))
    if (latest.fingerprint === fingerprint) {
      const saved = await readPinned(latest.receipt)
      assert.equal(saved.schema, functional.schema); assert.equal(saved.passed, true)
      assert.deepEqual(saved.source, functional.source); assert.deepEqual(saved.runtime, functional.runtime)
      assert.equal(saved.mutations.length, 3); assert.equal(saved.runs.length, 6)
      for (const run of saved.runs) { await readPinned(run.report); assert.equal(sha(await readFile(resolve(repository, run.log.path))), run.log.sha256) }
      receipt.functional = { ...latest.receipt, reused: true }; reused = true
    }
  } catch (error) {
    if (error.code !== 'ENOENT') receipt.functionalReuseRejected = error.message
  }
  if (!reused) {
    for (const tree of trees) await cp(join(repository, tree), join(isolated, tree), { recursive: true })
    for (const file of selected) { await mkdir(dirname(join(isolated, file)), { recursive: true }); await cp(join(repository, file), join(isolated, file)) }
    receipt.candidateBytes = 0
    for (const path of inputs) {
      const bytes = await readFile(join(isolated, path)); functional.isolatedInputs[path] = sha(bytes)
      receipt.candidateBytes += bytes.length
      assert.equal(functional.isolatedInputs[path], functional.source[path], 'Private copy differs: ' + path)
    }
    for (const path of ['node_modules', 'apps/desktop/node_modules', 'apps/desktop/resources', ...packages.map(name => 'packages/' + name + '/node_modules')]) {
      await mkdir(dirname(join(isolated, path)), { recursive: true }); await symlink(join(repository, path), join(isolated, path), 'dir')
    }
    // The current Core deliberately forks this shipping listener asset. Build
    // that one exact Source file here, rather than importing shared/stale dist.
    const { build } = createRequire(join(repository, 'packages/core/package.json'))('esbuild')
    const workerSource = 'packages/core/src/control-endpoint-listener-worker.ts'
    const workerOutput = 'packages/core/dist/control-endpoint-listener-worker.js'
    await build({ entryPoints: [join(isolated, workerSource)], outfile: join(isolated, workerOutput),
      platform: 'node', format: 'esm', bundle: true, packages: 'external', logLevel: 'error' })
    functional.privateWorkerBuild = { source: workerSource, sourceSha256: functional.source[workerSource],
      output: workerOutput, outputSha256: sha(await readFile(join(isolated, workerOutput))), privateOnly: true }
    await writeFile(join(isolated, config), "import { defineConfig } from 'vitest/config'\nimport base from './apps/desktop/test/vitest.mote-context.config.mts'\nexport default defineConfig({...base,test:{...base.test,include:['apps/desktop/test/mote-memory-profile.test.tsx','apps/desktop/test/mote-context-files.test.ts','apps/desktop/test/mote-memory-dock-consumer.test.tsx'],passWithNoTests:false}})\n")
    const callerChecks = [
      ['apps/desktop/src/renderer/src/components/MoteDetailsPanel.tsx', '<MoteMemory scope={scope} active={active && section === \'profile\'} onOpenPath={onOpenPath} />'],
      ['apps/desktop/src/renderer/src/components/MoteProfilePopover.tsx', '<MoteDetailsPanel key={owner.topicId}'],
      ['apps/desktop/src/renderer/src/components/MoteFilesTool.tsx', '<MoteDetailsPanel key={scope.topic.id}'],
      ['apps/desktop/src/renderer/src/components/WorkspaceFilesTool.tsx', '<MoteFilesTool {...props} scope={mote} />'],
      ['apps/desktop/src/renderer/src/components/SurfaceToolDock.tsx', '<WorkspaceFilesTool workspace={workspace} isScratch={isScratch} visible={visible} />'],
      [owner, 'void readMoteMaterial(scope, path).then(observation => {'],
      ['apps/desktop/src/renderer/src/lib/mote-cooperation.ts', 'return api.files.readPublic(params).then(result => parseFileReadResult(result, params))'],
      ['apps/desktop/src/main/scratch-topics.ts', 'await initialFileContext(absolutePath, MOTE_MEMORY_PATH)'],
      ['apps/desktop/src/main/runtime-controller.ts', 'preparedTopic = await this.scratchTopics.prepareAgent(scratch, request.scratchTopicId, {'],
      ['apps/desktop/src/main/runtime-controller.ts', 'await client.createAgentWithDelivery({']
    ]
    for (const [path, anchor] of callerChecks) {
      const source = await readFile(join(isolated, path), 'utf8'), line = source.split('\n').findIndex(value => value.includes(anchor))
      assert.ok(line >= 0, 'Original product caller is absent: ' + path + ' ' + anchor)
      functional.callers.push({ path, line: line + 1, anchor })
    }
    green(await run('baseline', [memoryTest, contextTest], memoryCases + contextCases))
    // Reuse the owning setup to execute the second actual public presentation
    // consumer, rather than calling a symbol export a closed product chain.
    const originalTests = await readFile(join(isolated, memoryTest), 'utf8')
    const dockTest = 'apps/desktop/test/mote-memory-dock-consumer.test.tsx'
    const dockSource = "import { SurfaceToolDock } from '../src/renderer/src/components/SurfaceToolDock'\n" + originalTests + `
it('executes the original SurfaceToolDock to saved Memory consumer', async () => {
  useAppStore.setState({ workspaceTool: 'files-branches', workbenchSpaceSelection: null });
  await act(async () => root.render(<SurfaceToolDock workspace={scratchWorkspace} visible />));
  expect(container.querySelector('[aria-label="Space tools"]')).not.toBeNull();
  expect(container.querySelector('[data-mote-details]')?.getAttribute('data-mote-details')).toBe(PMO_TEAMS_TOPIC_ID);
  expect(memoryReads()).toHaveLength(0); await expand();
  expect(memory().textContent).toContain('Give me the conclusion first.');
  expect(memoryReads()).toHaveLength(1);
});\n`
    await writeFile(join(isolated, dockTest), dockSource)
    functional.dockConsumer = { sourceSha256: sha(dockSource), generatedOnlyInPrivateCopy: true }
    green(await run('original-dock-consumer', [dockTest], memoryCases + 1, 'executes the original SurfaceToolDock'), 1)
    const original = await readFile(join(isolated, owner), 'utf8')
    const mutations = [
      { id: 'hidden-read-admission', from: 'const enabled = active && expanded', to: 'const enabled = expanded', assertion: 'stops new reads and Markdown while hidden' },
      { id: 'same-resource-late-read', from: 'current.current === request && request.valid && resourceCurrent()', to: 'current.current === request && resourceCurrent()', assertion: 'does not adopt a pending result after the exact Workspace resource moves away and back' },
      { id: 'failure-loses-confirmed-content', from: 'setLoading(true); setIssue(null)', to: 'setLoading(true); setIssue(null); setSaved(null)', assertion: 'keeps full last confirmed saved text and its version through unknown' }
    ]
    for (const mutation of mutations) {
      assert.equal(original.split(mutation.from).length, 2, 'Mutation needs one exact production anchor: ' + mutation.id)
      const changed = original.replace(mutation.from, mutation.to)
      try {
        await writeFile(join(isolated, owner), changed)
        const result = await run(mutation.id, [memoryTest], memoryCases); red(result, mutation.assertion)
        functional.mutations.push({ owner, id: mutation.id, from: mutation.from, to: mutation.to,
          originalSha256: sha(original), mutatedSha256: sha(changed), assertion: mutation.assertion, red: result.entry })
      } finally { await writeFile(join(isolated, owner), original) }
    }
    green(await run('restored', [memoryTest, contextTest], memoryCases + contextCases))
    functional.sourceChanges = []
    for (const [path, expected] of Object.entries(functional.source)) if (sha(await readFile(join(repository, path))) !== expected) functional.sourceChanges.push(path)
    assert.deepEqual(functional.sourceChanges, [], 'Candidate changed during functional verification; rerun the changed inputs.')
    await rm(isolated, { recursive: true, force: true })
    functional.cleanup = { isolatedSourceRemoved: true, productSourceMutated: false, userAppOrRunTouched: false }
    functional.passed = true
    const file = join(evidence, 'functional.json'); await writeFile(file, JSON.stringify(functional, null, 2) + '\n')
    receipt.functional = { ...await locator(file), reused: false }
    await writeFile(join(output, 'functional-latest.json'), JSON.stringify({ fingerprint, receipt: await locator(file) }, null, 2) + '\n')
  }
  if (!functionalOnly) {
    const approvalPath = join(repository, '.local/state/mote-memory-profile/visual-approved.json')
    const approval = JSON.parse(await readFile(approvalPath, 'utf8'))
    assert.equal(approval.status, 'approved', 'Independent visual approval is required.')
    assert.equal(approval.captureOnly, false, 'Capture-only evidence cannot qualify the complete gate.')
    assert.ok(typeof approval.reviewer === 'string' && approval.reviewer.trim(), 'Name the independent reviewer.')
    assert.equal(approval.reviewerAuthoredUI, false, 'The UI implementer cannot substitute for independent visual review.')
    assert.deepEqual(approval.mustFix, [], 'Outstanding visual corrections cannot qualify delivery.')
    const capture = await readPinned(approval.capture)
    assert.equal(capture.passed, true); assert.equal(capture.renderer?.passed, true)
    assert.equal(capture.process?.exitCode, 0); assert.equal(capture.process?.timedOut, false)
    assert.ok(capture.renderer.operations.length > 0 && Object.keys(capture.source).length > 0)
    for (const path of [owner, 'apps/desktop/src/renderer/src/components/MoteDetailsPanel.tsx', 'apps/desktop/src/renderer/src/styles/mote-workface.css',
      'apps/desktop/src/renderer/src/components/FileSurfaceView.tsx', 'apps/desktop/src/renderer/src/components/MoteFirstCooperation.tsx',
      'apps/desktop/scripts/fixtures/mote-memory-profile/entry.tsx', 'apps/desktop/scripts/fixtures/mote-memory-profile/capture.mjs',
      'apps/desktop/scripts/fixtures/mote-memory-profile/renderer-main.cjs']) assert.ok(capture.source[path], 'Missing actual Renderer compilation input: ' + path)
    // Every actual metafile/worker input is checked, not only the new component.
    for (const [path, expected] of Object.entries(capture.source)) assert.equal(sha(await readFile(resolve(repository, path))), expected, 'Capture compiled different current Source: ' + path)
    assert.ok(/^[a-f0-9]{64}$/.test(capture.compiled?.['entry.js']) && /^[a-f0-9]{64}$/.test(capture.compiled?.['entry.css']), 'Capture must bind its actual compiled Renderer outputs.')
    const images = Object.keys(capture.images).sort()
    assert.ok(images.length > 0); assert.deepEqual(approval.imagesSeen?.slice().sort(), images, 'The reviewer must actually view every submitted complete image.')
    assert.deepEqual(approval.images, capture.images, 'Review must bind the exact original PNG bytes.')
    const captureDirectory = dirname(resolve(repository, approval.capture.path))
    assert.deepEqual(capture.renderer.images.map(path => relative(repository, join(captureDirectory, path))).sort(), images, 'Each PNG must belong to the actual operated Renderer receipt.')
    for (const [path, expected] of Object.entries(capture.images)) assert.equal(sha(await readFile(resolve(repository, path))), expected, 'Reviewed image changed: ' + path)
    for (const scene of ['profile-collapsed-wide-dark', 'memory-open-wide-dark', 'memory-unknown-retained-wide-dark',
      'memory-original-editor-unsaved-wide-dark', 'memory-original-editor-saved-wide-dark', 'memory-corrected-profile-wide-dark',
      'memory-source-version-wide-dark', 'memory-corrected-narrow-light', 'memory-long-narrow-light', 'memory-unknown-retained-narrow-light', 'memory-missing-narrow-light'])
      assert.ok(images.some(path => path.endsWith('/' + scene + '.png')), 'Required operated complete scene missing: ' + scene)
    receipt.visual = { approval: await locator(approvalPath), capture: approval.capture, reviewer: approval.reviewer, images: capture.images,
      compiledOutputs: capture.compiled, boundary: capture.boundary }
  }
  const currentInputs = [...new Set([...selected, ...(await Promise.all(trees.map(files))).flat()])].sort()
  assert.deepEqual(currentInputs, inputs, 'Source inventory changed during verification; new inputs need a new receipt.')
  for (const [path, expected] of Object.entries(functional.source))
    assert.equal(sha(await readFile(join(repository, path))), expected, 'Candidate changed before gate completion: ' + path)
  receipt.passed = true
} catch (error) { receipt.failure = { name: error.name, message: error.message, stack: error.stack } }
finally {
  await rm(isolated, { recursive: true, force: true })
  if (!receipt.functional && functional.runs.length) {
    functional.cleanup = { isolatedSourceRemoved: true, productSourceMutated: false, userAppOrRunTouched: false }
    const file = join(evidence, 'functional-failed.json'); await writeFile(file, JSON.stringify(functional, null, 2) + '\n')
    receipt.functional = { ...await locator(file), reused: false, qualified: false }
  }
  receipt.cleanup = { isolatedSourceRemoved: true, productSourceMutated: false, userAppOrRunTouched: false }
  const file = join(evidence, 'receipt.json'); await writeFile(file, JSON.stringify(receipt, null, 2) + '\n')
  console.log(JSON.stringify({ passed: receipt.passed, functionalOnly, receipt: relative(repository, file), functional: receipt.functional, failure: receipt.failure?.message }))
  if (!receipt.passed) process.exitCode = 1
}
