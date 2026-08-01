import { readFileSync, statSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import type { ExecutionHost } from '@agentmux/core'
import type { AppConfig } from '../src/shared/contracts.js'
import { GhService } from '../src/main/gh-service.js'

const config: AppConfig = {
  version: 7,
  hosts: [{ id: 'local', kind: 'local', label: 'This Mac' }],
  executors: {},
  workspaces: [],
  appearance: { terminalTheme: 'graphite' },
  browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, more: true } }
}

// Non-interactive on two axes: GH_PROMPT_DISABLED so gh never blocks on a terminal prompt in the
// unattended main process, GH_NO_UPDATE_NOTIFIER so a version check cannot inject noise or a hang.
const GH_ENV = { GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1' }
const GH_RUN_OPTIONS = { env: GH_ENV, timeoutMs: 15_000, maxOutputBytes: 1024 * 1024 }

type RunResult = { stdout: string; stderr: string; exitCode: number }

/**
 * A fake host that answers a single `gh` invocation. `run` is overridable so a test can make gh exit
 * cleanly, exit non-zero (an auth issue), or reject the way a missing binary does (spawn ENOENT).
 */
function ghHost(run: (command: string, args: readonly string[], options?: unknown) => Promise<RunResult>): ExecutionHost {
  return {
    id: 'remote',
    kind: 'ssh',
    label: 'Remote',
    exposeLoopbackPort: vi.fn(async (port: number) => port),
    dispose: vi.fn(async () => {}),
    run: vi.fn(run)
  }
}

function withWorkspace(host: ExecutionHost): { service: GhService; config: AppConfig } {
  return {
    service: new GhService(() => host),
    config: {
      ...config,
      workspaces: [{ id: 'repo', name: 'repo', hostId: 'remote', path: '/srv/repo', kind: 'folder' }]
    }
  }
}

describe('GhService.authStatus (contract, fake executor)', () => {
  it('probes `gh auth status` with a non-interactive env and a timeout, and reports authenticated on a clean exit', async () => {
    const host = ghHost(async () => ({ stdout: 'Logged in to github.com account octocat\n', stderr: '', exitCode: 0 }))
    const { service, config: cfg } = withWorkspace(host)

    await expect(service.authStatus('repo', cfg)).resolves.toEqual({ kind: 'authenticated' })
    expect(host.run).toHaveBeenCalledWith('gh', ['auth', 'status'], GH_RUN_OPTIONS)
  })

  it('reads a non-zero exit as not-authenticated — distinct from a missing binary, so the fix is `gh auth login`', async () => {
    const host = ghHost(async () => ({ stdout: '', stderr: 'You are not logged into any GitHub hosts.\n', exitCode: 1 }))
    const { service, config: cfg } = withWorkspace(host)

    await expect(service.authStatus('repo', cfg)).resolves.toEqual({ kind: 'not-authenticated' })
  })

  it('reads a spawn ENOENT as not-installed rather than throwing — the fix is to install gh', async () => {
    const host = ghHost(async () => {
      throw Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' })
    })
    const { service, config: cfg } = withWorkspace(host)

    await expect(service.authStatus('repo', cfg)).resolves.toEqual({ kind: 'not-installed' })
  })

  it('re-throws a non-ENOENT failure (a timeout) instead of masquerading it as not-installed', async () => {
    const host = ghHost(async () => {
      throw Object.assign(new Error('Command timed out.'), { code: 'COMMAND_TIMEOUT' })
    })
    const { service, config: cfg } = withWorkspace(host)

    await expect(service.authStatus('repo', cfg)).rejects.toThrow('Command timed out.')
  })

  it('never injects a token into the child env — gh inherits GH_TOKEN/GITHUB_TOKEN from the process on its own', async () => {
    let seenEnv: Record<string, string | undefined> | undefined
    const host = ghHost(async (_command, _args, options) => {
      seenEnv = (options as { env?: Record<string, string | undefined> })?.env
      return { stdout: '', stderr: '', exitCode: 0 }
    })
    const { service, config: cfg } = withWorkspace(host)

    await service.authStatus('repo', cfg)

    expect(seenEnv).toBeDefined()
    expect(seenEnv).not.toHaveProperty('GH_TOKEN')
    expect(seenEnv).not.toHaveProperty('GITHUB_TOKEN')
  })
})

describe('GhService.createPullRequest (contract, fake executor)', () => {
  // A router so one fake can answer both the preflight (`git ls-remote`) and the create (`gh pr create`).
  function prHost(options: {
    lsRemoteExit?: number
    lsRemoteThrows?: boolean
    createResult?: RunResult
    createThrows?: unknown
  }): ExecutionHost {
    return ghHost(async (command, args) => {
      if (command === 'git') {
        if (options.lsRemoteThrows) throw new Error('network down')
        return { stdout: '', stderr: '', exitCode: options.lsRemoteExit ?? 0 }
      }
      if (options.createThrows) throw options.createThrows
      void args
      return options.createResult ?? { stdout: 'https://github.com/o/r/pull/7\n', stderr: '', exitCode: 0 }
    })
  }

  it('passes the body through a file, never argv, and returns the created URL', async () => {
    const host = prHost({})
    const { service, config: cfg } = withWorkspace(host)

    const result = await service.createPullRequest('repo', {
      title: 'Add retry to the uploader',
      body: '## Problem\n\nUploads fail.\n\n## Solution\n\nRetry.',
      base: 'main'
    }, cfg)

    expect(result).toEqual({ kind: 'created', url: 'https://github.com/o/r/pull/7' })
    const ghArgs = (host.run as ReturnType<typeof vi.fn>).mock.calls
      .filter(([command]) => command === 'gh')
      .map(([, args]) => args as string[])[0]!
    expect(ghArgs.slice(0, 2)).toEqual(['pr', 'create'])
    // The prose goes through --body-file; a long body must never become an argv entry.
    expect(ghArgs).toContain('--body-file')
    expect(ghArgs.join(' ')).not.toContain('Uploads fail')
  })

  it('keeps the body file unreadable by anyone but the owner while gh runs', async () => {
    // The body is the user's prose, and it sits in the shared tmpdir for as long as `gh` takes to run.
    // Default write mode there is 0o644 under a normal umask — same-machine other users could read it.
    // So this observes the REAL mode of the REAL file, from inside the window when gh would be reading
    // it. A source-text check for `mode:` would not: it cannot see a umask, and it would stay green if
    // the write moved to a helper that dropped the option.
    let observed: { mode: number; body: string } | undefined
    const host = ghHost(async (command, args) => {
      if (command === 'git') return { stdout: '', stderr: '', exitCode: 0 }
      const bodyFile = args[args.indexOf('--body-file') + 1]!
      observed = { mode: statSync(bodyFile).mode & 0o777, body: readFileSync(bodyFile, 'utf8') }
      return { stdout: 'https://github.com/o/r/pull/7\n', stderr: '', exitCode: 0 }
    })
    const { service, config: cfg } = withWorkspace(host)

    await service.createPullRequest('repo', { title: 'T', body: 'private prose', base: 'main' }, cfg)

    expect(observed).toBeDefined()
    // Pin the body too: a mode of 0 would satisfy the permission check while breaking gh outright,
    // so the file has to be both private AND actually carrying the user's text.
    expect(observed!.body).toBe('private prose')
    // Group and other must have no bits at all — not merely "not writable".
    expect(observed!.mode & 0o077).toBe(0)
  })

  // Backend preflight is the final authority: the base must be verified to EXIST on the remote.
  it('refuses when the base does not exist on the remote', async () => {
    const host = prHost({ lsRemoteExit: 2 })
    const { service, config: cfg } = withWorkspace(host)

    const result = await service.createPullRequest('repo', { title: 'T', body: 'B', base: 'ghost' }, cfg)

    expect(result.kind).toBe('refused')
    // Nothing was created, so gh must never have run.
    expect((host.run as ReturnType<typeof vi.fn>).mock.calls.some(([command]) => command === 'gh')).toBe(false)
  })

  // "I could not check" is not "it is fine". An unavailable preflight must fail closed.
  it('refuses when the preflight cannot answer at all, rather than proceeding on an unverified premise', async () => {
    const host = prHost({ lsRemoteThrows: true })
    const { service, config: cfg } = withWorkspace(host)

    const result = await service.createPullRequest('repo', { title: 'T', body: 'B', base: 'main' }, cfg)

    expect(result.kind).toBe('refused')
    expect((host.run as ReturnType<typeof vi.fn>).mock.calls.some(([command]) => command === 'gh')).toBe(false)
  })

  it('refuses an unverifiable preflight exit code the same way', async () => {
    const host = prHost({ lsRemoteExit: 128 })
    const { service, config: cfg } = withWorkspace(host)

    expect((await service.createPullRequest('repo', { title: 'T', body: 'B', base: 'main' }, cfg)).kind)
      .toBe('refused')
  })

  it('scrubs a credential out of a gh failure before it can reach the UI or a log', async () => {
    const host = prHost({
      createResult: {
        stdout: '',
        stderr: "failed to run git: fatal: unable to access 'https://ghp_SECRET123@github.com/o/r.git/'",
        exitCode: 1
      }
    })
    const { service, config: cfg } = withWorkspace(host)

    const result = await service.createPullRequest('repo', { title: 'T', body: 'B', base: 'main' }, cfg)

    expect(result.kind).toBe('failed')
    if (result.kind !== 'failed') return
    expect(result.message).not.toContain('ghp_SECRET123')
    expect(result.message).toContain('***@github.com')
  })

  it('never retries a create: one click, at most one gh invocation', async () => {
    const host = prHost({ createResult: { stdout: '', stderr: 'server error', exitCode: 1 } })
    const { service, config: cfg } = withWorkspace(host)

    await service.createPullRequest('repo', { title: 'T', body: 'B', base: 'main' }, cfg)

    // A retry here would open a second pull request.
    const ghCalls = (host.run as ReturnType<typeof vi.fn>).mock.calls.filter(([command]) => command === 'gh')
    expect(ghCalls).toHaveLength(1)
  })

  it('rejects a base that could be read as a flag', async () => {
    const host = prHost({})
    const { service, config: cfg } = withWorkspace(host)

    await expect(service.createPullRequest('repo', { title: 'T', body: 'B', base: '--upload-pack=evil' }, cfg))
      .rejects.toThrow(/cannot begin with/u)
  })

  it('refuses an empty title instead of opening a nameless pull request', async () => {
    const host = prHost({})
    const { service, config: cfg } = withWorkspace(host)

    expect((await service.createPullRequest('repo', { title: '   ', body: 'B', base: 'main' }, cfg)).kind)
      .toBe('refused')
  })
})
