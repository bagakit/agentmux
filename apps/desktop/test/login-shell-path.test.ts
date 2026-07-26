import { win32 as _hygiene_win32 } from "node:path"
import { fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
import { describe, expect, it, vi } from 'vitest'
import {
  hydrateProcessPathFromLoginShell,
  parseLoginShellPath
} from '../src/main/login-shell-path.js'

describe('login shell PATH hydration', () => {
  it('isolates PATH from profile banners and ANSI output', () => {
    expect(parseLoginShellPath(
      ("\u001b[32mprofile ready\u001b[0m\n__AGENTMUX_LOGIN_SHELL_PATH__" + _hygiene_fixturePath("opt/homebrew/bin") + ":/usr/bin__AGENTMUX_LOGIN_SHELL_PATH__\n")
    )).toBe([_hygiene_fixturePath("opt/homebrew/bin"), "/usr/bin"].join(":"))
  })

  it('makes the login shell PATH authoritative for the process', async () => {
    const env: NodeJS.ProcessEnv = { PATH: ["/usr/bin", "/bin"].join(":"), SHELL: '/bin/zsh' }
    const runner = vi.fn(async () => (
      ("banner\n__AGENTMUX_LOGIN_SHELL_PATH__" + _hygiene_fixturePath("Users/test/.local/bin") + ":" + _hygiene_fixturePath("opt/homebrew/bin") + ":/usr/bin__AGENTMUX_LOGIN_SHELL_PATH__")
    ))

    await expect(hydrateProcessPathFromLoginShell({
      platform: 'darwin',
      env,
      runner
    })).resolves.toEqual({
      ok: true,
      path: [_hygiene_fixturePath("Users/test/.local/bin"), _hygiene_fixturePath("opt/homebrew/bin"), "/usr/bin"].join(":"),
      shell: '/bin/zsh'
    })
    expect(env.PATH).toBe([_hygiene_fixturePath("Users/test/.local/bin"), _hygiene_fixturePath("opt/homebrew/bin"), "/usr/bin"].join(":"))
    expect(runner).toHaveBeenCalledOnce()
    expect(runner.mock.calls[0]?.[0]).toBe('/bin/zsh')
    expect(runner.mock.calls[0]?.[1].slice(0, 1)).toEqual(['-ilc'])
  })

  it('preserves the inherited PATH when the profile probe fails', async () => {
    const env: NodeJS.ProcessEnv = { PATH: ["/usr/bin", "/bin"].join(":"), SHELL: '/bin/zsh' }

    await expect(hydrateProcessPathFromLoginShell({
      platform: 'darwin',
      env,
      runner: async () => { throw new Error('profile failed') }
    })).resolves.toEqual({ ok: false, reason: 'probe-failed' })
    expect(env.PATH).toBe(["/usr/bin", "/bin"].join(":"))
  })

  it('falls back to a non-interactive login shell and merges the inherited PATH', async () => {
    const env: NodeJS.ProcessEnv = { PATH: ["/usr/bin", _hygiene_fixturePath("Users/test/.local/bin")].join(":"), SHELL: '/bin/zsh' }
    const runner = vi.fn()
      .mockRejectedValueOnce(new Error('interactive profile failed'))
      .mockResolvedValueOnce(
        ("__AGENTMUX_LOGIN_SHELL_PATH__" + _hygiene_fixturePath("opt/homebrew/bin") + ":/usr/bin__AGENTMUX_LOGIN_SHELL_PATH__")
      )

    await expect(hydrateProcessPathFromLoginShell({ platform: 'darwin', env, runner }))
      .resolves.toEqual({
        ok: true,
        path: [_hygiene_fixturePath("opt/homebrew/bin"), "/usr/bin", _hygiene_fixturePath("Users/test/.local/bin")].join(":"),
        shell: '/bin/zsh'
      })
    expect(runner).toHaveBeenCalledTimes(2)
    expect(runner.mock.calls[1]?.[1].slice(0, 1)).toEqual(['-lc'])
  })

  it('does not invent shell or executable paths on unsupported platforms', async () => {
    const env: NodeJS.ProcessEnv = { PATH: _hygiene_win32.join("C:", _hygiene_win32.sep, "Windows\\System32") }

    await expect(hydrateProcessPathFromLoginShell({
      platform: 'win32',
      env,
      runner: async () => { throw new Error('must not run') }
    })).resolves.toEqual({ ok: false, reason: 'unsupported-platform' })
    expect(env.PATH).toBe(_hygiene_win32.join("C:", _hygiene_win32.sep, "Windows\\System32"))
  })
})
