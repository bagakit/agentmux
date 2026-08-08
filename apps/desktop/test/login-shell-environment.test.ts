import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it, vi } from 'vitest'
import {
  hydrateProcessEnvironmentFromLoginShell,
  loginShellEnvironmentWarning,
  parseLoginShellEnvironment
} from '../src/main/login-shell-environment.js'

const exec = promisify(execFile)
function framed(args: readonly string[], values: Record<string, string>): string {
  const marker = args[1]!.match(/__AGENTMUX_ENV_[\w-]+__/)![0]
  return `banner\n${marker}\0${Object.entries(values).map(([k, v]) => `${k}=${v}\0`).join('')}${marker}\0logout\n`
}

describe('login shell exported environment', () => {
  it('preserves empty, multiline, equals and ANSI bytes without parsing banner text', () => {
    expect(parseLoginShellEnvironment('banner\nm\0PATH=/bin\0EMPTY=\0VALUE=a=b\n\u001b[32m\0m\0bye', 'm'))
      .toEqual({ PATH: '/bin', EMPTY: '', VALUE: 'a=b\n\u001b[32m' })
    expect(parseLoginShellEnvironment('m\0PATH=/bin\0', 'm')).toBeNull()
    expect(parseLoginShellEnvironment('m\0INVALID\0m\0', 'm')).toBeNull()
    expect(parseLoginShellEnvironment('m\0EMPTY=\0m\0', 'm')).toEqual({ EMPTY: '' })
  })

  it.each(['/bin/zsh', '/bin/bash'])('loads real %s profile exports into a child without exporting shell-local variables', async (shell) => {
    const directory = await mkdtemp(join(tmpdir(), 'agentmux-shell-env-'))
    try {
      await writeFile(join(directory, shell.endsWith('zsh') ? '.zprofile' : '.bash_profile'),
        'export AGENTMUX_TEST_PROFILE=profile\n' + (shell.endsWith('bash') ? '. "$HOME/.bashrc"\n' : ''))
      await writeFile(join(directory, shell.endsWith('zsh') ? '.zshrc' : '.bashrc'), [
        'printf "profile banner\\n"',
        "export AGENTMUX_TEST_RC='hello=world", "second line'",
        "export AGENTMUX_TEST_EMPTY=''",
        'AGENTMUX_TEST_LOCAL=not-exported',
        "export PATH='/opt/test tools:/usr/bin:/bin'"
      ].join('\n'))
      const env: NodeJS.ProcessEnv = { HOME: directory, ZDOTDIR: directory, SHELL: shell, PATH: '/usr/bin:/bin' }
      const result = await hydrateProcessEnvironmentFromLoginShell({ platform: 'darwin', env })
      expect(result).toEqual({ ok: true, shell, mode: 'interactive-login' })
      expect(loginShellEnvironmentWarning(result)).toBeUndefined()
      const child = await exec(process.execPath, ['-e', 'process.stdout.write(JSON.stringify([process.env.AGENTMUX_TEST_PROFILE, process.env.AGENTMUX_TEST_RC, process.env.AGENTMUX_TEST_EMPTY, process.env.AGENTMUX_TEST_LOCAL, process.env.PATH]))'], { env })
      expect(JSON.parse(child.stdout)).toEqual(['profile', 'hello=world\nsecond line', '', null, '/opt/test tools:/usr/bin:/bin'])
      expect(env.SHLVL).toBeUndefined()
      expect(env._).toBeUndefined()
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('reports partial success after interactive failure and preserves inherited PATH entries', async () => {
    const env: NodeJS.ProcessEnv = { PATH: '/bin:/client/bin', SHELL: '/bin/zsh', KEEP: 'inherited' }
    const runner = vi.fn(async (_shell: string, args: readonly string[]) => {
      if (args[0] === '-ilc') throw new Error('private profile detail must not be reported')
      return framed(args, { PATH: '/opt/bin:/bin', EXPORTED: 'profile', PWD: '/probe' })
    })
    const result = await hydrateProcessEnvironmentFromLoginShell({ platform: 'darwin', env, runner })
    expect(result).toEqual({ ok: true, shell: '/bin/zsh', mode: 'login' })
    expect(env).toMatchObject({ PATH: '/opt/bin:/bin:/client/bin', KEEP: 'inherited', EXPORTED: 'profile' })
    expect(env.PWD).toBeUndefined()
    expect(loginShellEnvironmentWarning(result)).toContain('.zshrc could not be confirmed')
    expect(runner).toHaveBeenCalledTimes(2)
  })

  it('preserves all inherited values on total failure and returns a non-secret warning', async () => {
    const env = { PATH: '/bin', KEEP: 'original' }
    const result = await hydrateProcessEnvironmentFromLoginShell({ platform: 'darwin', env, runner: async () => { throw new Error('secret') } })
    expect(result).toEqual({ ok: false, reason: 'probe-failed' })
    expect(env).toEqual({ PATH: '/bin', KEEP: 'original' })
    expect(loginShellEnvironmentWarning(result)).toContain('inherited application environment')
    expect(loginShellEnvironmentWarning(result)).not.toContain('secret')
  })

  it('does not launch a shell on unsupported platforms', async () => {
    const runner = vi.fn()
    const result = await hydrateProcessEnvironmentFromLoginShell({ platform: 'win32', env: {}, runner })
    expect(result).toEqual({ ok: false, reason: 'unsupported-platform' })
    expect(runner).not.toHaveBeenCalled()
  })
})
