import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { agentRosterMenuActions } from '../src/renderer/src/lib/agent-roster-menu'
import { terminalIdentityMenuActions } from '../src/renderer/src/lib/terminal-identity-menu'
import { formatRegionAddress, formatSessionAddress, formatTabAddress } from '../src/renderer/src/lib/agent-address'

function sourceFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap(entry => {
    const path = join(root, entry.name)
    return entry.isDirectory() ? sourceFiles(path) : /\.tsx?$/.test(path) ? [path] : []
  })
}
describe('first-party menus share typed object links', () => {
  it.each(['roster', 'terminal'] as const)('copies one stable semantic link from %s', async surface => {
    const copied: string[] = [], input = { sessionId: 'sid/target', writeClipboardText: async (text: string) => { copied.push(text) } }
    const actions = surface === 'roster' ? agentRosterMenuActions(input) : terminalIdentityMenuActions({ ...input, sessionKind: 'agent' })
    expect(actions.map(action => action.key)).toEqual(['copy-session'])
    await actions[0]!.onSelect()
    expect(copied).toEqual(['amux://agent/sid%2Ftarget'])
  })
  it('keeps spatial Region/Tab identities separate from semantic Agent identity', () => {
    expect(formatRegionAddress('r')).toBe('amux://region/r')
    expect(formatTabAddress('t')).toBe('amux://tab/t')
    expect(formatSessionAddress('s')).toBe('amux://agent/s')
  })
  it('finds actual product consumers outside the formatter definition', () => {
    const root = new URL('../src/renderer/src/', import.meta.url).pathname
    const found = new Set(sourceFiles(root).filter(path => !path.endsWith('/agent-address.ts') &&
      /\bformat(?:Session|Messaging|Region|Tab)Address\s*\(/.test(readFileSync(path, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, ''))))
    expect(found.size).toBeGreaterThan(0)
    expect([...found].filter(path => path.endsWith('.tsx')).length).toBeGreaterThan(0)
  })
})
