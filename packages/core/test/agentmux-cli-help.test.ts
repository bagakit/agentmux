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

async function fail(args: readonly string[], env: NodeJS.ProcessEnv = {}): Promise<{
  stdout: string
  stderr: string
  code: number
}> {
  try {
    await execFileAsync(cli, args, {
      timeout: 5_000,
      maxBuffer: 512 * 1024,
      env: { ...process.env, ...env }
    })
  } catch (error) {
    const failure = error as { stdout: string; stderr: string; code: number }
    return { stdout: failure.stdout, stderr: failure.stderr, code: failure.code }
  }
  throw new Error('CLI unexpectedly succeeded.')
}

describe('agentmux CLI discovery', () => {
  it('explains Composition, Session groups, managed context, and JSON receipts', async () => {
    const help = await run(['--help'])

    expect(help).toContain('typed local Agent Session and Desktop Composition control')
    expect(help).toContain('Composition:')
    expect(help).toContain('Agent Sessions:')
    expect(help).toContain('session output')
    expect(help).toContain('AGENTMUX_AGENT_SESSION_ID')
    expect(help).toContain('versioned JSON by default')
    expect(help).toContain('agentmux --skill')
  })

  it('gives nested success and next-action guidance without contacting a runtime', async () => {
    const send = await run(['session', 'send', '--help'])
    const openRegion = await run(['region', 'open', '--help'])
    const launch = await run(['launch', '--help'])

    expect(send).toContain('Provider contract atomically accepted the prompt')
    expect(send).toContain('literal --help')
    expect(send).toContain('next: agentmux session output')
    expect(openRegion).toContain('does not create, resume, attach, or replace model')
    expect(openRegion).toContain('Defaults: --placement split-right')
    expect(launch).toContain('long-lived Desktop RuntimeController')
  })

  it('prints bounded Agent instructions for the delivered Composition surface', async () => {
    const skill = await run(['--skill'])

    expect(skill).toContain('name: agentmux')
    expect(skill).toContain('test "${AGENTMUX_ENV:-}" = 1')
    expect(skill).toContain('agentmux session send "$AGENTMUX_AGENT_SESSION_ID"')
    expect(skill).toContain('agentmux launch --agent codex')
    expect(skill).toContain('agentmux region open --session')
    expect(skill).toContain('Use `--placement tab` only when the user explicitly asks for a Tab')
    expect(skill).toContain('ask whether it should open in a new Tab')
    expect(skill).toContain('normalized `x`, `y`')
    expect(skill).toContain('A direction describes the whole current View')
    expect(skill).toContain('does not always mean split `self`')
    expect(skill).toContain('--relative-to region:<left-region-id>')
    expect(skill).toContain('fall back to computer-use')
  })

  it('emits stable JSON errors and deletes the flat command surface', async () => {
    const unmanaged = await fail(['context'])
    expect(unmanaged.code).toBe(1)
    expect(unmanaged.stdout).toBe('')
    expect(JSON.parse(unmanaged.stderr)).toEqual({
      schemaVersion: 1,
      operation: 'context',
      error: {
        code: 'MANAGED_AGENT_CONTEXT_REQUIRED',
        message: 'This command requires an AgentMux-managed Agent caller.'
      }
    })

    const retired = await fail(['status', 'old-session'])
    expect(JSON.parse(retired.stderr)).toMatchObject({
      schemaVersion: 1,
      operation: null,
      error: { code: 'INVALID_CLI_ARGUMENT' }
    })
  })

  it('reports the installed CLI version', async () => {
    await expect(run(['--version'])).resolves.toBe('agentmux 0.1.0\n')
  })
})
