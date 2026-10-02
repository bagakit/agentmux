import assert from 'node:assert/strict'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { resolve, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { verifyRendererSourceMutations } from './lib/verify-renderer-source-mutations.mjs'

const root = resolve(import.meta.dirname, '../../..')
const evidence = join(root, '.bagakit/feature-tracker/focus-stop-agent-artifacts')
const helper = 'apps/desktop/src/renderer/src/components/FocusStopAgent.tsx'
const toolbar = 'apps/desktop/src/renderer/src/components/FocusToolbar.tsx'
const card = 'apps/desktop/src/renderer/src/components/FocusContextMenu.tsx'
const test = 'apps/desktop/test/focus-stop-agent.test.tsx'
await mkdir(evidence, { recursive: true })
const name = 'source-' + globalThis.crypto.randomUUID()
await verifyRendererSourceMutations({ name, evidenceRoot: evidence, tests: [test], sources: [helper, card, toolbar, 'apps/desktop/test/helpers/client-ui-render.tsx', 'apps/desktop/test/helpers/composer-dom-fixture.tsx'], mutations: [
  { label: 'wrong-SID', file: helper, before: 'await api.sessions.stop(control)', after: "await api.sessions.stop({ ...control, agentSessionId: 'stop-first' })" },
  { label: 'stale-Run', file: helper, before: 'current.control.run.runId !== control.run.runId', after: 'false' },
  { label: 'duplicate-pending', file: helper, before: 'flight.current = true\n    setBusy(true)', after: 'flight.current = false\n    setBusy(false)' },
  { label: 'lost-failure-service', file: helper,
    before: "useAppStore.getState().reportError(error, {\n        kind: 'indeterminate', subject: control,\n        summary: 'Stop Agent did not complete. Its current state is unconfirmed; the original work surface and draft are kept. Review its status, then retry Stop Agent.'\n      })",
    after: 'void error' },
  { label: 'optimistic-retirement', file: helper, before: 'await api.sessions.stop(control)',
    after: "await api.sessions.stop(control); useAppStore.setState(state => ({ sessions: state.sessions.filter(item => item.id !== control.agentSessionId) }))" },
  { label: 'title-modal-focus-trap', file: toolbar, before: '<ContextMenu.Root modal={false}>', after: '<ContextMenu.Root>' }
] })
const receipt = JSON.parse(await readFile(join(evidence, name, 'receipt.json'), 'utf8'))
const callers = {}
for (const [symbol, definition] of [['useFocusStopAgent()', helper], ['<FocusContextMenu ', card], ['<FocusToolbar ', toolbar]]) {
  const scan = spawnSync('rg', ['-n', '--fixed-strings', symbol, 'apps/desktop/src'], { cwd: root, encoding: 'utf8' })
  assert.equal(scan.status, 0)
  callers[symbol] = scan.stdout.trim().split('\n').filter(line => !line.startsWith(definition + ':') && !/^.*:\d+:\s*import\b/.test(line))
  assert.ok(callers[symbol].length, 'Nonempty production caller outside definition: ' + symbol)
}
const files = [helper, card, toolbar, test]
const inputs = Object.fromEntries(await Promise.all(files.map(async file => [file, createHash('sha256').update(await readFile(join(root, file))).digest('hex')])))
await writeFile(join(evidence, 'qualification.json'), JSON.stringify({ passed: true, inputs, mutation: receipt, callers,
  boundary: 'Mounted original Focus card/toolbar/confirmation/API seam. Public stop mocked for action proof; real private lifecycle and compiled visual receipts are separate.' }, null, 2) + '\n')
console.log(JSON.stringify({ passed: true, mutants: receipt.cases.length, callers }))
