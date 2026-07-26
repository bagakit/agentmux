import { describe, expect, it, vi } from 'vitest'
import {
  hydrateProcessPathFromLoginShell,
  parseLoginShellPath
} from '../src/main/login-shell-path.js'

describe('login shell PATH hydration', () => {
  it('isolates PATH from profile banners and ANSI output', () => {
    expect(parseLoginShellPath(
      '\u001b[32mprofile ready\u001b[0m\n__AGENTMUX_LOGIN_SHELL_PATH__/opt/homebrew/bin:/usr/bin__AGENTMUX_LOGIN_SHELL_PATH__\n'
    )).toBe('/opt/homebrew/bin:/usr/bin')
  })

  it('makes the login shell PATH authoritative for the process', async () => {
    const env: NodeJS.ProcessEnv = { PATH: '/usr/bin:/bin', SHELL: '/bin/zsh' }
    const runner = vi.fn(async () => (
      'banner\n__AGENTMUX_LOGIN_SHELL_PATH__/Users/test/.local/bin:/opt/homebrew/bin:/usr/bin__AGENTMUX_LOGIN_SHELL_PATH__'
    ))

    await expect(hydrateProcessPathFromLoginShell({
      platform: 'darwin',
      env,
      runner
    })).resolves.toEqual({
      ok: true,
      path: '/Users/test/.local/bin:/opt/homebrew/bin:/usr/bin',
      shell: '/bin/zsh'
    })
    expect(env.PATH).toBe('/Users/test/.local/bin:/opt/homebrew/bin:/usr/bin')
    expect(runner).toHaveBeenCalledOnce()
    expect(runner.mock.calls[0]?.[0]).toBe('/bin/zsh')
    expect(runner.mock.calls[0]?.[1].slice(0, 1)).toEqual(['-ilc'])
  })

  it('preserves the inherited PATH when the profile probe fails', async () => {
    const env: NodeJS.ProcessEnv = { PATH: '/usr/bin:/bin', SHELL: '/bin/zsh' }

    await expect(hydrateProcessPathFromLoginShell({
      platform: 'darwin',
      env,
      runner: async () => { throw new Error('profile failed') }
    })).resolves.toEqual({ ok: false, reason: 'probe-failed' })
    expect(env.PATH).toBe('/usr/bin:/bin')
  })

  it('falls back to a non-interactive login shell and merges the inherited PATH', async () => {
    const env: NodeJS.ProcessEnv = { PATH: '/usr/bin:/Users/test/.local/bin', SHELL: '/bin/zsh' }
    const runner = vi.fn()
      .mockRejectedValueOnce(new Error('interactive profile failed'))
      .mockResolvedValueOnce(
        '__AGENTMUX_LOGIN_SHELL_PATH__/opt/homebrew/bin:/usr/bin__AGENTMUX_LOGIN_SHELL_PATH__'
      )

    await expect(hydrateProcessPathFromLoginShell({ platform: 'darwin', env, runner }))
      .resolves.toEqual({
        ok: true,
        path: '/opt/homebrew/bin:/usr/bin:/Users/test/.local/bin',
        shell: '/bin/zsh'
      })
    expect(runner).toHaveBeenCalledTimes(2)
    expect(runner.mock.calls[1]?.[1].slice(0, 1)).toEqual(['-lc'])
  })

  it('does not invent shell or executable paths on unsupported platforms', async () => {
    const env: NodeJS.ProcessEnv = { PATH: 'C:\\Windows\\System32' }

    await expect(hydrateProcessPathFromLoginShell({
      platform: 'win32',
      env,
      runner: async () => { throw new Error('must not run') }
    })).resolves.toEqual({ ok: false, reason: 'unsupported-platform' })
    expect(env.PATH).toBe('C:\\Windows\\System32')
  })
})
