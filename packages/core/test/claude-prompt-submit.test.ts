import { describe, expect, it } from 'vitest'
import { AgentTerminalScreen } from '../src/agent-terminal-screen.js'
import { AgentProviderRegistry } from '../src/agent-provider.js'

const ESC = '\u001b'
const RECORDED_READY = ESC + '[?2026h' + ESC + '[22;1H❯\u00a0' + ESC + '[22;3H' + ESC + '[?25h' + ESC + '[?2026l'
const RECORDED_TYPED = ESC + '[?2026h' + ESC + '[22;3Hhello Claude' + ESC + '[K' + ESC + '[?25h' + ESC + '[?2026l'

async function feed(screen: AgentTerminalScreen, data: string): Promise<void> {
  const bytes = new TextEncoder().encode(data)
  await screen.write({ startByte: screen.throughByte, endByte: screen.throughByte + bytes.byteLength, dataBytes: bytes })
}

describe('Claude recorded PTY prompt submission contract', () => {
  it('matches the live composer marker and verifies the rendered text before Enter', async () => {
    const provider = new AgentProviderRegistry().get('claude')
    expect(provider.terminalPromptRender).toEqual({
      frameStart: ESC + '[?2026h',
      activeComposer: '❯',
      frameEnd: ESC + '[?2026l'
    })
    const plan = provider.planPromptInput('hello Claude')
    expect(plan).toEqual({
      kind: 'render-then-submit',
      payload: 'hello Claude',
      renderedText: 'hello Claude',
      submit: '\r'
    })
    const screen = new AgentTerminalScreen(80, 24)
    try {
      await feed(screen, RECORDED_READY)
      expect(screen.composerText(provider.terminalPromptRender!.activeComposer)).toBe('')
      await feed(screen, RECORDED_TYPED)
      expect(plan.kind).toBe('render-then-submit')
      if (plan.kind !== 'render-then-submit') return
      expect(screen.composerText(provider.terminalPromptRender!.activeComposer)).toBe(plan.renderedText)
    } finally {
      screen.dispose()
    }
  })

  it('uses bracketed paste for multiline input while keeping Enter a distinct submit phase', () => {
    const plan = new AgentProviderRegistry().get('claude').planPromptInput('one\ntwo')
    expect(plan).toMatchObject({
      kind: 'render-then-submit',
      renderedText: 'one\ntwo',
      submit: '\r'
    })
    if (plan.kind !== 'render-then-submit') return
    expect(plan.payload).toContain(ESC + '[200~')
    expect(plan.payload).toContain(ESC + '[201~')
    expect(plan.payload).not.toBe(plan.renderedText + '\r')
  })
})
