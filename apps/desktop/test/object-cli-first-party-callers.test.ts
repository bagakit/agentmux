import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { agentRosterMenuActions } from '../src/renderer/src/lib/agent-roster-menu'
import { terminalIdentityMenuActions } from '../src/renderer/src/lib/terminal-identity-menu'
import { formatMessagingAddress, formatRegionAddress, formatSessionAddress, formatTabAddress } from '../src/renderer/src/lib/agent-address'

function sourceFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap(entry => {
    const path = join(root, entry.name)
    return entry.isDirectory() ? sourceFiles(path) : /\.tsx?$/.test(path) ? [path] : []
  })
}
describe('first-party cards use the same object CLI', () => {
  it.each(['roster', 'terminal'] as const)('copies real %s menu actions with canonical Session commands', async surface => {
    const copied: string[] = [], input = { sessionId: "sid'quote", writeClipboardText: async (text: string) => { copied.push(text) } }
    const actions = surface === 'roster' ? agentRosterMenuActions(input) : terminalIdentityMenuActions({ ...input, sessionKind: 'agent' })
    expect(actions.map(action => action.key)).toEqual(['message', 'copy-session'])
    for (const action of actions) await action.onSelect()
    expect(copied).toHaveLength(2)
    expect(copied[0]).toBe(copied[1])
    expect(copied[0]).toContain(`agentmux agent send --to-session='sid'"'"'quote' --text "..."`)
    expect(copied[0]).toContain(`agentmux agent inspect --session='sid'"'"'quote'`)
    expect(copied[0]).not.toContain('--region')
  })
  it('keeps physical Tab/Region inspection distinct from semantic Session inspection', () => {
    expect(formatRegionAddress('r')).toContain("agentmux space inspect --region='r'")
    expect(formatTabAddress('t')).toContain("agentmux space inspect --tab='t'")
    expect(formatSessionAddress('s')).toContain("agentmux agent inspect --session='s'")
  })
  it('copies exact known placement, navigation and a clearly labeled move template', () => {
    const text = formatMessagingAddress({ agentSessionId: 's', regionId: 'r' })
    expect(text).toContain("agentmux agent send --to-session='s'")
    expect(text).toContain("agentmux space inspect --region='r'")
    expect(text).toContain("agentmux space focus --region='r'")
    expect(text).toContain("模板：agentmux space mv --from-region='r' --expect-session='s' --zone='<zone-id>' --new-tab")
  })
  it('finds actual product consumers outside the formatter definition', () => {
    const root = new URL('../src/renderer/src/', import.meta.url).pathname
    const found = new Set(sourceFiles(root).filter(path => !path.endsWith('/agent-address.ts') &&
      /\bformat(?:Session|Messaging|Region|Tab)Address\s*\(/.test(readFileSync(path, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, ''))))
    expect(found.size).toBeGreaterThan(0)
    expect([...found].filter(path => path.endsWith('.tsx')).length).toBeGreaterThan(0)
  })
})
