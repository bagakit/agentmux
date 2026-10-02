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
function commandLines(text: string): string[] {
  return text.split('\n').filter(line => line.startsWith('# '))
}
describe('first-party cards use the same object CLI', () => {
  it.each(['roster', 'terminal'] as const)('copies real %s menu actions with canonical Session commands', async surface => {
    const copied: string[] = [], input = { sessionId: "sid'quote", writeClipboardText: async (text: string) => { copied.push(text) } }
    const actions = surface === 'roster' ? agentRosterMenuActions(input) : terminalIdentityMenuActions({ ...input, sessionKind: 'agent' })
    expect(actions.map(action => action.key)).toEqual(['message', 'copy-session'])
    for (const action of actions) await action.onSelect()
    expect(copied).toHaveLength(2)
    expect(copied[0]).toBe(copied[1])
    expect(copied[0]).toBe([
      '--- amux : IDCard ---',
      "ID: sid'quote",
      'Exe: ? | ? (?)',
      `# amux agent send --to-session='sid'"'"'quote' --text "..."`,
      '# amux --skill',
      '-----'
    ].join('\n'))
    expect(commandLines(copied[0]!)).toHaveLength(2)
    expect(copied[0]).not.toContain('--region')
  })
  it('keeps physical Tab/Region inspection distinct from semantic Session messaging', () => {
    expect(commandLines(formatRegionAddress('r'))).toEqual([
      "# amux space inspect --region='r'",
      '# amux --skill'
    ])
    expect(commandLines(formatTabAddress('t'))).toEqual([
      "# amux space inspect --tab='t'",
      '# amux --skill'
    ])
    expect(commandLines(formatSessionAddress('s'))).toEqual([
      '# amux agent send --to-session=\'s\' --text "..."',
      '# amux --skill'
    ])
  })
  it('copies exact known Region context without inventing inspection, navigation or move commands', () => {
    const text = formatMessagingAddress({ agentSessionId: 's', regionId: 'r' })
    expect(text).toBe([
      '--- amux : IDCard ---',
      'ID: s',
      'Exe: ? | ? (?)',
      'Region: r',
      '# amux agent send --to-session=\'s\' --text "..."',
      '# amux --skill',
      '-----'
    ].join('\n'))
    expect(commandLines(text)).toHaveLength(2)
  })
  it('finds actual product consumers outside the formatter definition', () => {
    const root = new URL('../src/renderer/src/', import.meta.url).pathname
    const found = new Set(sourceFiles(root).filter(path => !path.endsWith('/agent-address.ts') &&
      /\bformat(?:Session|Messaging|Region|Tab)Address\s*\(/.test(readFileSync(path, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, ''))))
    expect(found.size).toBeGreaterThan(0)
    expect([...found].filter(path => path.endsWith('.tsx')).length).toBeGreaterThan(0)
  })
})
