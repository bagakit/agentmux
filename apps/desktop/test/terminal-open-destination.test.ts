import { beforeAll, describe, expect, it, vi } from 'vitest'

let terminalLinks: typeof import('../src/renderer/src/components/TerminalView.js')

beforeAll(async () => {
  vi.stubGlobal('self', globalThis)
  vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true)
  terminalLinks = await import('../src/renderer/src/components/TerminalView.js')
})

describe('Terminal link destination entry', () => {
  it('publishes only parsed HTTP links', () => {
    expect(terminalLinks.parseTerminalHttpLink('https://example.com/docs')).toBe('https://example.com/docs')
    expect(terminalLinks.parseTerminalHttpLink('http://localhost:3000')).toBe('http://localhost:3000/')
    expect(terminalLinks.parseTerminalHttpLink('file:///tmp/secret')).toBeNull()
    expect(terminalLinks.parseTerminalHttpLink('javascript:alert(1)')).toBeNull()
    expect(terminalLinks.parseTerminalHttpLink('not a URL')).toBeNull()
  })

  it('does not let an old menu dismissal clear a newer request', () => {
    const current = { id: 12, url: 'https://new.example/', x: 3, y: 4 }

    expect(terminalLinks.dismissTerminalLinkRequest(current, 11)).toBe(current)
    expect(terminalLinks.dismissTerminalLinkRequest(current, 12)).toBeNull()
  })
})
