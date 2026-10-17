import assert from 'node:assert/strict'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { resolve, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { verifyRendererSourceMutations } from './lib/verify-renderer-source-mutations.mjs'

const root = resolve(import.meta.dirname, '../../..')
const evidence = join(root, '.bagakit/feature-tracker/focus-stop-agent-artifacts')
const helper = 'apps/desktop/src/renderer/src/components/SessionStop.tsx'
const header = 'apps/desktop/src/renderer/src/components/AgentRegionHeader.tsx'
const toolbar = 'apps/desktop/src/renderer/src/components/FocusToolbar.tsx'
const card = 'apps/desktop/src/renderer/src/components/FocusContextMenu.tsx'
const test = 'apps/desktop/test/focus-stop-agent.test.tsx'
await mkdir(evidence, { recursive: true })
const name = 'source-' + globalThis.crypto.randomUUID()
await verifyRendererSourceMutations({ name, evidenceRoot: evidence, tests: [test], sources: [helper, card, header, toolbar, 'apps/desktop/test/helpers/client-ui-render.tsx', 'apps/desktop/test/helpers/composer-dom-fixture.tsx'], mutations: [
  { label: 'wrong-SID', file: helper, before: 'await api.sessions.stop(control)', after: "await api.sessions.stop({ ...control, agentSessionId: 'stop-first' })" },
  { label: 'stale-Run', file: helper, before: 'if (!agentMenuRunMatches(current, control))', after: 'if (false)' },
  { label: 'duplicate-pending', file: helper, before: 'flight.current = true\n    setBusy(true)', after: 'flight.current = false\n    setBusy(false)' },
  { label: 'lost-failure-service', file: helper,
    before: "useAppStore.getState().reportError(error, {\n        kind: 'indeterminate', subject: control,\n        summary: 'Stop Agent did not complete. Its current state is unconfirmed; the original work surface and draft are kept. Review its status, then retry Stop Agent.'\n      })",
    after: 'void error' },
  { label: 'optimistic-retirement', file: helper, before: 'await api.sessions.stop(control)',
    after: "await api.sessions.stop(control); useAppStore.setState(state => ({ sessions: state.sessions.filter(item => item.id !== control.agentSessionId) }))" }
] })
const receipt = JSON.parse(await readFile(join(evidence, name, 'receipt.json'), 'utf8'))
const callers = {}
for (const [symbol, definition] of [['useSessionStop(', helper], ['<FocusContextMenu ', card], ['<AgentRegionHeader ', header]]) {
  const scan = spawnSync('rg', ['-n', '--fixed-strings', symbol, 'apps/desktop/src'], { cwd: root, encoding: 'utf8' })
  assert.equal(scan.status, 0)
  callers[symbol] = scan.stdout.trim().split('\n').filter(line => !line.startsWith(definition + ':') && !/^.*:\d+:\s*import\b/.test(line))
  assert.ok(callers[symbol].length, 'Nonempty production caller outside definition: ' + symbol)
}
const files = [helper, card, header, toolbar, test]
const inputs = Object.fromEntries(await Promise.all(files.map(async file => [file, createHash('sha256').update(await readFile(join(root, file))).digest('hex')])))
await writeFile(join(evidence, 'qualification.json'), JSON.stringify({ passed: true, inputs, mutation: receipt, callers,
  boundary: 'Mounted original Agent card/confirmation/API seam and Tab-only toolbar. Region Header interaction, private lifecycle and visual receipts are separately qualified; public stop is mocked here.' }, null, 2) + '\n')
console.log(JSON.stringify({ passed: true, mutants: receipt.cases.length, callers }))
