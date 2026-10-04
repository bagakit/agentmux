import { fixturePath as _hygiene_fixturePath } from "./lib/fixture-values.mjs"
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync, spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve } from 'node:path'
import ts from 'typescript'

const repository = resolve(import.meta.dirname, '../../..'), args = process.argv.slice(2)
assert.ok(args.length === 0 || args.length === 1 && ['--source-only', '--native-only'].includes(args[0]), 'Use --source-only to execute the owning Source slice, then bind its independent UI review for T-004. Real model qualification belongs to T-006.')
const sourceOnly = args[0] === '--source-only', nativeOnly = args[0] === '--native-only', sha = bytes => createHash('sha256').update(bytes).digest('hex')
const output = join(repository, '.tmp/mote-daily-ideas'); await mkdir(output, { recursive: true })
const sourceBase = execFileSync('git', ['rev-parse', 'refs/heads/main'], { cwd: repository }).toString().trim()
const definition = 'apps/desktop/src/renderer/src/lib/mote-idea-request.ts'
const calendar = 'apps/desktop/src/renderer/src/components/CalendarScheduleControl.tsx'
const store = 'apps/desktop/src/renderer/src/store.ts'
const caller = 'apps/desktop/src/renderer/src/components/MoteIdeaControls.tsx'
const test = 'apps/desktop/test/mote-daily-ideas.test.tsx'
const originalTest = 'apps/desktop/test/mote-ideas.test.tsx'
const calendarTest = 'apps/desktop/test/calendar-schedule-control.test.tsx'
const config = 'apps/desktop/scripts/fixtures/mote-daily-ideas/vitest.config.mts'
const progressStyle = 'apps/desktop/src/renderer/src/styles/agent.css'
const ideaStyle = 'apps/desktop/src/renderer/src/styles/mote-idea-controls.css'
const nativeProbe = 'apps/desktop/scripts/fixtures/mote-daily-ideas/native-probe.mjs'
const nativeOwner = 'apps/desktop/scripts/fixtures/mote-daily-ideas/native-owner.ts'
const own = [definition, test, originalTest, config, nativeProbe, nativeOwner, relative(repository, import.meta.filename)]
const captureHarness = ['ideas-entry.tsx', 'ideas-main.cjs', 'capture-ideas.mjs'].map(name => 'apps/desktop/scripts/fixtures/mote-daily-ideas/' + name)
const allHarness = [...own, ...captureHarness]
const originalCaptureHarness = ['apps/desktop/scripts/fixtures/mote-companion-workflows/persona-entry.tsx',
  'apps/desktop/scripts/fixtures/mote-companion-workflows/persona-scene.css']
const overlays = [...allHarness, caller, calendar, calendarTest, progressStyle, ideaStyle]
async function candidateBytes(path) { return await readFile(join(repository, path)) }
function baseBytes(path) { return execFileSync('git', ['show', sourceBase + ':' + path], { cwd: repository, maxBuffer: 8 * 1024 * 1024 }) }
if (!sourceOnly && !nativeOnly) {
  try {
    const locator = JSON.parse(await readFile(join(output, 'approved.json'), 'utf8'))
    const pinned = async value => {
      assert.ok(value && typeof value.path === 'string' && /^[a-f0-9]{64}$/.test(value.sha256), 'Every evidence input needs an exact path and SHA')
      const bytes = await readFile(resolve(repository, value.path)); assert.equal(sha(bytes), value.sha256, 'Evidence bytes differ: ' + value.path)
      return JSON.parse(bytes)
    }
    const raw = await pinned(locator.sourceGate), ui = await pinned(locator.renderer), native = await pinned(locator.native), review = await pinned(locator.review)
    assert.equal(raw.taskId, 'T-004'); assert.equal(raw.sourceBase, sourceBase); assert.equal(raw.sourceQualified, true)
    assert.equal(review.status, 'approved'); assert.ok(review.taskIds?.includes('T-004'))
    assert.equal(review.sourceGate?.sha256, locator.sourceGate.sha256); assert.equal(review.renderer?.sha256, locator.renderer.sha256); assert.equal(review.native?.sha256, locator.native.sha256)
    assert.ok(raw.callers.length > 0 && Object.keys(raw.source).length > 0 && Object.keys(raw.harnessSource).length > 0)
    assert.ok(raw.runs.length > 1 && raw.runs.every(run => run.collected && run.tests > 0 && (run.expected === 'GREEN' ? run.code === 0 : run.assertion && run.code !== 0)))
    assert.ok(raw.types && raw.types.diagnostics.length === 0 && Object.keys(raw.types.source).length > 0)
    for (const [path, digest] of Object.entries({ ...raw.sourceContext, ...raw.source, ...raw.types.source }))
      assert.equal(sha(overlays.includes(path) ? await candidateBytes(path) : baseBytes(path)), digest, 'Qualified Source differs: ' + path)
    for (const path of allHarness) assert.equal(sha(await readFile(join(repository, path))), raw.harnessSource[path], 'Task gate differs: ' + path)
    for (const path of originalCaptureHarness) assert.equal(sha(baseBytes(path)), raw.harnessSource[path], 'Original capture context differs: ' + path)
    assert.equal(native.schema, 'agentmux.mote-daily-ideas-native.v1'); assert.equal(native.taskId, 'T-004')
    assert.equal(native.passed, true); assert.equal(native.sourceBase, sourceBase)
    assert.ok(Object.keys(native.source).length > 0 && Object.keys(native.harnessSource).length > 0)
    for (const [path, digest] of Object.entries({ ...native.source, ...native.harnessSource }))
      assert.equal(sha(overlays.includes(path) ? await candidateBytes(path) : baseBytes(path)), digest, 'Native admission import differs: ' + path)
    for (const path of [definition, calendar, caller, nativeOwner, 'apps/desktop/src/main/runtime-controller.ts',
      'apps/desktop/src/main/continuous-progress-loop-manager.ts', 'packages/core/src/public-rpc-service.ts', 'packages/core/src/prompt-submission.ts'])
      assert.ok(native.source[path], 'The actual producer and admission owner must be loaded: ' + path)
    assert.equal(native.producer.code, 0); assert.equal(native.producer.signal, null)
    const producerBytes = await readFile(resolve(repository, native.producer.report))
    assert.equal(sha(producerBytes), native.producer.reportSha256)
    const producer = JSON.parse(producerBytes)
    assert.equal(producer.numPassedTests, 1); assert.equal(producer.numFailedTests, 0)
    assert.equal(sha(await readFile(resolve(repository, native.producer.loadedSource))), native.producer.loadedSha256)
    assert.equal(native.phases.length, 2); assert.notEqual(native.phases[0].pid, native.phases[1].pid)
    assert.equal(native.phases[0].hostedOwner.runtimeId, native.phases[1].hostedOwner.runtimeId)
    assert.notEqual(native.phases[0].hostedOwner.ownerInstanceId, native.phases[1].hostedOwner.ownerInstanceId)
    assert.deepEqual(native.phases[0].target, native.phases[1].target); assert.deepEqual(native.input.target, native.phases[0].target)
    assert.equal(native.phases[0].run.runId, native.input.runId); assert.equal(native.phases[1].run.runId, native.input.runId)
    assert.equal(native.phases[0].nativeSessionId, native.input.nativeSessionId); assert.equal(native.phases[1].nativeSessionId, native.input.nativeSessionId)
    assert.ok(native.phases.every(phase => phase.borrowed === true))
    const created = native.calls.find(call => call.method === 'schedule.create'), inspected = native.calls.find(call => call.method === 'schedule.inspect')
    const cliInspect = native.calls.find(call => call.method === 'SourceCLI schedule inspect'), cliResume = native.calls.find(call => call.method === 'SourceCLI schedule resume')
    assert.ok(created && inspected && cliInspect && cliResume)
    assert.deepEqual(created.params.target, native.input.target); assert.equal(created.params.prompt, native.input.prompt)
    assert.equal(created.params.operationId, native.input.creationOperationId); assert.equal(inspected.params.operationId, created.params.operationId)
    assert.equal(inspected.result.schedule.prompt, created.params.prompt); assert.equal(inspected.result.schedule.creationOperationId, created.params.operationId)
    assert.equal(cliInspect.result.ok, true); assert.equal(cliInspect.result.result.schedule.prompt, created.params.prompt)
    assert.equal(cliInspect.result.result.schedule.creationOperationId, created.params.operationId); assert.equal(cliResume.result.ok, true)
    assert.equal(native.input.promptSha256, sha(native.input.prompt)); assert.equal(native.input.unknownPaused, true); assert.equal(native.input.repeatedBytes, false)
    const nativeBytes = await readFile(resolve(repository, native.input.nativeBytesFile))
    assert.equal(sha(nativeBytes), native.input.nativeBytesSha256)
    assert.ok(nativeBytes.toString().trim().split('\n').map(line => JSON.parse(line).data).join('').includes(native.input.prompt))
    assert.ok(native.input.operationId && native.input.scheduleId && native.input.futureIntentId && native.input.runId && native.input.nativeSessionId)
    assert.deepEqual(native.cleanup, { completed: true, privateRootRemoved: true, ownedProcessesStopped: true })
    assert.equal(ui.passed, true); assert.equal(ui.process.exitCode, 0); assert.equal(ui.process.timedOut, false)
    assert.ok(ui.renderer?.passed && ui.renderer.operations?.length > 0 && Object.keys(ui.images).length > 0)
    for (const [path, digest] of Object.entries(ui.source)) if (/^(apps\/desktop\/src|packages\/)/.test(path))
      assert.equal(sha(overlays.includes(path) ? await candidateBytes(path) : baseBytes(path)), digest, 'Renderer production import differs: ' + path)
    for (const path of [definition, calendar, store, caller])
      assert.equal(ui.source[path], sha(overlays.includes(path) ? await candidateBytes(path) : baseBytes(path)), 'Renderer did not load the exact cooperation Source: ' + path)
    for (const [path, digest] of Object.entries(ui.images))
      assert.equal(sha(await readFile(resolve(repository, dirname(locator.renderer.path), basename(path)))), digest, 'Reviewed full image differs: ' + path)
    console.log(JSON.stringify({ passed: true, taskId: 'T-004', sourceGate: locator.sourceGate, renderer: locator.renderer, native: locator.native, review: locator.review,
      boundary: 'Source/UI/native admission qualification only; actual model use and usefulness remain T-006.' }))
  } catch (error) { console.error('T-004 is unqualified. Execute --source-only and bind exact independent operated UI review in .tmp/mote-daily-ideas/approved.json.\n' + error.stack); process.exitCode = 1 }
} else {
const attempt = await mkdtemp(join(output, 'attempt-')), snapshot = join(attempt, 'source')
const variants = [
  { id: 'material-scope', path: definition, from: '!fileExplorerContains(scope.rootPath, material.path) || material.path === scope.rootPath', to: 'false' },
  { id: 'exact-core-target', path: definition, from: 'agentSessionId: session.control.agentSessionId,\n    providerId:', to: 'agentSessionId: session.id,\n    providerId:' },
  { id: 'material-reread', path: definition, from: 'if (path === material?.path) sources.material = observation.result.document', to: 'if (path === material?.path) sources.material = material' },
  { id: 'history-opt-in', path: definition, from: 'if (input.includeDiscussion && session?.kind', to: 'if (session?.kind' },
  { id: 'history-source', path: definition, from: 'if (page.agentSessionId !== control.agentSessionId || page.source.providerId !== session.providerId || session.nativeSessionId && page.source.nativeSessionId !== session.nativeSessionId)', to: 'if (false)' },
  { id: 'renderer-goal-association', path: definition, from: 'goal.sessionIds.includes(session.id)', to: 'goal.sessionIds.includes(session.control.agentSessionId)' },
  { id: 'later-direction', path: definition, from: 'if (changed || !stillCurrent()) throw', to: 'if (changed) throw' },
  { id: 'navigation-aba', path: definition, from: 'fileNavigationSelection(current) !== navigation ||', to: 'false ||' },
  { id: 'revision-aba', path: definition, from: 'current.workspaceFileRevisions[scope.workspace.id] !== revision ||', to: 'false ||' },
  { id: 'target-aba', path: definition, from: 'currentSession.control.agentSessionId !== session.control.agentSessionId ||', to: 'false ||' },
  { id: 'resource-aba', path: definition,
    from: 'workspace?.hostId !== scope.workspace.hostId || workspace.path !== scope.workspace.path ||\n        (exact ? !confirmedMoteReference(current, scope, { reference: exact }) : !emptyMoteDestination(current, scope, { reference })) ||',
    to: 'false ||' },
  { id: 'manual-hidden-context', path: definition, from: 'agentMuxNote: moteIdeaRequestText(prepared.sources)', to: 'agentMuxNote: undefined' },
  { id: 'manual-visible-question', path: definition, from: 'openMoteDiscussionDraft(scope, input.direction,', to: 'openMoteDiscussionDraft(scope, moteIdeaRequestText(prepared.sources),' },
  { id: 'current-read-intent', path: definition, from: 'For each delivered request, read the current relevant original files using the original file.read / file.ls capability.', to: 'Use only the original preparation snapshot.' },
  { id: 'actual-ui-preparation', path: caller, from: 'onClick={() => void prepareArrangement()}', to: 'onClick={() => {}}' },
  { id: 'calendar-context-delivery', path: calendar, from: 'const message = occurrence.current.initialMessageContext ?', to: 'const message = false ?' },
  { id: 'calendar-same-target-seed', path: calendar, from: 'if (!sameTarget(occurrence.current.target, requestedTarget))', to: 'if (occurrence.current.target !== requestedTarget)' },
  { id: 'calendar-ack-before-list', path: calendar, from: '    updates.current++\n    setSchedules(previous =>', to: '    setSchedules(previous =>' },
  { id: 'calendar-null-original-pending', path: calendar,
    from: "} else setError('The connected Host did not find the original operation. Your message and original operation are kept; retry uses the same request.')",
    to: "} else { setError('The connected Host did not find the original operation. Your message and original operation are kept; retry uses the same request.'); setPending(undefined) }" },
  { id: 'calendar-original-prompt', path: calendar, from: ' && result.schedule.prompt === request.params.prompt', to: '' }
]
const receipt = { schema: 'agentmux.mote-daily-ideas-source.v1', taskId: 'T-004', passed: false, sourceBase,
  sourceQualified: false, sourceOnly, source: {}, sourceContext: {}, overlay: {}, harnessSource: {}, callers: [], runs: [], failure: null,
  qualifications: { source: 'pending', actualUi: 'pending', nativeAdmission: 'pending', realModel: 'separate-T006-pending-authentication' },
  boundary: 'Actual owning Source, original App/Store/Files protocol and real production Ideas/Calendar callers with isolated loaded mutants. DOM host and file observations are fixtures; no actual model, user App/Run, package, install, Native or visual approval claim.' }
const originals = {}, expectedTests = [], immutableSource = {}
async function run(label, expected, mutant) {
  const report = join(attempt, label + '.json'), sourceFile = join(attempt, label + '.loaded-source.ndjson')
  const child = spawn(process.execPath, [join(repository, 'node_modules/vitest/vitest.mjs'), 'run', '--config', join(snapshot, config),
    '--maxWorkers=1', '--reporter=json', '--outputFile=' + report], { cwd: snapshot,
    env: { ...process.env, TMPDIR: _hygiene_fixturePath("tmp"), AGENTMUX_IDEAS_SOURCE_RECEIPT: sourceFile }, stdio: ['ignore', 'pipe', 'pipe'] })
  let log = ''; child.stdout.on('data', bytes => { log += bytes }); child.stderr.on('data', bytes => { log += bytes })
  const timer = setTimeout(() => child.kill('SIGTERM'), 60_000)
  const status = await new Promise((done, reject) => { child.once('error', reject); child.once('exit', (code, signal) => done({ code, signal })) })
  clearTimeout(timer); await writeFile(join(attempt, label + '.log'), log)
  const row = { label, expected, ...status, collected: false, assertion: false, report: relative(repository, report), loadedSource: relative(repository, sourceFile) }
  receipt.runs.push(row)
  assert.equal(status.signal, null, 'A process termination is not behavior qualification')
  const raw = await readFile(report), value = JSON.parse(raw), tests = value.testResults.flatMap(suite => suite.assertionResults)
  assert.ok(tests.length > 0, 'Owning assertions must be nonempty'); assert.equal(value.numPendingTests, 0)
  const names = tests.map(one => one.fullName).sort()
  if (!expectedTests.length) expectedTests.push(...names)
  assert.deepEqual(names, expectedTests, 'Every run must collect the same complete owning counterexamples')
  row.collected = true; row.tests = names.length; row.reportSha256 = sha(raw)
  row.assertion = tests.some(one => one.status === 'failed' && one.failureMessages.some(message =>
    /AssertionError:|expected .* to |promise resolved .* instead of rejecting|promise rejected .* instead of resolving/s.test(message)))
  const entries = (await readFile(sourceFile, 'utf8')).trim().split('\n').map(line => JSON.parse(line)), loaded = {}
  assert.ok(entries.length > 0, 'Loaded production Source cannot be empty')
  for (const entry of entries) {
    assert.ok(!loaded[entry.path] || loaded[entry.path] === entry.sha256, 'One run cannot mix two Source versions')
    loaded[entry.path] = entry.sha256
  }
  assert.ok(loaded[definition] && loaded[calendar] && loaded[store] && loaded[caller] && loaded[test], 'Owning implementation, actual caller and counterexamples must all be loaded')
  if (mutant) assert.equal(loaded[mutant.path], sha(await readFile(join(snapshot, mutant.path))), 'The actual mutant must be loaded')
  row.loadedSha256 = sha(await readFile(sourceFile))
  if (expected === 'GREEN') {
    assert.equal(status.code, 0, log); assert.equal(value.success, true); assert.ok(tests.every(one => one.status === 'passed'))
    for (const [path, digest] of Object.entries(loaded)) {
      assert.ok(!receipt.source[path] || receipt.source[path] === digest, 'Restored runs must use the original Source')
      receipt.source[path] = digest
    }
  } else { assert.notEqual(status.code, 0, 'The real product mutant stayed GREEN'); assert.ok(row.assertion, 'A load or setup failure cannot qualify as AssertionRED') }
  console.log(label + ': ' + expected)
}
try {
  await mkdir(snapshot)
  const folders = ['apps/desktop/src', 'apps/desktop/test/fixtures', 'apps/desktop/test/helpers', 'packages/core/src', 'packages/client-ui/src', 'packages/demand/src', 'packages/layout/src', 'apps/desktop/scripts/fixtures/agent-schedules', 'packages/core/test/fixtures/fake-codex-cli.mjs']
  const context = [...originalCaptureHarness, 'apps/desktop/scripts/fixtures/mote-navigation-footer/vitest.owning.config.mts', 'apps/desktop/scripts/probe-process.mjs', 'vitest.setup.ts', 'tsconfig.base.json', 'apps/desktop/tsconfig.json', 'apps/desktop/package.json',
    ...['core', 'client-ui', 'demand', 'layout'].flatMap(name => ['packages/' + name + '/package.json', 'packages/' + name + '/tsconfig.json'])]
  const archive = execFileSync('git', ['archive', '--format=tar', sourceBase, ...folders, ...context], { cwd: repository, maxBuffer: 64 * 1024 * 1024 })
  const tar = spawn('tar', ['-x', '-C', snapshot], { stdio: ['pipe', 'ignore', 'pipe'] }); let tarError = ''
  tar.stderr.on('data', bytes => { tarError += bytes }); tar.stdin.end(archive)
  const tarCode = await new Promise((done, reject) => { tar.once('error', reject); tar.once('exit', done) })
  assert.equal(tarCode, 0, tarError)
  async function inventory(folder) {
    for (const entry of await readdir(join(snapshot, folder), { withFileTypes: true })) {
      const path = folder ? folder + '/' + entry.name : entry.name
      if (entry.isDirectory()) await inventory(path)
      else if (entry.isFile()) immutableSource[path] = sha(await readFile(join(snapshot, path)))
    }
  }
  await inventory('')
  for (const path of overlays) {
    const bytes = await candidateBytes(path)
    await mkdir(dirname(join(snapshot, path)), { recursive: true }); await writeFile(join(snapshot, path), bytes)
    receipt.overlay[path] = sha(bytes)
  }
  await writeFile(join(attempt, 'source-meta.json'), JSON.stringify({ sourceBase, overlay: receipt.overlay }, null, 2) + '\n')
  for (const path of context) receipt.sourceContext[path] = sha(await readFile(join(snapshot, path)))
  for (const path of ['node_modules', 'apps/desktop/node_modules', 'apps/desktop/resources', ...['core', 'client-ui', 'demand', 'layout'].map(name => 'packages/' + name + '/node_modules')])
    await symlink(join(repository, path), join(snapshot, path))
  await writeFile(join(snapshot, 'package.json'), '{"type":"module"}\n')
  for (const path of [definition, calendar, store, caller]) originals[path] = await readFile(join(snapshot, path))
  const lines = originals[caller].toString().split('\n'), line = lines.findIndex(value => value.includes('await prepareMoteIdeaSchedule('))
  assert.ok(line >= 0 && definition !== caller && !caller.includes('/test/'), 'The natural helper needs a definition-external production consumer')
  receipt.callers.push({ symbol: 'prepareMoteIdeaSchedule', definition, caller, line: line + 1 })
  const storeLine = originals[store].toString().split('\n').findIndex(value => value.includes('const launchNote = agentMuxNote ?? state.agentComposerNotes[regionId]'))
  assert.ok(storeLine >= 0, 'Frozen material context needs the original Store launch consumer')
  receipt.callers.push({ symbol: 'agentComposerNotes → launchAgent', definition, caller: store, line: storeLine + 1 })
  for (const path of allHarness) receipt.harnessSource[path] = sha(await readFile(join(repository, path)))
  for (const path of originalCaptureHarness) receipt.harnessSource[path] = sha(baseBytes(path))
  if (nativeOnly) {
    const child = spawn(process.execPath, [join(repository, nativeProbe), snapshot], { cwd: repository, env: { ...process.env, TMPDIR: _hygiene_fixturePath("tmp") }, stdio: ['ignore', 'pipe', 'pipe'] })
    let log = ''; child.stdout.on('data', bytes => { log += bytes }); child.stderr.on('data', bytes => { log += bytes })
    const status = await new Promise((done, reject) => { child.once('error', reject); child.once('exit', (code, signal) => done({ code, signal })) })
    await writeFile(join(attempt, 'native.log'), log)
    receipt.native = JSON.parse(log.split('\n').find(line => line.startsWith('{') && line.includes('\"receipt\"')))
    assert.equal(status.code, 0, log); assert.equal(status.signal, null); assert.equal(receipt.native.passed, true)
    receipt.qualifications.nativeAdmission = 'qualified'; receipt.passed = true
  } else {
  const desktopConfig = join(snapshot, 'apps/desktop/tsconfig.json'), rawConfig = ts.readConfigFile(desktopConfig, ts.sys.readFile)
  const parsed = ts.parseJsonConfigFileContent(rawConfig.config, ts.sys, dirname(desktopConfig), {}, desktopConfig), paths = {}
  for (const name of ['core', 'client-ui', 'demand', 'layout']) {
    const manifest = JSON.parse(await readFile(join(snapshot, 'packages/' + name + '/package.json'), 'utf8'))
    for (const [subpath, target] of Object.entries(manifest.exports)) {
      const value = typeof target === 'string' ? target : name === 'client-ui' ? target.browser : target.import
      assert.ok(value, 'Every public type consumer must map to original Source')
      const source = value.startsWith('./src/') ? value : value.replace('./dist/', name === 'core' ? './src/' : './').replace(/\.js$/, '.ts')
      paths['@agentmux/' + name + (subpath === '.' ? '' : subpath.slice(1))] = [resolve(snapshot, 'packages/' + name, source)]
    }
  }
  const program = ts.createProgram([definition, caller, calendar, test, originalTest, calendarTest, nativeOwner, 'apps/desktop/src/renderer/src/global.d.ts'].map(path => join(snapshot, path)),
    { ...parsed.options, paths, noEmit: true, incremental: false, composite: false })
  receipt.types = { source: {}, diagnostics: ts.getPreEmitDiagnostics(program).map(value => ({ code: value.code,
    path: value.file ? relative(snapshot, value.file.fileName) : null, message: ts.flattenDiagnosticMessageText(value.messageText, '\n') })) }
  for (const file of program.getSourceFiles()) {
    const path = relative(snapshot, file.fileName)
    if (!path.startsWith('../') && !path.includes('/node_modules/') && !path.startsWith('node_modules/')) receipt.types.source[path] = sha(await readFile(file.fileName))
  }
  assert.equal(receipt.types.diagnostics.length, 0, JSON.stringify(receipt.types.diagnostics))
  await run('baseline', 'GREEN')
  for (const variant of variants) {
    const before = originals[variant.path].toString(); assert.equal(before.split(variant.from).length, 2, 'Each mutant needs one exact implementation anchor')
    await writeFile(join(snapshot, variant.path), before.replace(variant.from, variant.to))
    try { await run(variant.id + '-red', 'RED', variant) }
    finally { await writeFile(join(snapshot, variant.path), originals[variant.path]) }
    await run(variant.id + '-restored', 'GREEN')
  }
  assert.ok(receipt.callers.length > 0 && receipt.runs.length > 1)
  for (const [path, digest] of Object.entries({ ...receipt.types.source, ...receipt.source }))
    assert.equal(overlays.includes(path) ? sha(await candidateBytes(path)) : immutableSource[path], digest, 'Loaded candidate Source changed before this qualification ended: ' + path)
  for (const [path, digest] of Object.entries(receipt.harnessSource)) assert.equal(sha(await readFile(join(repository, path))), digest, 'Task gate changed during execution')
  for (const [path, digest] of Object.entries(receipt.sourceContext)) assert.equal(immutableSource[path], digest, 'Source configuration differs from the immutable base')
  receipt.sourceQualified = true; receipt.qualifications.source = 'qualified'; receipt.passed = sourceOnly
  }
} catch (error) { receipt.failure = error.stack; process.exitCode = 1 }
finally {
  receipt.snapshot = relative(repository, snapshot)
  const file = join(attempt, 'receipt.json'); await writeFile(file, JSON.stringify(receipt, null, 2) + '\n')
  await writeFile(join(output, 'last.json'), JSON.stringify({ receipt: relative(repository, file), sha256: sha(await readFile(file)) }) + '\n')
  // The same exact thin Source is retained for the independent actual Renderer capture; cleanup follows the evidence join.
  console.log(JSON.stringify({ passed: receipt.passed, sourceQualified: receipt.sourceQualified, receipt: relative(repository, file), qualifications: receipt.qualifications }))
  if (receipt.failure) console.error(receipt.failure)
}
}
