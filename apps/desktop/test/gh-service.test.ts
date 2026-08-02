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

/**
 * The git half of GhService's readiness read. Defaults answer "a clean repo on `feature`, one commit
 * ahead of its upstream" so a readiness test only has to state the fact it is actually about.
 *
 * The type is derived from the constructor rather than written out: a widened dependency must break
 * here, not be silently satisfied by a stub that happens to still typecheck.
 */
type GhServiceGit = ConstructorParameters<typeof GhService>[1]

function gitStub(overrides: Partial<GhServiceGit> = {}): GhServiceGit {
  return {
    status: vi.fn(async () => ({
      kind: 'git-repository' as const,
      hostId: 'remote',
      repoPath: '/srv/repo',
      branch: 'feature',
      changes: []
    })),
    aheadBehind: vi.fn(async () => ({ upstream: 'origin/feature', ahead: 1, behind: 0 })),
    ...overrides
  }
}

function withWorkspace(host: ExecutionHost, git: GhServiceGit = gitStub()): { service: GhService; config: AppConfig } {
  return {
    service: new GhService(() => host, git),
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
  it('refuses when the base does not exist on the remote, and says so', async () => {
    const host = prHost({ lsRemoteExit: 2 })
    const { service, config: cfg } = withWorkspace(host)

    const result = await service.createPullRequest('repo', { title: 'T', body: 'B', base: 'ghost' }, cfg)

    expect(result.kind).toBe('refused')
    // The remote ANSWERED, so naming the branch as absent is a true statement the user can act on.
    expect(result.kind === 'refused' && result.reason).toContain('ghost')
    expect(result.kind === 'refused' && result.reason).toMatch(/does not exist/u)
    // Nothing was created, so gh must never have run.
    expect((host.run as ReturnType<typeof vi.fn>).mock.calls.some(([command]) => command === 'gh')).toBe(false)
  })

  // "I could not check" is not "it is fine". An unavailable preflight must fail closed.
  it('refuses when the preflight cannot answer at all, rather than proceeding on an unverified premise', async () => {
    const host = prHost({ lsRemoteThrows: true })
    const { service, config: cfg } = withWorkspace(host)

    const result = await service.createPullRequest('repo', { title: 'T', body: 'B', base: 'main' }, cfg)

    expect(result.kind).toBe('refused')
    // Both branches refuse, so `kind` alone cannot tell them apart — and folding them together would
    // tell the user their branch does not exist when what actually happened is that we never asked.
    // That is a false claim about their remote, so the wording is the thing under test here.
    expect(result.kind === 'refused' && result.reason).not.toMatch(/does not exist/u)
    expect(result.kind === 'refused' && result.reason).toMatch(/[Cc]ould not verify/u)
    expect((host.run as ReturnType<typeof vi.fn>).mock.calls.some(([command]) => command === 'gh')).toBe(false)
  })

  it('treats any other preflight exit as unverified, not as absence', async () => {
    // `ls-remote --exit-code` documents 0 and 2. Exit 128 is git failing for its own reasons (no
    // network, no permission) — reading it as "the branch is missing" would invent a fact about the
    // remote, so this pins the wording, not just the refusal.
    const host = prHost({ lsRemoteExit: 128 })
    const { service, config: cfg } = withWorkspace(host)

    const result = await service.createPullRequest('repo', { title: 'T', body: 'B', base: 'main' }, cfg)

    expect(result.kind).toBe('refused')
    expect(result.kind === 'refused' && result.reason).not.toMatch(/does not exist/u)
    expect(result.kind === 'refused' && result.reason).toMatch(/[Cc]ould not verify/u)
  })


  it('verifies the same ref it then hands to gh, even when the caller passes a remote-tracking name', async () => {
    // The bug this pins: the preflight stripped `origin/` while argv did not, so `origin/main` was
    // confirmed to exist as `main` and then given to gh as `origin/main`. Both sides are asserted
    // against each other rather than against a literal, because the defect is the DISAGREEMENT — a test
    // that only checked one side would stay green while the other drifted.
    const host = prHost({})
    const { service, config: cfg } = withWorkspace(host)

    await service.createPullRequest('repo', { title: 'T', body: 'B', base: 'origin/main' }, cfg)

    const calls = (host.run as ReturnType<typeof vi.fn>).mock.calls
    const lsRemote = calls.map(([, args]) => args as string[]).find((args) => args.includes('ls-remote'))!
    const ghArgs = calls.filter(([command]) => command === 'gh').map(([, args]) => args as string[])[0]!
    const verified = lsRemote.at(-1)!.replace('refs/heads/', '')
    const used = ghArgs[ghArgs.indexOf('--base') + 1]
    expect(used).toBe(verified)
    // And pin which one they agreed ON: agreeing on `origin/main` would mean gh is asked to open the PR
    // against a ref that does not name a branch on the remote.
    expect(used).toBe('main')
  })

  it('removes the prefix only where it is a prefix — `origin/` inside a branch name is part of the name', async () => {
    // The anchor in the normalizer is load-bearing, and this is the only input that can show it: every
    // other case in this file has `origin/` at position 0, where anchored and unanchored agree. A branch
    // legitimately named `feature/origin/rework` must keep all three segments — an unanchored replace
    // eats the middle one and silently targets a branch nobody named.
    const host = prHost({})
    const { service, config: cfg } = withWorkspace(host)

    await service.createPullRequest('repo', { title: 'T', body: 'B', base: 'feature/origin/rework' }, cfg)

    const calls = (host.run as ReturnType<typeof vi.fn>).mock.calls
    const lsRemote = calls.map(([, args]) => args as string[]).find((args) => args.includes('ls-remote'))!
    const ghArgs = calls.filter(([command]) => command === 'gh').map(([, args]) => args as string[])[0]!
    expect(lsRemote.at(-1)).toBe('refs/heads/feature/origin/rework')
    expect(ghArgs[ghArgs.indexOf('--base') + 1]).toBe('feature/origin/rework')
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

describe('GhService.prReadiness (contract, fake executor)', () => {
  /**
   * A host that answers each of readiness's three shell questions independently, so a test can make one
   * of them fail without disturbing the others. Defaults: gh is logged in, `origin/HEAD` says `main`,
   * and `main` exists on the remote.
   */
  function readinessHost(options: {
    ghExit?: number
    symbolicRef?: RunResult | 'throws'
    lsRemote?: RunResult | 'throws'
  } = {}): ExecutionHost {
    return ghHost(async (command, args) => {
      if (command === 'gh') return { stdout: '', stderr: '', exitCode: options.ghExit ?? 0 }
      if (args.includes('symbolic-ref')) {
        if (options.symbolicRef === 'throws') throw new Error('git exploded')
        return options.symbolicRef ?? { stdout: 'origin/main\n', stderr: '', exitCode: 0 }
      }
      if (args.includes('ls-remote')) {
        if (options.lsRemote === 'throws') throw new Error('network down')
        return options.lsRemote ?? { stdout: 'sha\trefs/heads/main\n', stderr: '', exitCode: 0 }
      }
      throw new Error(`unexpected git invocation: ${args.join(' ')}`)
    })
  }

  it('answers every field the eligibility ladder reads, from one call', async () => {
    const { service, config: cfg } = withWorkspace(readinessHost())

    const readiness = await service.prReadiness('repo', cfg)

    // Pinned field-by-field rather than shape-only: each of these is a rung on the ladder, and a rung
    // that silently arrives as `undefined` reads as "condition met" at the far end.
    expect(readiness.auth).toEqual({ kind: 'authenticated' })
    expect(readiness.branch).toBe('feature')
    expect(readiness.baseRef).toBe('main')
    expect(readiness.baseSource).toBe('remote-head')
    expect(readiness.baseExistsOnRemote).toBe(true)
    expect(readiness.upstream).toBe('origin/feature')
    expect(readiness.ahead).toBe(1)
    expect(readiness.behind).toBe(0)
    expect(readiness.hasUncommittedChanges).toBe(false)
    expect(readiness.checkedAt).toBeGreaterThan(0)
  })

  it('strips exactly one leading `origin/` — a branch genuinely named `origin/thing` keeps both segments', async () => {
    // `git symbolic-ref --short refs/remotes/origin/HEAD` prints `origin/<branch>`. Stripping greedily
    // (or with a global replace) would turn `origin/origin/vendor` into `vendor` and target the wrong base.
    const host = readinessHost({ symbolicRef: { stdout: 'origin/origin/vendor\n', stderr: '', exitCode: 0 } })
    const { service, config: cfg } = withWorkspace(host)

    const readiness = await service.prReadiness('repo', cfg)

    expect(readiness.baseRef).toBe('origin/vendor')
    expect(readiness.baseSource).toBe('remote-head')
  })

  it('labels the base as a fallback when `origin/HEAD` is absent — the common case, not an edge', async () => {
    // This very repository has no `refs/remotes/origin/HEAD`: `git clone` writes it, a repo created
    // locally and pushed never gets one. So the label is what lets the UI show a guess AS a guess.
    const host = readinessHost({ symbolicRef: { stdout: '', stderr: 'fatal: ref is not a symbolic ref', exitCode: 128 } })
    const { service, config: cfg } = withWorkspace(host)

    const readiness = await service.prReadiness('repo', cfg)

    expect(readiness.baseSource).toBe('fallback')
    expect(readiness.baseRef).toBe('main')
  })

  it('labels the base as a fallback when git cannot be run at all', async () => {
    const { service, config: cfg } = withWorkspace(readinessHost({ symbolicRef: 'throws' }))

    expect((await service.prReadiness('repo', cfg)).baseSource).toBe('fallback')
  })

  it('reports the base as absent when the remote says it is missing', async () => {
    // `ls-remote --exit-code` exits 2 for "no such ref". That is an ANSWER, and the answer is no.
    const host = readinessHost({ lsRemote: { stdout: '', stderr: '', exitCode: 2 } })
    const { service, config: cfg } = withWorkspace(host)

    expect((await service.prReadiness('repo', cfg)).baseExistsOnRemote).toBe(false)
  })

  it('reports the base as absent when the remote could not be reached — not knowing must block, not invite', async () => {
    // The opposite polarity would let the user click through to a create that then fails deeper in,
    // after `gh` has already been asked to write.
    const { service, config: cfg } = withWorkspace(readinessHost({ lsRemote: 'throws' }))

    expect((await service.prReadiness('repo', cfg)).baseExistsOnRemote).toBe(false)
  })

  it('carries a not-authenticated gh through as-is rather than throwing', async () => {
    // The ladder wants the three-state answer so it can name the fix (`gh auth login`). A throw here
    // would collapse "logged out" into the same nothing as "git is broken".
    const { service, config: cfg } = withWorkspace(readinessHost({ ghExit: 1 }))

    expect((await service.prReadiness('repo', cfg)).auth).toEqual({ kind: 'not-authenticated' })
  })

  it('reads a detached HEAD as no branch, and a dirty tree as dirty', async () => {
    const git = gitStub({
      status: vi.fn(async () => ({
        kind: 'git-repository' as const,
        hostId: 'remote',
        repoPath: '/srv/repo',
        branch: null,
        changes: [
          { path: 'a.ts', origPath: null, index: ' ', worktree: 'M', staged: false, unstaged: true, untracked: false }
        ]
      }))
    })
    const { service, config: cfg } = withWorkspace(readinessHost(), git)

    const readiness = await service.prReadiness('repo', cfg)

    expect(readiness.branch).toBeNull()
    expect(readiness.hasUncommittedChanges).toBe(true)
  })

  it('reads a non-git workspace as no branch and clean, without inventing a branch name', async () => {
    const git = gitStub({
      status: vi.fn(async () => ({
        kind: 'not-a-git-repository' as const,
        hostId: 'remote',
        workspacePath: '/srv/repo'
      }))
    })
    const { service, config: cfg } = withWorkspace(readinessHost(), git)

    const readiness = await service.prReadiness('repo', cfg)

    expect(readiness.branch).toBeNull()
    expect(readiness.hasUncommittedChanges).toBe(false)
  })

  it('asks the remote about the base it actually resolved, not a hardcoded name', async () => {
    // Two independently-computed refs would drift: the hint could confirm `main` exists while the PR
    // would target something else. So the ls-remote must carry the resolved base verbatim.
    const host = readinessHost({ symbolicRef: { stdout: 'origin/trunk\n', stderr: '', exitCode: 0 } })
    const { service, config: cfg } = withWorkspace(host)

    await service.prReadiness('repo', cfg)

    const lsRemote = (host.run as ReturnType<typeof vi.fn>).mock.calls
      .map(([, args]) => args as string[])
      .find((args) => args.includes('ls-remote'))!
    expect(lsRemote).toContain('refs/heads/trunk')
  })

  it('probes both git questions inside the repository, with the same bounded run options as the gh probe', async () => {
    // An unbounded git call in the main process would let a wedged remote hang the readiness read, and
    // the whole point of `-C <repo>` is that the answer is about THIS workspace.
    const host = readinessHost()
    const { service, config: cfg } = withWorkspace(host)

    await service.prReadiness('repo', cfg)

    const gitCalls = (host.run as ReturnType<typeof vi.fn>).mock.calls.filter(([command]) => command === 'git')
    expect(gitCalls).toHaveLength(2)
    for (const [, args, options] of gitCalls) {
      expect((args as string[]).slice(0, 2)).toEqual(['-C', '/srv/repo'])
      expect(options).toEqual(GH_RUN_OPTIONS)
    }
  })
})
