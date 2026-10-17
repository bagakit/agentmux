import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const args = process.argv.slice(2), output = args.indexOf('--output')
const home = path.resolve(root, output < 0 ? '.local/message-tool-settings/a2a' : args[output + 1])
const directory = path.join(home, 'attempt-' + randomUUID())
await mkdir(directory, { recursive: true })
const reuseIndex = args.indexOf('--reuse')
const previousPath = reuseIndex < 0 ? null : path.resolve(root, args[reuseIndex + 1])
const previous = previousPath ? JSON.parse(await readFile(previousPath, 'utf8')) : null
const config = 'apps/desktop/scripts/fixtures/message-tool-a2a/vitest.config.mts'
const core = 'packages/core/test/agent-message-observer.test.ts', settings = 'apps/desktop/test/a2a-settings-control.test.ts', ui = 'apps/desktop/test/a2a-settings.test.tsx', flow = 'apps/desktop/test/a2a-notification-flow.test.ts'
const mutations = [
  ['original-record-kind-lost', 'packages/core/src/agent-global-message-queue.ts', 'recordKind: String(row.record_kind)', "recordKind: 'message'", [core]],
  ['catchup-presented-as-live', 'packages/core/src/agent-message-observer.ts', "const live = this.state?.state === 'available'", 'const live = true', [core]],
  ['explicit-observation-not-selected', 'packages/core/src/client.ts', 'const selected = options?.observeMessages === true', 'const selected = false', [core]],
  ['late-reader-replays-prior-delta', 'packages/core/src/client.ts', 'through = cut.cut.throughSequence', 'through = 0', [core]],
  ['last-selected-reader-keeps-watch', 'packages/core/src/client.ts', 'if (!this.messageEventReaders && !(this.messageReadUsed && this.messageLegacyEventReaders))', 'if (false)', [core]],
  ['hosted-lease-keeps-selected-registration', 'packages/core/src/hosted-runtime-service.ts', 'consumer.stopMessages?.(); delete consumer.stopMessages\n        delete consumer.events', 'delete consumer.events', [core]],
  ['selected-current-cut-never-recovers', 'packages/core/src/client.ts', "if (through === undefined && (event.type === 'agent-message-changed' || event.state === 'available')) establishCut()", 'if (false) establishCut()', [core]],
  ['local-current-cut-failure-poisons-other-readers', 'packages/core/src/client.ts', "this.publisher.publishTo(receive, { type: 'agent-message-observation'", "this.publisher.publish({ type: 'agent-message-observation'", [core]],
  ['permanent-host-listener-retains-legacy-observation', 'packages/core/src/client.ts', 'const legacy = options?.observeMessages === undefined', 'const legacy = options?.observeMessages !== true', [core]],
  ['explicitly-excluded-reader-receives-a2a', 'packages/core/src/client.ts', "if (options?.observeMessages === false && (event.type === 'agent-message-changed' || event.type === 'agent-message-observation')) return", 'if (false) return', [core]],
  ['central-consumer-disconnected', 'apps/desktop/src/renderer/src/store.ts', "if (event.event.type === 'agent-message-changed')", 'if (false)', [ui]],
  ['receipt-is-treated-as-arrival', 'apps/desktop/src/renderer/src/lib/a2a-message-notifier.ts', "message.recordKind !== 'message' || !ready || !message.live || message.sequence !== message.messageSequence ||", '!ready || !message.live ||', [flow]],
  ['silent-preference-ignored', 'apps/desktop/src/shared/a2a-preferences.ts', "preference === 'silent' ||", 'false ||', [settings]],
  ['a2a-scalar-save-disconnected', 'apps/desktop/src/main/settings/modules/a2a.ts', '(config, notifications) => ({ ...config, a2a: { ...config.a2a, notifications } })', '(config, _notifications) => config', [settings]],
  ['a2a-schema-accepts-invalid-choice', 'apps/desktop/src/main/config-store.ts', 'z.enum(A2A_NOTIFICATION_IDS)', 'z.string()', [settings]],
  ['a2a-pane-save-disconnected', 'apps/desktop/src/renderer/src/components/settings/modules/a2a.tsx', 'await api.config.save({ ...current, a2a: { ...current.a2a, notifications } }, { ...current, a2a: { ...current.a2a, notifications: expected } })', 'await Promise.resolve()', [ui]]
].map(([id, file, before, after, tests]) => ({ id, file, before, after, tests }))
const inputs = [...new Set([config, fileURLToPath(import.meta.url), core, settings, ui, flow,
  ...mutations.map(item => item.file), 'packages/core/src/types.ts', 'packages/core/src/agent-message-journal.ts',
  'packages/core/src/hosted-client.ts', 'packages/core/src/hosted-value.ts', 'packages/core/src/client-event-publisher.ts', 'apps/desktop/src/main/runtime-controller.ts',
  'apps/desktop/src/main/agent-notifier.ts', 'apps/desktop/src/main/settings/setting-catalog.ts', 'apps/desktop/src/main/settings-control.ts',
  'apps/desktop/src/shared/contracts.ts', 'apps/desktop/src/shared/config-edit.ts', 'apps/desktop/src/renderer/src/components/settings/A2ASettingsPane.tsx',
  'apps/desktop/src/renderer/src/components/settings/a2a-settings.css'])]
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const source = async () => Object.fromEntries(await Promise.all(inputs.map(async file => [path.relative(root, path.resolve(root, file)), hash(await readFile(path.resolve(root, file)))])))
const receipt = { passed: false, boundary: 'Actual source imports, original cross-process journal and Unix Hosted RPC, executable Settings CLI, actual Renderer Store consumer and Main Notification.show call. Electron Notification is a platform collaborator; no OS display, user Run or installation claim.', sharedTreeMutations: 0, sourceBefore: await source(), runs: [] }
const run = async (id, tests, mutation) => {
  const report = path.join(directory, id + '.json'), log = path.join(directory, id + '.log')
  const env = { ...process.env }; delete env.AGENTMUX_TEST_RPC_CORE_ENTRY; delete env.AGENTMUX_A2A_SOURCE_MUTATION
  let loaded
  if (mutation) {
    loaded = path.join(directory, id + '-source.json')
    const manifest = path.join(directory, id + '-mutation.json')
    await writeFile(manifest, JSON.stringify({ ...mutation, receipt: loaded }))
    env.AGENTMUX_A2A_SOURCE_MUTATION = manifest
  }
  const result = await new Promise((yes, no) => {
    const child = spawn(process.execPath, [path.join(root, 'node_modules/vitest/vitest.mjs'), 'run', ...tests, '--config', config, '--maxWorkers=1', '--reporter=json', '--outputFile=' + report], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let text = ''; child.stdout.on('data', bytes => { text += bytes }); child.stderr.on('data', bytes => { text += bytes }); child.on('error', no); child.on('close', (code, signal) => yes({ code, signal, text }))
  })
  await writeFile(log, result.text)
  const raw = JSON.parse(await readFile(report, 'utf8'))
  const failed = raw.testResults.flatMap(test => test.assertionResults).filter(test => test.status === 'failed')
  const record = { id, code: result.code, tests: raw.numTotalTests, failed: raw.numFailedTests, report: path.relative(root, report), assertionFailures: failed.filter(test => test.failureMessages.some(text => /AssertionError|__VITEST_(?:REJECTS|RESOLVES)__/u.test(text))).map(test => test.fullName) }
  assert.equal(result.signal, null); assert.ok(record.tests > 0, 'Nonempty actual tests')
  if (loaded) { record.loadedSource = JSON.parse(await readFile(loaded, 'utf8')); assert.equal(record.loadedSource.before, receipt.sourceBefore[mutation.file]); assert.notEqual(record.loadedSource.before, record.loadedSource.after) }
  receipt.runs.push(record)
  return record
}
try {
  const green = await run('candidate-green', [core, settings, ui, flow]); assert.equal(green.code, 0, 'Candidate must pass actual behavior tests')
  if (!args.includes('--baseline-only')) for (const mutation of mutations) {
    // A bounded Core-only correction need not repeat unchanged pane/scalar REDs.
    // The full current candidate still runs before and after; both original
    // test bytes and the actual mutated owner bytes must match the earlier proof.
    if (previous?.passed && ['silent-preference-ignored', 'a2a-scalar-save-disconnected', 'a2a-schema-accepts-invalid-choice', 'a2a-pane-save-disconnected'].includes(mutation.id)) {
      const old = previous.runs.find(run => run.id === mutation.id)
      if (old?.assertionFailures?.length && old.loadedSource?.before === receipt.sourceBefore[mutation.file] &&
        mutation.tests.every(test => previous.sourceBefore[test] === receipt.sourceBefore[test]) && previous.sourceBefore[config] === receipt.sourceBefore[config]) {
        const current = await readFile(path.join(root, mutation.file), 'utf8')
        assert.equal(current.split(mutation.before).length, 2)
        assert.equal(hash(current.replace(mutation.before, mutation.after)), old.loadedSource.after)
        receipt.runs.push({ ...old, reusedFrom: path.relative(root, previousPath), currentOwnerAndTestsMatch: true })
        process.stdout.write(mutation.id + ': source-qualified prior assertion RED\n')
        continue
      }
    }
    const red = await run(mutation.id, mutation.tests, mutation)
    assert.ok(red.code > 0 && red.failed > 0 && red.assertionFailures.length > 0, 'Owning mutation must fail an actual assertion: ' + mutation.id)
    process.stdout.write(mutation.id + ': assertion RED\n')
  }
  const restored = await run('restored-green', [core, settings, ui, flow]); assert.equal(restored.code, 0, 'Pristine actual source must remain GREEN')
  receipt.sourceAfter = await source(); assert.deepEqual(receipt.sourceAfter, receipt.sourceBefore, 'Qualified inputs changed during this proof')
  receipt.passed = true
} catch (error) { receipt.failure = { message: error.message, stack: error.stack } }
finally {
  receipt.cleanup = { sharedSourceUntouchedByVerifier: true, privateSourceTransformsOnly: true }
  await writeFile(path.join(directory, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
  await writeFile(path.join(home, 'receipt.json'), JSON.stringify({ ...receipt, evidenceRoot: path.relative(root, directory) }, null, 2) + '\n')
}
console.log(JSON.stringify({ passed: receipt.passed, evidence: path.relative(root, directory), runs: receipt.runs.length, failure: receipt.failure?.message }))
if (!receipt.passed) process.exitCode = 1
