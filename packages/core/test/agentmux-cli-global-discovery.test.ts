import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { agentMuxCommandHelp, AGENTMUX_CLI_HELP } from '../src/agentmux-cli-help.js'

describe('PMO Teams CLI discovery surface', () => {
  it('documents bounded global observations and every drill-down', () => {
    const expected = ['snapshot', 'projects', 'workspaces', 'topics', 'agents', 'sessions', 'demands', 'activity', 'inspect']
    expect(AGENTMUX_CLI_HELP).toContain('pmo')
    const help = agentMuxCommandHelp('pmo')
    expect(help).toBeTruthy()
    for (const action of expected) expect(help).toContain(action)
    expect(help).toContain('TOPIC_FILESYSTEM_SCOPE_REQUIRED')
  })

  it('keeps the documented surface connected to the executable dispatcher', async () => {
    const source = await readFile(fileURLToPath(new URL('../src/agentmux.ts', import.meta.url)), 'utf8')
    const anchors = ['async function pmoCommand', "if (args[0] === 'pmo') return await pmoCommand"]
    for (const anchor of anchors) expect(source).toContain(anchor)
    const dispatcher = source.slice(source.indexOf("if (args[0] === 'pmo')"))
    expect(dispatcher).toContain('pmoCommand')
    expect(dispatcher.length).toBeGreaterThan('pmoCommand'.length)
  })
})
