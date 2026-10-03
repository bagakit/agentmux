import { fixturePath as upstreamFixturePath, fixtureDisplayPath as upstreamFixtureDisplayPath } from './helpers/fixture-values.js'
import { describe, expect, it } from 'vitest'
import { AgentTerminalScreen } from '../src/agent-terminal-screen.js'
import { inspectCodexPromptExecution } from '../src/providers/codex-prompt-execution.js'

// Complete native bottom pane: a status line, empty composer, custom status footer,
// then Codex's own queue/shortcut hint. These are output bytes, not fabricated cells.
const busy = '\x1b[13;1H• Working (10s • esc to interrupt)'
const composer = '\x1b[16;1H› \x1b[2mAsk Codex to do anything\x1b[22m'
const status = ("\u001b[18;1HGPT-6.1-Sol xhigh · " + (upstreamFixtureDisplayPath("project")) + " · Main [default]")
const queueHint = '\x1b[19;1H\x1b[1mtab\x1b[22m\x1b[2m to queue message\x1b[22m'
const body = busy + composer + status

async function inspect(output: string) {
  const terminal = new AgentTerminalScreen(120, 40)
  try {
    const bytes = Buffer.from(`\x1b[?2026h\x1b[2J${output}\x1b[16;3H\x1b[?2026l`)
    await terminal.write({ startByte: 0, endByte: bytes.length, dataBytes: bytes })
    return inspectCodexPromptExecution(terminal.snapshot())
  } finally {
    terminal.dispose()
  }
}

describe('Codex native footer with an empty composer', () => {
  it('accepts the native queue shortcut below a custom status footer', async () => {
    expect(await inspect(body + queueHint)).toBe('interruptible')
  })

  it('accepts the abbreviated native queue shortcut', async () => {
    expect(await inspect(body + queueHint.replace(' to queue message', ' to queue'))).toBe('interruptible')
  })

  it('accepts the native idle shortcuts below a custom status footer', async () => {
    const idle = body.replace(busy, '\x1b[13;1HReady')
    expect(await inspect(idle + '\x1b[19;1H\x1b[1m?\x1b[22m\x1b[2m for shortcuts\x1b[22m')).toBe('idle')
  })

  it('preserves a one-line native footer', async () => {
    expect(await inspect(body)).toBe('interruptible')
  })

  it.each([
    ['a native draft after the cursor', body + queueHint + '\x1b[16;3H\x1b[22mKEEP_NATIVE_DRAFT'],
    ['a multiline native draft', body + queueHint + '\x1b[17;1HKEEP_NATIVE_DRAFT'],
    ['native queued messages', body + queueHint + '\x1b[14;1H• Messages to be submitted after next tool call\x1b[15;1H  ↳ KEEP_NATIVE_QUEUE'],
    ['a native approval', body + queueHint + '\x1b[17;1H1. Approve request'],
    ['an unknown extra footer', body + '\x1b[19;1HKEEP_UNKNOWN_FOOTER'],
    ['an extra row after the queue hint', body + queueHint + '\x1b[20;1HKEEP_UNKNOWN_FOOTER'],
    ['duplicate queue hints', body + queueHint + '\x1b[20;1H\x1b[1mtab\x1b[22m\x1b[2m to queue message\x1b[22m'],
    ['a non-adjacent queue hint', body + queueHint.replace('[19;1H', '[20;1H')],
    ['an unknown queue key', body + queueHint.replace('tab', 'f12')],
    ['ordinary text resembling a native hint', body + '\x1b[19;1Htab to queue message'],
    ['a duplicate shortcuts footer', body.replace(status, '\x1b[18;1H? for shortcuts') + '\x1b[19;1H\x1b[2m? for shortcuts\x1b[22m'],
    ['a remapped interruption key', body.replace('esc to interrupt', 'f12 to interrupt') + queueHint],
    ['a clipped busy group', body.replace('[13;1H', '[1;1H') + queueHint]
  ])('keeps %s unavailable', async (_name, output) => {
    expect(await inspect(output)).toBe('unavailable')
  })
})
