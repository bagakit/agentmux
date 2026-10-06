import { fixtureClock, fixtureDisplayPath, fixturePath } from './helpers/fixture-values.js'
import { describe, expect, it } from 'vitest'
import { AgentTerminalScreen } from '../src/agent-terminal-screen.js'
import { AgentProviderRegistry } from '../src/agent-provider.js'
import { inspectCodexPromptExecution } from '../src/providers/codex-prompt-execution.js'

// Complete native bottom pane: a status line, empty composer, custom status footer,
// then Codex's own queue/shortcut hint. These are output bytes, not fabricated cells.
const busy = '\x1b[13;1H• Working (10s • esc to interrupt)'
const composer = '\x1b[16;1H› \x1b[2mAsk Codex to do anything\x1b[22m'
const status = ("\u001b[18;1HGPT-6.1-Sol xhigh · " + (fixtureDisplayPath("project")) + " · Main [default]")
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

// Captured 0.160.1 bottom pane at 80x24. Preserve the native ANSI and columns;
// the status path is replaced so this fixture contains no conversation history.
const warningComposer = '\x1b[21;1H\x1b[1m›\x1b[21;3H\x1b[22m\x1b[2mAsk Codex to do anything\x1b[22m'
const warningStatus = '\x1b[23;3H\x1b[38;2;246;226;183;49mGPT-6.1-Sol xhigh\x1b[23;21H\x1b[39;49m·\x1b[23;23H\x1b[38;2;171;223;167;49m/private/project'
const warningHint = '\x1b[24;3H\x1b[22m\x1b[1m?\x1b[22m for shortcuts' +
  '\x1b[24;55H\x1b[39;49m⚠\x1b[24;57H\x1b[38;2;196;167;103;49m4 warnings' +
  '\x1b[24;68H\x1b[39;49m·\x1b[24;70H\x1b[1mf2\x1b[24;73H\x1b[22mto\x1b[24;76Hview'
const warningBody = ("\u001b[18;1H\u001b[2m  Worked for 9s • " + (fixtureClock(1, 9)) + "\u001b[22m") + warningComposer + warningStatus

async function inspectWarning(output: string, cols = 80, rows = 24) {
  const terminal = new AgentTerminalScreen(cols, rows)
  try {
    const bytes = Buffer.from(`\x1b[?2026h\x1b[2J${output}\x1b[0m\x1b[21;3H\x1b[?2026l`)
    await terminal.write({ startByte: 0, endByte: bytes.length, dataBytes: bytes })
    return inspectCodexPromptExecution(terminal.snapshot())
  } finally { terminal.dispose() }
}

describe('captured native warning footer', () => {
  it('accepts the complete native idle pane with its non-dim warning hint', async () => {
    expect(await inspectWarning(warningBody + warningHint)).toBe('idle')
  })
  it('accepts the native busy pane without changing its interruption choice', async () => {
    const output = warningBody.replace(("  Worked for 9s • " + (fixtureClock(1, 9))), '• Working (9s • esc to interrupt)')
    expect(await inspectWarning(output + warningHint)).toBe('interruptible')
  })
  it('uses the actual edges rather than hard-coding the captured dimensions', async () => {
    const wideHint = warningHint.replaceAll('[24;', '[30;').replace('[30;55H', '[30;95H')
      .replace('[30;57H', '[30;97H').replace('[30;68H', '[30;108H')
      .replace('[30;70H', '[30;110H').replace('[30;73H', '[30;113H').replace('[30;76H', '[30;116H')
    expect(await inspectWarning(warningBody.replaceAll('[23;', '[29;') + wideHint, 120, 30)).toBe('idle')
  })
  it('does not treat a historical warning line as the composer footer', async () => {
    expect(await inspectWarning(warningBody + warningHint.replaceAll('[24;', '[17;'))).toBe('idle')
  })
  it.each([
    ['wrong shortcut key', warningHint.replace('1m?', '1mf')],
    ['wrong warning key', warningHint.replace('1mf2', '1mf3')],
    ['unknown count', warningHint.replace('4 warnings', '? warnings')],
    ['zero warnings', warningHint.replace('4 warnings', '0 warnings')],
    ['left edge shifted', warningHint.replace('[24;3H', '[24;4H')],
    ['right edge clipped', warningHint.replace('[24;76Hview', '[24;77Hview')],
    ['right edge shifted', warningHint.replace('[24;76Hview', '[24;75Hview')],
    ['unexpected label', warningHint.replace('for shortcuts', 'for approvals')],
    ['extra footer text', warningHint + '\x1b[24;30HKEEP_UNKNOWN'],
    ['wrong footer row', warningHint.replaceAll('[24;', '[22;')],
    ['a duplicate native shortcut', warningHint + '\x1b[23;1H\x1b[2K? for shortcuts'],
    ['unknown second footer', '\x1b[24;3HKEEP_UNKNOWN'],
    ['a draft after the cursor', warningHint + '\x1b[21;3H\x1b[22mKEEP_NATIVE_DRAFT'],
    ['native pending input', warningHint + '\x1b[19;1H• Messages to be submitted after next tool call\x1b[20;1H  ↳ KEEP_NATIVE_QUEUE'],
    ['an approval instead of the empty composer', warningHint + '\x1b[21;1H1. Approve request'],
    ['dim warning text unlike the captured native pane', warningHint.replace('4 warnings', '\x1b[2m4 warnings\x1b[22m')]
  ])('keeps %s unavailable', async (_name, hint) => {
    expect(await inspectWarning(warningBody + hint)).toBe('unavailable')
  })
})

// Observed current native pane: a model/status footer and only the right warning
// badge. Keep the geometry and ANSI attributes, without recording user history.
describe('native warnings-only final row', () => {
  const provider = new AgentProviderRegistry().get('codex')
  async function inspectOnly(options: {
    cols?: number, rows?: number, hint?: string, warningRow?: number,
    warningColumn?: number, before?: string, after?: string, dim?: boolean
  } = {}) {
    const cols = options.cols ?? 233, rows = options.rows ?? 75
    const composerRow = rows - 3, statusRow = rows - 1
    const hint = options.hint ?? '⚠ 4 warnings · f2 to view'
    const terminal = new AgentTerminalScreen(cols, rows)
    try {
      const output = `\x1b[?2026h\x1b[2J\x1b[${composerRow - 3};1H\x1b[2m  Worked for 45s • ${fixtureClock(14, 26)}\x1b[22m` +
        `\x1b[${composerRow};1H› \x1b[2mAsk Codex to do anything\x1b[22m` +
        `\x1b[${statusRow};3HGPT-6.1-Sol xhigh · ${fixtureDisplayPath("project")} · Main` +
        (options.before ?? '') +
        `\x1b[${options.warningRow ?? rows};${options.warningColumn ?? cols - hint.length}H` +
        (options.dim ? '\x1b[2m' : '\x1b[22m') + hint + '\x1b[22m' +
        (options.after ?? '') + `\x1b[${composerRow};3H\x1b[?2026l`
      const bytes = Buffer.from(output)
      await terminal.write({ startByte: 0, endByte: bytes.length, dataBytes: bytes })
      expect(provider.catalog.capabilities.promptExecution?.immediate).toBe('terminal-submit')
      return provider.inspectPromptExecution!(terminal.snapshot(), 'interrupt-before-input')
    } finally { terminal.dispose() }
  }

  it('accepts the complete current right-aligned warnings-only native pane', async () => {
    expect(await inspectOnly()).toBe('idle')
  })
  it('uses the actual viewport edges for the singular warning badge', async () => {
    expect(await inspectOnly({ cols: 100, rows: 30, hint: '⚠ 1 warning · f2 to view' })).toBe('idle')
  })
  it.each([
    ['dim badge', { dim: true }],
    ['shifted badge', { warningColumn: 207 }],
    ['clipped badge', { warningColumn: 210 }],
    ['wrong final row', { warningRow: 74, before: ("\u001b[74;1H\u001b[2K\u001b[73;3HGPT-6.1-Sol xhigh · " + (fixtureDisplayPath("project"))) }],
    ['zero warnings', { hint: '⚠ 0 warnings · f2 to view' }],
    ['unknown count', { hint: '⚠ ? warnings · f2 to view' }],
    ['unknown key', { hint: '⚠ 4 warnings · f3 to view' }],
    ['truncated label', { hint: '⚠ 4 warnings · f2 to vie' }],
    ['duplicate badge', { before: '\x1b[75;3H⚠ 4 warnings · f2 to view' }],
    ['extra tail text', { after: '\x1b[75;3HKEEP_UNKNOWN' }],
    ['wrapped badge', { warningColumn: 225 }],
    ['actual draft after cursor', { after: '\x1b[72;3HKEEP_NATIVE_DRAFT' }],
    ['approval instead of empty composer', { after: '\x1b[72;1H1. Approve request' }],
    ['question between composer and footer', { before: '\x1b[73;1H1. Choose an answer' }]
  ])('keeps %s unavailable', async (_name, options) => {
    expect(await inspectOnly(options)).toBe('unavailable')
  })
})
