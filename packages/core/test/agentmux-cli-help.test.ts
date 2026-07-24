import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'

const execFileAsync = promisify(execFile)
const cli = fileURLToPath(new URL('../bin/agentmux', import.meta.url))

async function run(args: readonly string[]): Promise<string> {
  const result = await execFileAsync(cli, args, {
    timeout: 5_000,
    maxBuffer: 512 * 1024
  })
  return result.stdout
}

describe('agentmux CLI discovery', () => {
  it('explains the product, command groups, managed context, and JSON receipts', async () => {
    const help = await run(['--help'])

    expect(help).toContain('control local coding-agent sessions through AgentMux and CtxMux')
    expect(help).toContain('Inspect:')
    expect(help).toContain('Control:')
    expect(help).toContain('Desktop:')
    expect(help).toContain('AGENTMUX_AGENT_SESSION_ID')
    expect(help).toContain('Use --json for machine-readable results')
    expect(help).toContain('agentmux --skill')
  })

  it('gives command-specific success and next-action guidance without contacting a runtime', async () => {
    const send = await run(['send', '--help'])
    const switchView = await run(['switch', 'agent-session', 'ignored', '--help'])

    expect(send).toContain('Success means AgentMux atomically submitted the prompt')
    expect(send).toContain('literal values such as --help')
    expect(send).toContain('next: agentmux attach')
    expect(switchView).toContain('Focus one already-open AgentMux Desktop View')
    expect(switchView).toContain('never opens, attaches, resumes, spawns, splits')
  })

  it('prints bounded Agent instructions with an honest composition boundary', async () => {
    const skill = await run(['--skill'])

    expect(skill).toContain('name: agentmux')
    expect(skill).toContain('test "${AGENTMUX_ENV:-}" = 1')
    expect(skill).toContain('agentmux send "$AGENTMUX_AGENT_SESSION_ID"')
    expect(skill).toContain('does not create, split, move, open, attach, resume, or spawn Desktop Views')
    expect(skill).toContain('do not fall back to computer-use')
  })

  it('reports the installed CLI version', async () => {
    await expect(run(['--version'])).resolves.toBe('agentmux 0.1.0\n')
  })
})
