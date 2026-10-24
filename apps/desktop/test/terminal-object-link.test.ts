import { afterEach, describe, expect, it, vi } from 'vitest'
import { Terminal, type ILink, type ILinkProvider } from '@xterm/xterm'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { formatAmuxObjectLink, parseAmuxObjectLink } from '@agentmux/core/sharing'
import { TERMINAL_LINK_URL_REGEX } from '../src/renderer/src/lib/terminal-http-link'

const terminals: Terminal[] = []
afterEach(() => { for (const terminal of terminals.splice(0)) terminal.dispose() })

async function links(text: string, cols = 80, row = 1) {
  const terminal = new Terminal({ cols, rows: 24, allowProposedApi: true })
  terminal.loadAddon(new Unicode11Addon()); terminal.unicode.activeVersion = '11'
  terminals.push(terminal)
  await new Promise<void>(resolve => terminal.write(text, resolve))
  let provider: ILinkProvider | undefined
  const activate = vi.fn()
  // Published addon and real parser/cells; only capture its public registration.
  const addon = new WebLinksAddon(activate, { urlRegex: TERMINAL_LINK_URL_REGEX })
  addon.activate({ buffer: terminal.buffer, cols, registerLinkProvider(value: ILinkProvider) {
    provider = value
    return { dispose() {} }
  } } as Terminal)
  let result: ILink[] | undefined
  provider!.provideLinks(row, value => { result = value })
  addon.dispose()
  return { terminal, activate, result: result ?? [] }
}

describe('published xterm bare object-link provider', () => {
  it('recognizes each original object kind and keeps its encoded identity intact', async () => {
    const targets = [
      { kind: 'agent', agentSessionId: 'original/SID 中文' },
      { kind: 'region', regionId: 'original:region' },
      { kind: 'tab', tabId: 'original-tab' },
      { kind: 'space', spaceId: 'original space' },
      { kind: 'zone', zoneId: 'original-zone' },
      { kind: 'capsule', capsuleId: "original')!" }
    ] as const
    for (const target of targets) {
      const uri = formatAmuxObjectLink(target)
      const { result } = await links(`说明 ${uri}。继续`, 160)
      expect(result.map(link => link.text)).toEqual([uri])
      expect(parseAmuxObjectLink(result[0]!.text)).toEqual(target)
      expect(result[0]!.range).toEqual({ start: { x: 6, y: 1 }, end: { x: 5 + uri.length, y: 1 } })
    }
  })

  it('uses actual Unicode and soft-wrap cell ranges from either row', async () => {
    const uri = 'amux://agent/original%20SID'
    for (const row of [1, 2, 3]) {
      const { result, activate } = await links(`😀 e\u0301 ${uri}`, 12, row)
      expect(result).toHaveLength(1)
      expect(result[0]).toMatchObject({ text: uri, range: {
        start: { x: 6, y: 1 }, end: { x: (5 + uri.length - 1) % 12 + 1, y: Math.floor((5 + uri.length - 1) / 12) + 1 }
      } })
      const click = {} as MouseEvent
      result[0]!.activate(click, result[0]!.text)
      expect(activate).toHaveBeenCalledExactlyOnceWith(click, uri)
    }
  })

  it('retains invalid object candidates for an explicit original-owner error instead of guessing another ID', async () => {
    for (const uri of ['amux://agent/original?command=stop', 'amux://agent/original#part', 'amux://unknown/original', 'amux://agent/%2f']) {
      const { result } = await links(uri)
      expect(result.map(link => link.text)).toEqual([uri])
      expect(() => parseAmuxObjectLink(result[0]!.text)).toThrow()
    }
  })

  it('does not split a URI embedded in another target or detect unrelated schemes', async () => {
    const uri = 'https://example.test/amux://agent/original'
    const { result } = await links(`${uri} xamux://agent/other javascript:alert(1) customapp://target`, 160)
    expect(result.map(link => link.text)).toEqual([uri])
  })
})
