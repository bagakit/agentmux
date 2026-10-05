import { fixturePath } from './helpers/fixture-values.js'
import { expect, it } from 'vitest'
import { AgentTerminalScreen } from '../src/agent-terminal-screen.js'
import { inspectCodexPromptExecution, inspectCodexPromptPreparationWait } from '../src/providers/codex-prompt-execution.js'

const pane = (status: string, detail = '', compact = false, effort = 'xhigh') => `\x1b[?2026h\x1b[2J\x1b[${compact ? 13 : 14};1H\x1b[1m•\x1b[0m\x1b[2m ${status}${detail}\x1b[${compact ? 18 : 17};1H\x1b[1m›\x1b[0m\x1b[2m Ask Codex to do anything\x1b[0m\x1b[20;3HGPT-6.1-Sol ${effort} · ${fixturePath("project")} · Main [default]\x1b[21;3H?\x1b[2m for shortcuts\x1b[0m\x1b[${compact ? 18 : 17};3H\x1b[?2026l`
const compact = pane('Compacting context (32s • esc to interrupt)', '\x1b[14;3H└ Making room to continue.\x1b[15;3H└ \x1b[0m\x1b[1mTip:\x1b[0m Use /init for project guidance.', true)
// 13 status + Making room + Tip + two blank rows + 18 composer.
async function snapshot(bytes: string) {
  const screen = new AgentTerminalScreen(120, 24)
  try { const dataBytes = Buffer.from(bytes); await screen.write({ startByte: 0, endByte: dataBytes.length, dataBytes }); return screen.snapshot() }
  finally { screen.dispose() }
}
it('identifies the captured compact/Making room/Tip group without authorizing input', async () => {
  const screen = await snapshot(compact)
  expect(inspectCodexPromptPreparationWait(screen, 'native-steer')).toBe('context-compaction')
  expect(inspectCodexPromptExecution(screen, 'native-steer')).toBe('unavailable')
})
it('distinguishes another temporary native hook wait from ordinary work', async () => {
  const hooks = await snapshot(pane('Running hooks (4s)'))
  expect(inspectCodexPromptPreparationWait(hooks, 'native-steer')).toBe('native-busy')
  expect(inspectCodexPromptExecution(hooks, 'native-steer')).toBe('unavailable')
  const working = await snapshot(pane('Working (4s • esc to interrupt)'))
  expect(inspectCodexPromptPreparationWait(working, 'native-steer')).toBeUndefined()
  expect(inspectCodexPromptExecution(working, 'native-steer')).toBe('interruptible')
})
it.each(['xhigh', 'max'])('keeps running native steer available at %s effort', async effort => {
  const working = await snapshot(pane('Working (4s • esc to interrupt)', '', false, effort))
  expect(inspectCodexPromptExecution(working, 'native-steer')).toBe('interruptible')
  expect(inspectCodexPromptPreparationWait(working, 'native-steer')).toBeUndefined()
  expect(inspectCodexPromptExecution(await snapshot(pane('Ready', '', false, effort)), 'native-steer')).toBe('idle')
})
it('preserves exact temporary wait reasons at max effort without permitting input', async () => {
  const compactMax = await snapshot(compact.replace(' xhigh ·', ' max ·'))
  expect(inspectCodexPromptExecution(compactMax, 'native-steer')).toBe('unavailable')
  expect(inspectCodexPromptPreparationWait(compactMax, 'native-steer')).toBe('context-compaction')
  const hooksMax = await snapshot(pane('Running hooks (4s)', '', false, 'max'))
  expect(inspectCodexPromptExecution(hooksMax, 'native-steer')).toBe('unavailable')
  expect(inspectCodexPromptPreparationWait(hooksMax, 'native-steer')).toBe('native-busy')
})
it.each([
  ['draft', compact.replace('Ask Codex to do anything', '\x1b[0mREAL_DRAFT')],
  ['modal', compact.replace('GPT-6.1-Sol xhigh', '1. Approve request')],
  ['nonadjacent history', compact.replace('[13;', '[10;')],
  ['unknown footer', compact.replace('?\x1b[2m for shortcuts', 'FIND HELP')],
  ['wrapped compact', compact.replace('Compacting context', 'x'.repeat(125) + 'Compacting context')],
  ['unknown detail', compact.replace('Making room to continue.', 'approval required')],
  ['max effort draft', compact.replace(' xhigh ·', ' max ·').replace('Ask Codex to do anything', '\x1b[0mREAL_DRAFT')],
  ['max effort modal', compact.replace(' xhigh ·', ' max ·').replace('GPT-6.1-Sol max', '1. Approve request')],
  ['unknown effort', compact.replace(' xhigh ·', ' unknown ·')]
])('does not offer automatic compact retry for %s', async (_name, bytes) => {
  expect(inspectCodexPromptPreparationWait(await snapshot(bytes), 'native-steer')).toBeUndefined()
})
