import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join, resolve, relative } from 'node:path'
import { tmpdir } from 'node:os'

const root = resolve(import.meta.dirname, '../../..'), require = createRequire(import.meta.url)
const run = promisify(execFile), sha = bytes => createHash('sha256').update(bytes).digest('hex')
const component = name => 'apps/desktop/src/renderer/src/components/' + name + '.tsx'
const owner = component('MoteDetailsPanel')
const tests = ['mote-workspace', 'mote-cooperation', 'mote-ideas', 'mote-materials-inspection', 'mote-daily-work', 'mote-memory-profile']
const config = 'apps/desktop/scripts/fixtures/mote-workspace/vitest.config.mts'
const callers = [
  { file: component('WorkspaceFilesTool'), anchor: '<MoteFilesTool {...props} scope={mote} />', proves: 'The workspace routes its exact Mote scope to the original file owner.' },
  { file: component('MoteFilesTool'), anchor: '<MoteDetailsPanel key={scope.topic.id} scope={scope} reference={reference} active={visible}', proves: 'The actual tools frame passes original identity, display reference and visibility.' },
  { file: owner, anchor: '<MoteFirstCooperation scope={scope} reference={reference} />', proves: 'The visible question uses the existing Launcher preparation owner.' },
  { file: owner, anchor: '<MoteCurrentWork scope={scope} reference={reference} active={profileActive} />', proves: 'Current work consumes the original Goal references and visibility.' },
  { file: owner, anchor: 'void readMoteMaterial(scope, selected).then', proves: 'Selecting a note reads the exact original file through the public seam.' },
  { file: owner, anchor: '<MoteIdeaControls scope={scope} reference={reference} material={note?.path === selected && !issue && !loading ? note : null}', proves: 'Requests and arrangements receive only the confirmed selected file revision.' },
  { file: owner, anchor: '<MoteIdeaFeedbackControl key={JSON.stringify([note.path, note.revision])} scope={scope} material={note} onOpenPath={onOpenPath}', proves: 'Reader feedback uses the exact confirmed note and original Editor action.' },
  { file: component('MoteIdeaControls'), anchor: 'void stageMoteIdeaFeedback(scope, material, feedback, onOpenPath,', proves: 'The selected revision feedback is staged through the original SOUL and Editor owner.' },
  { file: component('MoteFirstCooperation'), anchor: 'await prepareMoteCooperationDraft(scope, reference, { question }, stillCurrent)', proves: 'Question text, exact display reference and later-input guard reach the original preparation.' },
  { file: 'apps/desktop/src/renderer/src/lib/mote-cooperation.ts', anchor: 'openMoteDiscussionDraft(scope, input.question, { reference, agentMuxNote })', proves: 'Preparation creates a real editable Launcher through the existing owner.' },
  { file: 'apps/desktop/src/renderer/src/lib/mote-materials-actions.ts', anchor: 'current.setAgentComposerDraft(region.regionId, prompt)', proves: 'The original target Region receives the prepared draft without operating a Run.' }
]

/** Mounted App proof and private loader mutations; real Renderer image review is separate. */
export async function verifyMoteWorkspace() {
  const output = join(root, '.local/state/mote-workspace/proof'); await mkdir(output, { recursive: true })
  const directory = await mkdtemp(join(output, 'attempt-'))
  const paths = [...new Set([owner, ...callers.map(item => item.file), component('MoteIdeaControls'), component('MoteCurrentWork'), component('MoteMemory'),
    'apps/desktop/src/renderer/src/lib/launcher-state.ts',
    'apps/desktop/test/fixtures/mote-app.tsx', 'apps/desktop/test/fixtures/mote-workface.ts', config,
    'apps/desktop/scripts/fixtures/mote-navigation-footer/vitest.owning.config.mts',
    'apps/desktop/scripts/fixtures/agent-schedules/isolate-core.mjs', 'apps/desktop/scripts/verify-mote-workspace.mjs',
    ...tests.map(name => 'apps/desktop/test/' + name + '.test.tsx')])]
  const sourceBindings = await Promise.all(paths.map(async path => ({ path, sha256: sha(await readFile(join(root, path))) })))
  const receipt = { schema: 'agentmux.mote-workspace-proof.v1', passed: false, sourceBindings, callers: [], runs: [], mutations: [], types: null, failure: null,
    boundary: 'Actual App -> WorkspaceFilesTool -> MoteFilesTool -> MoteDetailsPanel, original Goal, Files, Editor and Launcher consumers. Native terminal attachment is controlled. Calendar business behavior and styles belong to their independent task and image review. This does not qualify a live model, Session restart, installed package or independent aesthetic review.' }
  async function test(label, mutation, restored = false) {
    const privateRoot = await mkdtemp(join(tmpdir(), 'mote-workspace-proof-'))
    const reportPath = join(directory, label + '.json'), logPath = join(directory, label + '.log'), loadedPath = join(directory, label + '.loaded.ndjson')
    const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(AGENTMUX_|CTXMUX_|MOTE_WORKSPACE_)/.test(key))),
      AGENTMUX_RUNTIME_DIRECTORY: join(privateRoot, 'runtime'), AGENTMUX_STATE_DIRECTORY: join(privateRoot, 'state'),
      AGENTMUX_AGENT_SESSION_STORE: join(privateRoot, 'sessions.json'), AGENTMUX_MESSAGE_QUEUE_PATH: join(privateRoot, 'queue.ndjson'),
      MOTE_WORKSPACE_SOURCE_RECEIPT: loadedPath,
      ...(mutation ? { MOTE_WORKSPACE_MUTANT_OWNER: join(root, owner), MOTE_WORKSPACE_MUTANT_COPY: mutation.copy } : {}) }
    let code = 0, signal = null, text = ''
    try {
      const result = await run(process.execPath, [join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config', join(root, config), '--reporter=json', '--outputFile', reportPath,
        ...(mutation ? ['test/mote-workspace.test.tsx', '-t', mutation.filter] : restored ? ['test/mote-workspace.test.tsx'] : [])], { cwd: root, env, timeout: 180000, maxBuffer: 8 * 1024 * 1024 })
      text = result.stdout + result.stderr
    } catch (error) { code = error.code; signal = error.signal; text = (error.stdout ?? '') + (error.stderr ?? '') }
    finally { await rm(privateRoot, { recursive: true, force: true }) }
    await writeFile(logPath, text)
    const reportBytes = await readFile(reportPath), report = JSON.parse(reportBytes)
    const entry = { label, code, signal, collected: report.numTotalTests, passed: report.numPassedTests, failed: report.numFailedTests,
      report: relative(root, reportPath), reportSha256: sha(reportBytes), log: relative(root, logPath), logSha256: sha(text), loaded: relative(root, loadedPath) }
    receipt.runs.push(entry)
    assert.equal(signal, null, 'Process termination cannot qualify as behavior proof')
    assert(report.numTotalTests > 0 && report.numPassedTests + report.numFailedTests > 0, 'Nonempty executed tests are required')
    const failures = report.testResults.flatMap(file => file.assertionResults.filter(item => item.status === 'failed'))
    if (mutation) {
      assert.notEqual(code, 0, 'A production wiring mutation stayed green: ' + mutation.name)
      assert(report.numFailedTests > 0, 'The original assertion must reject the mutant')
      assert(failures.some(item => item.failureMessages.some(message => /AssertionError|expected /u.test(message))), 'RED needs an actual behavior assertion')
      assert(!failures.some(item => item.failureMessages.some(message => /Cannot find module|Failed to resolve import|Transform failed|SyntaxError:|ReferenceError:/u.test(message))), 'Load and setup failures are not mutation proof')
    } else {
      assert.equal(code, 0, text.slice(-6000)); assert.equal(report.numFailedTests, 0)
      assert.equal(report.numPendingTests, 0, 'The intended consumer cases must all execute')
      for (const name of restored ? ['mote-workspace'] : tests) {
        const file = report.testResults.find(file => file.name.endsWith('/' + name + '.test.tsx'))
        assert(file && file.assertionResults.length > 0 && file.assertionResults.some(item => item.status === 'passed'), 'Every intended real consumer suite must execute: ' + name)
      }
    }
    const loadedBytes = await readFile(loadedPath), loaded = loadedBytes.toString().trim().split('\n').map(line => JSON.parse(line))
    assert(loaded.length > 0, 'The production source collector must not be empty')
    assert(loaded.some(item => relative(root, item.path) === owner && item.sha256 === (mutation?.mutantSha256 ?? sourceBindings.find(item => item.path === owner).sha256)), 'The actual candidate production owner must be loaded')
    entry.loadedSha256 = sha(loadedBytes)
    if (!mutation) for (const file of [component('WorkspaceFilesTool'), component('MoteFilesTool'), component('MoteFirstCooperation'), component('MoteCurrentWork')])
      assert(loaded.some(item => relative(root, item.path) === file), 'The real App chain was not loaded: ' + file)
    console.log(label + ': ' + (mutation ? 'assertion RED' : 'GREEN') + ' (' + (report.numPassedTests + report.numFailedTests) + ' executed)')
  }
  try {
    for (const check of callers) {
      assert(!/\/test\/|\.test\./u.test(check.file), 'A test cannot serve as a production caller')
      const source = await readFile(join(root, check.file), 'utf8'), line = source.split('\n').findIndex(line => line.includes(check.anchor) && !line.trim().startsWith('import '))
      assert(line >= 0, 'Missing original production call: ' + check.anchor)
      receipt.callers.push({ ...check, line: line + 1 })
    }
    assert(receipt.callers.length > 0, 'Production call checks must not be empty')
    await test('baseline')
    const changes = [
      { name: 'filter-clears-selected-source', from: 'onChange={event => setFilter(event.target.value)}', to: 'onChange={event => { setFilter(event.target.value); setSelected(null) }}', filter: 'filters discovered names' },
      { name: 'note-selection-borrows-first-source', from: 'setSelected(path); setReading(true)', to: 'setSelected(notes[0]?.path ?? path); setReading(true)', filter: 'changes only the selected original source' },
      { name: 'hidden-ideas-observation', from: 'active={active && section !== \'calendar\'} section={contentSection.current}', to: 'active={active} section={contentSection.current}', filter: 'parks selected-note observations' },
      { name: 'back-keeps-reader-open', from: 'setReading(false)', to: 'setReading(true)', filter: 'returns from the selected reader' },
      { name: 'original-file-action-disconnected', from: 'onClick={() => void onOpenPath(selected)}>Open file', to: 'onClick={() => {}}>Open file', filter: 'opens the selected original file through' },
      { name: 'current-work-consumer-disconnected', from: '<MoteCurrentWork scope={scope} reference={reference} active={profileActive} />', to: '<></>', filter: 'puts a real question and current work' }
    ]
    const original = await readFile(join(root, owner), 'utf8')
    for (const change of changes) {
      assert.equal(original.split(change.from).length, 2, 'A mutation needs one exact implementation anchor: ' + change.name)
      const mutated = original.replace(change.from, change.to), copy = join(directory, change.name + '.tsx')
      await writeFile(copy, mutated)
      const mutation = { ...change, copy, sourceSha256: sha(original), mutantSha256: sha(mutated) }
      receipt.mutations.push({ ...mutation, copy: relative(root, copy) })
      await test('red-' + change.name, mutation)
    }
    await test('restored', null, true)
    const configuration = { extends: join(root, 'apps/desktop/tsconfig.json'), compilerOptions: { incremental: false, types: ['node'], typeRoots: [resolve(require.resolve('@types/node/package.json'), '../..')] },
      include: [join(root, owner), join(root, 'apps/desktop/test/mote-workspace.test.tsx'), join(root, 'apps/desktop/src/renderer/src/global.d.ts'), resolve(require.resolve('vite'), '../../../client.d.ts')] }
    const typeConfig = join(directory, 'tsconfig.json'); await writeFile(typeConfig, JSON.stringify(configuration, null, 2))
    let typeOutput = ''
    try {
      const types = await run(process.execPath, [require.resolve('typescript/bin/tsc'), '--noEmit', '-p', typeConfig], { cwd: root, timeout: 120000, maxBuffer: 4 * 1024 * 1024 })
      typeOutput = types.stdout + types.stderr; receipt.types = { passed: true, configuration: relative(root, typeConfig) }
    } catch (error) { typeOutput = (error.stdout ?? '') + (error.stderr ?? ''); receipt.types = { passed: false, configuration: relative(root, typeConfig) }; throw error }
    finally { await writeFile(join(directory, 'types.log'), typeOutput) }
    for (const item of sourceBindings) assert.equal(sha(await readFile(join(root, item.path))), item.sha256, 'Candidate changed during proof: ' + item.path)
    receipt.passed = true
  } catch (error) { receipt.failure = error.stack; process.exitCode = 1 }
  finally {
    const receiptPath = join(directory, 'receipt.json'), bytes = JSON.stringify(receipt, null, 2) + '\n'
    await writeFile(receiptPath, bytes)
    await writeFile(join(output, 'latest.json'), JSON.stringify({ receipt: relative(root, receiptPath), sha256: sha(bytes) }, null, 2) + '\n')
    console.log(JSON.stringify({ passed: receipt.passed, tests: receipt.runs[0]?.passed, mutations: receipt.mutations.length, receipt: relative(root, receiptPath), failure: receipt.failure }))
  }
  return receipt
}
if (process.argv[1] === import.meta.filename) await verifyMoteWorkspace()
