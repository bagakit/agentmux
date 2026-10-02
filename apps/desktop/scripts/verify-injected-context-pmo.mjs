import { fixturePath as _hygiene_fixturePath } from "./lib/fixture-values.mjs"
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { runA2aProof } from '../../../packages/core/scripts/lib/a2a-proof.mjs'

const root = resolve(import.meta.dirname, '../../..')
const tests = ['apps/desktop/test/demand-pmo-tab-context.test.ts', 'apps/desktop/test/first-execution-ipc.test.ts']
const store = '../../apps/desktop/src/renderer/src/store.ts'
const sourceInputs = ['apps/desktop/src/renderer/src/store.ts', 'apps/desktop/src/renderer/src/lib/session-state.ts',
  'apps/desktop/src/preload/index.ts', 'apps/desktop/src/main/ipc.ts', 'apps/desktop/src/main/runtime-controller.ts',
  'apps/desktop/src/shared/contracts.ts', 'packages/core/src/client.ts', 'packages/core/src/agent-session-store.ts',
  'packages/core/src/prompt-submission.ts', 'packages/core/src/agent-outbound-message.ts',
  'apps/desktop/test/helpers/first-execution-ipc-bridge.ts', 'apps/desktop/test/helpers/injected-context-core.ts',
  'apps/desktop/scripts/verify-injected-context-pmo.mjs', 'packages/core/scripts/lib/a2a-proof.mjs']

await runA2aProof({
  name: 'injected-context-pmo-proof', tests,
  regressionTests: ['apps/desktop/test/first-execution-agent-restore.test.ts'],
  sourceInputs, environment: () => ({}),
  callers: [
    { symbol: 'requestDemandPmoTask(', path: 'apps/desktop/src/renderer/src/components/GlobalBoardSurface.tsx' },
    { symbol: 'launchAgent(', path: 'apps/desktop/src/renderer/src/components/NewTabSurface.tsx' },
    { symbol: 'api.sessions.submitPrompt(', path: 'apps/desktop/src/renderer/src/store.ts' },
    { symbol: 'runtime.submitPrompt(', path: 'apps/desktop/src/main/ipc.ts' },
    { symbol: 'client.submitAgentPrompt({', path: 'apps/desktop/src/main/runtime-controller.ts' }
  ],
  mutations: [
    { label: 'pmo-queued-context-disconnected', file: store, projectTests: tests,
      before: "pending.origin === 'manual', pending.agentMuxNote)", after: "pending.origin === 'manual', undefined)" },
    { label: 'pmo-queued-user-body-trimmed', file: store, projectTests: tests,
      before: '    text,\n    ...(agentMuxNote === undefined ? {} : { agentMuxNote }),',
      after: '    text: text.trim(),\n    ...(agentMuxNote === undefined ? {} : { agentMuxNote }),' },
    { label: 'pmo-initial-context-disconnected', file: store, projectTests: tests,
      before: '        ...(launchNote === undefined ? {} : { agentMuxNote: launchNote }),',
      after: '        // Original producer context deliberately disconnected.' },
    { label: 'pmo-retained-note-not-persisted', file: store, projectTests: tests,
      before: '    agentComposerNotes: state.agentComposerNotes,', after: '    agentComposerNotes: {},' },
    { label: 'pmo-complete-budget-not-checked', file: store, projectTests: tests,
      before: 'agentPromptExceedsBudget(composeAgentPrompt(text, agentMuxNote).text)', after: 'agentPromptExceedsBudget(text)' }
  ]
})

// Two actual test processes reopen the same private Renderer record, Core FileStore and Native
// receipt. Only the original explicit Send may retry; the durable Native tuple cannot write twice.
const evidence = join(root, '.tmp', ("injected-context-pmo-restart-" + (globalThis.crypto.randomUUID()) + ""))
const privateRoot = await mkdtemp(_hygiene_fixturePath("tmp/amx-pmo-process-restart-"))
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const hashes = async () => Object.fromEntries(await Promise.all([...sourceInputs, ...tests].map(async path =>
  [path, hash(await readFile(join(root, path)))])))
const receipt = { schema: 'agentmux.injected-context-pmo-restart.v1', passed: false, privateRoot, processes: [] }
await mkdir(evidence, { recursive: true })
try {
  receipt.sourceBefore = await hashes()
  for (const phase of ['seed', 'restore']) {
    const reportPath = join(evidence, `${phase}.json`)
    const result = await new Promise((yes, no) => {
      const child = spawn(process.execPath, [join(root, 'node_modules/vitest/vitest.mjs'), 'run', tests[1],
        '-t', 'PMO queued recovery', '--maxWorkers=1', '--reporter=json', `--outputFile=${reportPath}`], {
        cwd: root, env: { ...process.env, AGENTMUX_TEST_PMO_RESTART_PHASE: phase, AGENTMUX_TEST_PMO_RESTART_ROOT: privateRoot },
        stdio: ['ignore', 'pipe', 'pipe']
      })
      let output = ''
      child.stdout.on('data', chunk => { output += chunk }); child.stderr.on('data', chunk => { output += chunk })
      child.on('error', no); child.on('close', (code, signal) => yes({ phase, pid: child.pid, code, signal, output }))
    })
    await writeFile(join(evidence, `${phase}.log`), result.output)
    const report = JSON.parse(await readFile(reportPath, 'utf8'))
    receipt.processes.push({ phase, pid: result.pid, exit: result.code, signal: result.signal,
      passed: report.numPassedTests, failed: report.numFailedTests, report: `${phase}.json` })
    assert.equal(result.signal, null); assert.equal(result.code, 0, `${phase}: see ${phase}.log`)
    assert.equal(report.numPassedTests, 1); assert.equal(report.numFailedTests, 0)
    const native = JSON.parse(await readFile(join(privateRoot, 'private-native.json'), 'utf8'))
    assert.equal(native.writes.length, 1); assert.equal(native.receipts.length, 1)
    if (phase === 'seed') {
      receipt.originalNative = native
      const renderer = JSON.parse(await readFile(join(privateRoot, 'renderer.json'), 'utf8'))
      const entries = Object.entries(renderer.state.agentSteerQueues)
      assert.equal(entries.length, 1); assert.equal(entries[0][1].length, 1)
      const [sessionId, [entry]] = entries[0]
      assert.ok(entry.agentMuxNote.includes('Original <Goal> & context'))
      assert.equal(entry.text, 'Clarify goal'); assert.equal(entry.status, 'deferred')
      receipt.originalQueue = { sessionId, ...entry }
      receipt.originalWorkbench = renderer.state.restoredWorkbench
    } else assert.deepEqual(native, receipt.originalNative)
  }
  assert.notEqual(receipt.processes[0].pid, receipt.processes[1].pid)
  receipt.sourceAfter = await hashes(); assert.deepEqual(receipt.sourceAfter, receipt.sourceBefore)
  receipt.passed = true
} catch (error) { receipt.failure = { message: error.message, stack: error.stack } }
finally {
  await rm(privateRoot, { recursive: true, force: true }); receipt.cleanup = { privateRootRemoved: true }
  await writeFile(join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
}
assert.equal(receipt.passed, true, receipt.failure?.message)
process.stdout.write(JSON.stringify({ passed: true, restart: 'two-processes', receipt: join(evidence, 'receipt.json') }) + '\n')
