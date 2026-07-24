import { describe, expect, it } from 'vitest'
import { AgentTerminalScreen } from '../src/agent-terminal-screen.js'

const encoder = new TextEncoder()

async function write(screen: AgentTerminalScreen, data: string): Promise<void> {
  const dataBytes = encoder.encode(data)
  await screen.write({
    startByte: screen.throughByte,
    endByte: screen.throughByte + dataBytes.byteLength,
    dataBytes
  })
}

describe('AgentTerminalScreen', () => {
  it('tracks the active composer across partial synchronized updates', async () => {
    const screen = new AgentTerminalScreen(80, 24)
    try {
      await write(screen, '\u001b[22;1H› \u001b[22;3H')
      expect(screen.composerText('›')).toBe('')

      await write(screen, '\u001b[?2026h\u001b[22;3H/exit\u001b[22;8H\u001b[?2026l')
      expect(screen.composerText('›')).toBe('/exit')
    } finally {
      screen.dispose()
    }
  })

  it('does not confuse assistant text or a full-screen historical redraw with composer input', async () => {
    const screen = new AgentTerminalScreen(80, 24)
    try {
      await write(screen, '\u001b[5;1H› assistant repeated /exit\u001b[22;1Hstatus\u001b[22;7H')
      expect(screen.composerText('›')).toBeNull()

      await write(screen, '\u001b[2J\u001b[5;1Hassistant repeated /exit\u001b[22;1H› \u001b[22;3H')
      expect(screen.composerText('›')).toBe('')
    } finally {
      screen.dispose()
    }
  })

  it('fails closed on a missing or overlapping byte range', async () => {
    const screen = new AgentTerminalScreen(80, 24)
    try {
      await write(screen, 'ok')
      await expect(screen.write({
        startByte: 3,
        endByte: 4,
        dataBytes: encoder.encode('x')
      })).rejects.toMatchObject({ code: 'OUTPUT_GAP' })
      await expect(screen.write({
        startByte: 1,
        endByte: 3,
        dataBytes: encoder.encode('xy')
      })).rejects.toMatchObject({ code: 'OUTPUT_GAP' })
      await expect(screen.write({
        startByte: 0,
        endByte: 2,
        dataBytes: encoder.encode('ok')
      })).rejects.toMatchObject({ code: 'OUTPUT_GAP' })
    } finally {
      screen.dispose()
    }
  })
})
