import { fixtureClock } from './helpers/fixture-values.js'
import { describe, expect, it } from 'vitest'
import { inspectCodexInteractionTarget } from '../src/providers/codex-interaction-target.js'
import type { AgentMuxPermissionRequest, AgentTerminalScreenSnapshot } from '../src/types.js'

const command = 'sleep 0.2; printf PRIVATE_PERMISSION_PROBE'
const request: AgentMuxPermissionRequest = {
  kind: 'permission', id: 'request', agentSessionId: 'agent', title: 'approval',
  nativeToolCallId: 'private_approval_call_2', toolName: 'Bash',
  toolInput: JSON.stringify({ command, description: 'Private recovery fixture approval' }),
  options: [{ id: 'allow-once', label: 'Allow once', kind: 'allow-once' }],
  evidence: { source: 'native-hook', observedAt: 1, run: { runId: 'run' }, hookReceiptId: 'hook' }
}

// Text/wrap/cursor projection of the actual 80×24 frame from the retained capture.
// Its physical cursor remained on Running, while the native menu selected row 19.
function actualFrame(): AgentTerminalScreenSnapshot {
  const rows = Array<string>(24).fill('')
  rows[1] = ("  Worked for <1s • " + (fixtureClock(23, 23)))
  rows[4] = '› PRIVATE_PERMISSION_SETUP'
  rows[7] = `• Running ${command}`
  rows[10] = '  Would you like to run the following command?'
  rows[12] = '  Environment: local'
  rows[14] = '  Reason: Private recovery fixture approval'
  rows[16] = `  $ ${command}`
  rows[19] = '› 1. Yes, proceed (y)'
  rows[20] = "  2. Yes, and don't ask again for commands that start with `sleep 0.2` (p)"
  rows[21] = '  3. No, and tell Codex what to do differently (esc)'
  rows[23] = '  Press enter to confirm or esc to cancel'
  return { cols: 80, rows: 24, cursor: { row: 7, column: 1 },
    lines: rows.map(text => ({ text, wrapped: false, cells: [] })) }
}

describe('Codex logical permission target', () => {
  it('accepts the actual selected menu while the physical cursor remains on prior output', () => {
    expect(inspectCodexInteractionTarget(actualFrame(), request)).toBe(true)
  })

  it('also recognizes the retained 120×40 complete menu and footer cursor shape', () => {
    const narrow = actualFrame(), screen: AgentTerminalScreenSnapshot = {
      cols: 120, rows: 40, cursor: { row: 36, column: 120 },
      lines: Array.from({ length: 40 }, () => ({ text: '', wrapped: false, cells: [] }))
    }
    for (const [from, to] of [[10, 23], [12, 25], [14, 27], [16, 29], [19, 32], [20, 33], [21, 34], [23, 36]]) {
      screen.lines[to!] = { ...narrow.lines[from!]! }
    }
    // A retained capture used this shorter command and persistent option.
    screen.lines[29]!.text = '  $ printf PRIVATE_PERMISSION_PROBE'
    screen.lines[33]!.text = "  2. Yes, and don't ask again for commands that start with `printf PRIVATE_PERMISSION_PROBE` (p)"
    expect(inspectCodexInteractionTarget(screen, { ...request,
      toolInput: JSON.stringify({ command: 'printf PRIVATE_PERMISSION_PROBE' }) })).toBe(true)
  })

  it.each([20, 21])('recognizes a single native selected option on row %i', row => {
    const screen = actualFrame()
    screen.lines[19]!.text = '  1. Yes, proceed (y)'
    screen.lines[row]!.text = '› ' + screen.lines[row]!.text.trimStart()
    expect(inspectCodexInteractionTarget(screen, request)).toBe(true)
  })

  it('recognizes the native two-option menu', () => {
    const screen = actualFrame()
    screen.lines[20]!.text = ''
    screen.lines[21]!.text = '  2. No, and tell Codex what to do differently (esc)'
    expect(inspectCodexInteractionTarget(screen, request)).toBe(true)
  })

  it.each(['no-marker', 'two-markers', 'wrong-command', 'second-command', 'missing-footer',
    'duplicate-footer', 'duplicate-header', 'ordinary-composer', 'unknown-tail', 'unknown-option',
    'wrong-option-order', 'missing-reject', 'malformed-marker', 'foreign-marker', 'wrapped-command', 'wrapped-option',
    'wrapped-footer', 'truncated'] as const)('refuses %s without granting input from text or cursor alone', kind => {
    const screen = actualFrame()
    // A footer cursor is deliberately insufficient when logical target evidence is absent.
    screen.cursor.row = 23
    if (kind === 'no-marker') screen.lines[19]!.text = '  1. Yes, proceed (y)'
    if (kind === 'two-markers') screen.lines[21]!.text = '› 3. No, and tell Codex what to do differently (esc)'
    if (kind === 'wrong-command') screen.lines[16]!.text = '  $ printf OTHER'
    if (kind === 'second-command') screen.lines[17]!.text = '  $ printf OTHER'
    if (kind === 'missing-footer') screen.lines[23]!.text = ''
    if (kind === 'duplicate-footer') screen.lines[8]!.text = screen.lines[23]!.text
    if (kind === 'duplicate-header') screen.lines[8]!.text = screen.lines[10]!.text
    if (kind === 'ordinary-composer') {
      screen.lines[23]!.text = ''
      screen.lines[22]!.text = '› Ask a question'
    }
    if (kind === 'unknown-tail') {
      screen.lines[22]!.text = screen.lines[23]!.text
      screen.lines[23]!.text = '› New ordinary prompt'
    }
    if (kind === 'unknown-option') screen.lines[20]!.text = '  2. Unknown action (p)'
    if (kind === 'wrong-option-order') screen.lines[21]!.text = '  4. No, and tell Codex what to do differently (esc)'
    if (kind === 'missing-reject') screen.lines[21]!.text = ''
    if (kind === 'malformed-marker') screen.lines[19]!.text = '›› 1. Yes, proceed (y)'
    if (kind === 'foreign-marker') screen.lines[17]!.text = '› Other interactive target'
    if (kind === 'wrapped-command') screen.lines[16]!.wrapped = true
    if (kind === 'wrapped-option') screen.lines[20]!.wrapped = true
    if (kind === 'wrapped-footer') screen.lines[23]!.wrapped = true
    if (kind === 'truncated') screen.lines.pop()
    expect(inspectCodexInteractionTarget(screen, request)).toBe(false)
  })

  it.each(['missing', 'multiline', 'malformed'] as const)('refuses %s request command', kind => {
    const input = kind === 'missing' ? '{}' : kind === 'malformed' ? '{' : JSON.stringify({ command: command + '\nother' })
    expect(inspectCodexInteractionTarget(actualFrame(), { ...request, toolInput: input })).toBe(false)
  })
})
