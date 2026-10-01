import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve, join, dirname } from 'node:path'
import { spawnSync } from 'node:child_process'
import { verifyRendererSourceMutations } from './lib/verify-renderer-source-mutations.mjs'

assert.deepEqual(process.argv.slice(2), ['--slice', 'source'])
const root = resolve(import.meta.dirname, '../../..')
const evidenceRoot = join(root, '.bagakit/feature-tracker/focus-identity-consistency-artifacts/card-interaction')
await mkdir(evidenceRoot, { recursive: true })
const row = 'apps/desktop/src/renderer/src/components/FocusContextRow.tsx'
const menu = 'apps/desktop/src/renderer/src/components/FocusContextMenu.tsx'
const hover = 'apps/desktop/src/renderer/src/components/FocusContextHover.tsx'
const test = 'apps/desktop/test/focus-context-card-interaction.test.tsx'
const name = 'card-interaction-mutants-' + globalThis.crypto.randomUUID()
const reusedPaths = process.env.AGENTMUX_MUTATION_RECEIPTS ? JSON.parse(process.env.AGENTMUX_MUTATION_RECEIPTS) : null
if (reusedPaths) assert.ok(Array.isArray(reusedPaths) && reusedPaths.length === 1, 'Select one exact card mutation receipt')
const receiptPath = reusedPaths ? resolve(reusedPaths[0]) : join(evidenceRoot, name, 'receipt.json')
await verifyRendererSourceMutations({ name, tests: [test], sources: [row, menu, hover], evidenceRoot, mutations: [
  { label: 'stale-hover-intent', file: hover, before: 'const close = useCallback((): void => {\n    clearTimeout(intent.current); clearTimeout(departure.current)', after: 'const close = useCallback((): void => {\n    clearTimeout(departure.current)' },
  { label: 'missing-keyboard-preview', file: hover, before: 'onFocus: () => { if (!restoringFocus.current) show() }', after: 'onFocus: () => {}' },
  { label: 'wrong-Agent-rename', file: row, before: 'renameAgent(context.id, draft.trim() || null)', after: "renameAgent('card-first', draft.trim() || null)" },
  { label: 'wrong-menu-Open-target', file: menu, before: 'onSelect(sessionId)', after: "onSelect('card-first')" },
  { label: 'lost-later-menu-focus', file: menu, before: 'if (actionOwnsFocus.current || laterFocus) {', after: 'if (actionOwnsFocus.current) {' }
] })
const mutation = JSON.parse(await readFile(receiptPath, 'utf8'))
for (const filename of ['baseline-green.log', ...mutation.cases.map(item => item.restore.log)]) {
  const log = await readFile(join(dirname(receiptPath), filename), 'utf8')
  assert.match(log, /Tests\s+8 passed/)
  assert.doesNotMatch(log, /\d+ skipped|no tests/)
}
const callers = {}
for (const [symbol, definition] of [['<FocusContextRow ', row], ['<FocusContextMenu ', menu], ['useFocusContextHover(', hover]]) {
  const result = spawnSync('rg', ['-n', '--fixed-strings', symbol, 'apps/desktop/src'], { cwd: root, encoding: 'utf8' })
  assert.equal(result.status, 0)
  const hits = result.stdout.trim().split('\n').filter(line => !line.startsWith(definition + ':') && !/^.*:\d+:\s*import\b/.test(line))
  assert.ok(hits.length > 0, 'Definition-external production caller: ' + symbol)
  callers[symbol] = hits
}
const files = [row, menu, hover, test, 'apps/desktop/src/renderer/src/styles/focus.css']
const inputs = Object.fromEntries(await Promise.all(files.map(async file => [file, createHash('sha256').update(await readFile(join(root, file))).digest('hex')])))
await writeFile(join(evidenceRoot, 'qualification.json'), JSON.stringify({ schema: 'agentmux.focus-context-card-interaction-qualification.v1', passed: true,
  inputs, mutations: mutation, callers, boundary: 'Actual current Row/Menu/Hover/Store and Radix. Avatar paint isolated in unit proof; actual scene is independently reviewed. No Run control, restart or installation.' }, null, 2) + '\n')
console.log(JSON.stringify({ passed: true, qualification: join(evidenceRoot, 'qualification.json') }))
