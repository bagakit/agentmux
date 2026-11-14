import { afterEach, describe, expect, it } from 'vitest'
import { Terminal } from '@xterm/xterm'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { formatAmuxObjectLink, parseAmuxObjectLink } from '@agentmux/core/sharing'
import { terminalLinksAtRow } from '../src/renderer/src/lib/terminal-link-range'

const terminals: Terminal[] = []
afterEach(() => { for (const terminal of terminals.splice(0)) terminal.dispose() })

async function links(text: string, cols = 80, row = 1) {
  const terminal = new Terminal({ cols, rows: 24, allowProposedApi: true })
  terminal.loadAddon(new Unicode11Addon()); terminal.unicode.activeVersion = '11'
  terminals.push(terminal)
  await new Promise<void>(resolve => terminal.write(text, resolve))
  return { result: terminalLinksAtRow(terminal, row, { workspaceRoot: '' }).flatMap(({ range, target }) =>
    target.kind === 'object' || target.kind === 'http' ? [{ range, text: target.url }] : []) }
}

describe('bare object links in published xterm cells', () => {
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
      const { result } = await links(`😀 e\u0301 ${uri}`, 12, row)
      expect(result).toHaveLength(1)
      expect(result[0]).toMatchObject({ text: uri, range: {
        start: { x: 6, y: 1 }, end: { x: (5 + uri.length - 1) % 12 + 1, y: Math.floor((5 + uri.length - 1) / 12) + 1 }
      } })
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
