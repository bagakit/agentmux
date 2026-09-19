import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const root = path.resolve(import.meta.dirname, '../../..')
const evidence = path.resolve(process.argv[2] ?? path.join(root, '.tmp/layered-human-interaction-mutations'))
const components = 'apps/desktop/src/renderer/src/components/'
const cases = [
  ['empty-session-projection', 'apps/desktop/src/renderer/src/lib/session-service-notices.ts', "if (session?.kind !== 'agent') return []", 'return []'],
  ['global-caller-disconnected', components + 'GlobalSystemNotices.tsx', '[environmentInbox, ownershipInbox, displacedInbox, sessionInbox]', '[environmentInbox, ownershipInbox, displacedInbox]'],
  ['native-reason-disconnected', components + 'AttentionRequestPanel.tsx', 'responseUnavailableReason={session.interactionResponseUnavailableReason}', 'responseUnavailableReason={undefined}'],
  ['stale-needs-you-label', components + 'AttentionRequestPanel.tsx', "const resolved = !request && !isNeedsYouState(session.status.state)", 'const resolved = false'],
  ['late-claim-not-isolated', components + 'AttentionRequestPanel.tsx', 'if (submittedRef.current !== claim) return\n', ''],
  ['local-failure-swallowed', components + 'AgentInteractionCard.tsx', 'setFailure(presentError(error))', 'setFailure(null)'],
  ['local-failure-escapes-global', 'apps/desktop/src/renderer/src/store.ts', 'await api.sessions.respondInteraction(session.control, response)', 'try { await api.sessions.respondInteraction(session.control, response) } catch (error) { get().reportError(error); throw error }'],
  ['replacement-card-state-reused', components + 'SessionPane.tsx', 'key={JSON.stringify([session.hostId, session.id, session.control.run.runId, session.pendingInteraction.id])}', ''],
  ['retired-local-error-retained', components + 'AttentionRequestPanel.tsx', 'setActionError(null)\n    setCaughtUp(false)\n  }, [activeSessionId, session?.hostId,', 'setCaughtUp(false)\n  }, [activeSessionId, session?.hostId,'],
]
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const files = [...new Set(cases.map(([, file]) => file))]
const originals = new Map(await Promise.all(files.map(async file => [file, await fs.readFile(path.join(root, file))])))
const receipt = { passed: false, inputs: Object.fromEntries([...originals].map(([file, bytes]) => [file, digest(bytes)])), cases: [] }
const run = name => {
  const result = spawnSync('pnpm', ['--filter', '@agentmux/desktop', 'exec', 'vitest', 'run', 'test/layered-human-interaction.test.tsx', '--maxWorkers=1'], { cwd: root, encoding: 'utf8', timeout: 45000 })
  const log = `${result.stdout ?? ''}${result.stderr ?? ''}`
  return { result, log, file: path.join(evidence, `${name}.log`) }
}
await fs.mkdir(evidence, { recursive: true })
try {
  for (const [name, file, before, after] of cases) {
    const original = originals.get(file)
    const source = original.toString('utf8')
    assert.equal(source.split(before).length - 1, 1, `Mutation anchor must be unique: ${name}`)
    try {
      await fs.writeFile(path.join(root, file), source.replace(before, after))
      const red = run(name)
      await fs.writeFile(red.file, red.log)
      assert.notEqual(red.result.status, 0, `Mutation survived: ${name}`)
      assert.match(red.log, /AssertionError/, `No behavioral assertion failed: ${name}`)
      receipt.cases.push({ name, file, redExit: red.result.status, log: path.relative(root, red.file) })
    } finally { await fs.writeFile(path.join(root, file), original) }
  }
  const green = run('restored-green')
  await fs.writeFile(green.file, green.log)
  assert.equal(green.result.status, 0, green.log)
  receipt.green = { exit: green.result.status, log: path.relative(root, green.file) }
  receipt.passed = true
} catch (error) { receipt.failure = { name: error.name, message: error.message, stack: error.stack } }
finally {
  for (const [file, original] of originals) await fs.writeFile(path.join(root, file), original)
  receipt.restored = Object.fromEntries(await Promise.all(files.map(async file => [file, digest(await fs.readFile(path.join(root, file)))])))
  await fs.writeFile(path.join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2))
}
assert.deepEqual(receipt.restored, receipt.inputs, 'Exact owning source must be restored')
assert.equal(receipt.passed, true, receipt.failure?.message)
console.log(JSON.stringify({ passed: true, cases: receipt.cases.length, exactRestoration: true }))
