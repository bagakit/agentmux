import { readFile } from 'node:fs/promises'
import { expect, it } from 'vitest'
import { AgentTerminalScreen } from '../src/agent-terminal-screen.js'
import { AgentProviderRegistry } from '../src/agent-provider.js'
import { fixtureClock, fixtureDisplayPath } from './helpers/fixture-values.js'

// Captured 191x63 bottom pane at the failed preparation's byte boundary.
// Conversation rows are omitted and the cwd is neutralized; native cells,
// attributes, warning alignment, geometry and the empty composer are retained.
const capturedClock = fixtureClock(0, 0)
const capturedWorkspace = fixtureDisplayPath('project')
const capturedWorked = `  Worked for 3m 22s • ${capturedClock}`
const capturedFooter = `  GPT-6.1-Sol max fast · ${capturedWorkspace}`
const captured = (await readFile(new URL('./fixtures/codex-native-fast-footer.ansi.txt', import.meta.url), 'utf8'))
  .replace(/  Worked for 3m 22s • <CAPTURE_CLOCK> +(?=\x1b)/u, capturedWorked.padEnd(191))
  .replace(/  GPT-6.1-Sol max fast · <CAPTURE_WORKSPACE> +(?=\x1b)/u, capturedFooter.padEnd(191))
const provider = new AgentProviderRegistry().get('codex')
async function inspect(bytes = captured) {
  const terminal = new AgentTerminalScreen(191, 63)
  try {
    const dataBytes = Buffer.from(bytes)
    await terminal.write({ startByte: 0, endByte: dataBytes.length, dataBytes })
    const screen = terminal.snapshot()
    expect(screen.cursor).toEqual({ row: 59, column: 2 })
    return {
      immediate: provider.inspectPromptExecution!(screen, 'native-steer'),
      interrupt: provider.inspectPromptExecution!(screen, 'interrupt-before-input'),
      wait: provider.inspectPromptPreparationWait!(screen, 'native-steer')
    }
  } finally { terminal.dispose() }
}

it('recognizes the original complete empty composer with the native Fast footer', async () => {
  expect(await inspect()).toEqual({ immediate: 'idle', interrupt: 'idle', wait: undefined })
})

it.each(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'default'])('preserves idle and busy input at %s effort with native Fast mode', async effort => {
  // Re-pad the captured native row when changing label width; carrying its
  // original padding into a longer label would fabricate a wrapped native row.
  const idle = captured.replace(capturedFooter.padEnd(191), `  GPT-6.1-Sol ${effort} fast · ${capturedWorkspace}`.padEnd(191))
  expect(await inspect(idle)).toEqual({ immediate: 'idle', interrupt: 'idle', wait: undefined })
  expect(await inspect(idle.replace(capturedWorked.padEnd(191), '• Working (3m 22s • esc to interrupt)'.padEnd(191))))
    .toEqual({ immediate: 'interruptible', interrupt: 'interruptible', wait: undefined })
})

it.each([
  ['compaction', 'Compacting context (3s • esc to interrupt)', 'context-compaction'],
  ['native hook wait', 'Running hooks (3s)', 'native-busy']
])('keeps %s unavailable and exposes its existing safe waiting reason with Fast mode', async (_name, status, reason) => {
  const result = await inspect(captured.replace(capturedWorked.padEnd(191), `• ${status}`.padEnd(191)))
  expect(result.immediate).toBe('unavailable')
  expect(result.wait).toBe(reason)
})

it.each([
  ['native draft', captured.replace('\x1b[0m\x1b[60;3H', '\x1b[60;3H\x1b[22mKEEP_NATIVE_DRAFT\x1b[0m\x1b[60;3H')],
  ['current approval', captured.replace('› \x1b[2mAsk Codex to do anything', '1. Allow request')],
  ['unrecognized tier', captured.replace(' max fast ·', ' max eco ·')],
  ['uppercase tier', captured.replace(' max fast ·', ' max FAST ·')],
  ['prefix resembling tier', captured.replace(' max fast ·', ' max faster ·')],
  ['additional modifier', captured.replace(' max fast ·', ' max fast extra ·')],
  ['unknown effort', captured.replace(' max fast ·', ' unknown fast ·')],
  ['modal below composer', captured.replace('\x1b[0m\x1b[60;3H', '\x1b[61;1H1. Choose an answer\x1b[0m\x1b[60;3H')]
])('preserves %s and refuses this operation before input', async (_name, bytes) => {
  const result = await inspect(bytes)
  expect(result.immediate).toBe('unavailable')
  expect(result.interrupt).toBe('unavailable')
  expect(result.wait).toBeUndefined()
})
