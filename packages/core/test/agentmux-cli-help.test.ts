import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'

const execFileAsync = promisify(execFile)
const cli = fileURLToPath(new URL('../bin/agentmux', import.meta.url))
async function run(args: readonly string[]): Promise<string> {
  return (await execFileAsync(cli, args, { timeout: 5_000, maxBuffer: 512 * 1024 })).stdout
}
async function fail(args: readonly string[], env: NodeJS.ProcessEnv = {}) {
  try { await execFileAsync(cli, args, { timeout: 5_000, maxBuffer: 512 * 1024, env: { ...process.env, ...env } }) } catch (error) {
    const failure = error as { stdout: string; stderr: string; code: number }
    return { stdout: failure.stdout, stderr: failure.stderr, code: failure.code }
  }
  throw new Error('CLI unexpectedly succeeded.')
}

describe('agentmux CLI discovery', () => {
  it('exposes only the intent-based Control surface', async () => {
    const help = await run(['--help'])
    expect(help).toContain('typed local Agent and Desktop control')
    expect(help).toContain('inspect')
    expect(help).toContain('open')
    expect(help).toContain('send')
    expect(help).toContain('focus')
    expect(help).toContain('arrange')
    expect(help).toContain('AGENTMUX_AGENT_SESSION_ID')
    expect(help).not.toContain('Composition:')
  })

  it('documents typed targets and exact destinations without contacting owners', async () => {
    expect(await run(['inspect', '--help'])).toContain('inspect --tab <tab-id|self>')
    const open = await run(['open', '--help'])
    expect(open).toContain('agentmux open terminal')
    expect(open).toContain('--left-of <region-id|self>')
    expect(open).toContain('--right-of <region-id|self>')
    expect(open).toContain('--above <region-id|self>')
    expect(open).toContain('--below <region-id|self>')
    expect(open).toContain('--new-tab-after <tab-id|self>')
    expect(open).toContain('--in-region <launcher-region-id>')
    expect(await run(['open', 'agent', '--help'])).toContain('--right-of <region-id|self>')
    expect(await run(['open', 'terminal', '--help'])).toContain('--command <shell-command>')
    expect(await run(['open', 'browser', '--help'])).toContain('--url <url>')
    expect(await run(['arrange', '--help'])).toContain('grid-9')
    const send = await run(['send', '--help'])
    expect(send).toContain('MESSAGE_TARGET_NOT_UNIQUE')
    expect(send).toContain('never resumes')
  })

  it('prints bounded Agent instructions for inspect, open, and send', async () => {
    const skill = await run(['--skill'])
    expect(skill).toContain('agentmux inspect --tab self')
    expect(skill).toContain('agentmux open agent --agent codex')
    expect(skill).toContain('agentmux send --to-tab <tab-id>')
    expect(skill).toContain('agentmux open terminal --command')
    expect(skill).toContain('agentmux open browser --url')
    expect(skill).toContain('agentmux arrange --tab self --preset columns-3')
    expect(skill).toContain('agentmux arrange --tab self --preset grid-4')
    expect(skill).toContain('agentmux arrange --tab self --preset grid-9')
    expect(skill).toContain('--left-of <region-id>')
    expect(skill).toContain('--above <region-id>')
    expect(skill).toContain('--in-region <launcher-region-id>')
    expect(skill).toContain('deduplicating every caller Region')
    expect(skill).toContain('schemaVersion')
    expect(skill).toContain('candidates[].agentSessionId')
    expect(skill).toContain('Send never broadcasts and never resumes')
    expect(skill).toContain('No failure')
  })

  it('deletes old command trees and requires managed identity for self', async () => {
    const unmanaged = await fail(['inspect', '--tab', 'self'], { AGENTMUX_ENV: '', AGENTMUX_AGENT_SESSION_ID: '' })
    expect(JSON.parse(unmanaged.stderr)).toMatchObject({ error: { code: 'MANAGED_AGENT_CONTEXT_REQUIRED' } })
    for (const old of [['context'], ['launch'], ['session', 'list'], ['region', 'focus']]) {
      const retired = await fail(old)
      expect(JSON.parse(retired.stderr)).toMatchObject({ error: { code: 'INVALID_CLI_ARGUMENT' } })
    }
  })

  it('accepts inline typed flag values and keeps self reserved for selector syntax', async () => {
    const unmanaged = await fail(['inspect', '--tab=self'], { AGENTMUX_ENV: '', AGENTMUX_AGENT_SESSION_ID: '' })
    expect(JSON.parse(unmanaged.stderr)).toMatchObject({ error: { code: 'MANAGED_AGENT_CONTEXT_REQUIRED' } })
    const exactOnly = await fail(['focus', '--tab=self'])
    expect(JSON.parse(exactOnly.stderr)).toMatchObject({ error: { code: 'INVALID_CLI_ARGUMENT' } })
    const inlineDashId = await fail(['focus', '--tab=--prefixed-tab'])
    expect(JSON.parse(inlineDashId.stderr)).toMatchObject({ error: { code: 'CONTROL_UNAVAILABLE' } })
  })

  it('rejects missing and unrelated native identity companion flags', async () => {
    for (const args of [
      ['inspect', '--provider-native', 'native-id'],
      ['inspect', '--session', 'session-id', '--provider', 'codex'],
      ['inspect', '--acp-native', 'native-id'],
      ['inspect', '--run', 'run-id', '--adapter', 'acp']
    ]) {
      const failure = await fail(args)
      expect(JSON.parse(failure.stderr)).toMatchObject({ error: { code: 'INVALID_CLI_ARGUMENT' } })
    }
  })

  it('reports the installed CLI version', async () => {
    await expect(run(['--version'])).resolves.toBe('agentmux 0.1.0\n')
  })
})
