import { describe, expect, it, vi } from 'vitest'
import { afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalExecutionHost, type ExecutionHost } from '@agentmux/core'
import type { AppConfig } from '../src/shared/contracts.js'
import { GitService, classifyGitRemoteError } from '../src/main/git-service.js'

const config: AppConfig = {
  version: 9,
  hosts: [{ id: 'local', kind: 'local', label: 'This Mac' }],
  executors: {},
  workspaces: [],
  appearance: { terminalTheme: 'graphite' },
  browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, more: true } }
}

const NONINTERACTIVE_ENV = {
  LC_ALL: 'C',
  LANG: 'C',
  GIT_TERMINAL_PROMPT: '0',
  GIT_SSH_COMMAND: 'ssh -o BatchMode=yes'
}
// Local plumbing (rev-parse/rev-list) keeps the short local bound; network verbs get a longer one so
// a real push/pull is not killed mid-transfer — the no-hang guarantee comes from the env, not the clock.
const LOCAL_OPTIONS = { env: NONINTERACTIVE_ENV, timeoutMs: 20_000, maxOutputBytes: 2 * 1024 * 1024 }
const REMOTE_OPTIONS = { env: NONINTERACTIVE_ENV, timeoutMs: 120_000, maxOutputBytes: 4 * 1024 * 1024 }

type RunResult = { command: string; args: readonly string[]; exitCode: number; stdout: string; stderr: string; durationMs: number }

function gitResult(args: readonly string[], stdout = '', stderr = '', exitCode = 0): RunResult {
  return { command: 'git', args, exitCode, stdout, stderr, durationMs: 1 }
}

/**
 * A fake host that answers the plumbing GitService leans on for remote work: repo-root resolution,
 * upstream resolution (`@{push}` then `@{upstream}`), ahead/behind counting, and the push/pull/fetch
 * verbs themselves. Each verb is overridable so a test can inject a rejection or a two-phase sequence.
 */
function remoteHost(handlers: {
  push?: (args: readonly string[]) => RunResult
  pull?: (args: readonly string[]) => RunResult
  fetch?: (args: readonly string[]) => RunResult
  pushRef?: () => RunResult
  upstreamRef?: () => RunResult
  revList?: (args: readonly string[]) => RunResult
} = {}): ExecutionHost {
  return {
    id: 'remote',
    kind: 'ssh',
    label: 'Remote',
    exposeLoopbackPort: vi.fn(async (port: number) => port),
    dispose: vi.fn(async () => {}),
    run: vi.fn(async (_command: string, args: readonly string[]) => {
      if (args.includes('rev-parse') && args.includes('--show-toplevel')) return gitResult(args, '/srv/repo\n')
      if (args.includes('rev-parse') && args.includes('--symbolic-full-name')) {
        if (args.includes('@{push}')) return handlers.pushRef?.() ?? gitResult(args, '', '', 1)
        if (args.includes('@{upstream}')) return handlers.upstreamRef?.() ?? gitResult(args, '', '', 1)
        return gitResult(args, '', '', 1)
      }
      if (args.includes('rev-list')) return handlers.revList?.(args) ?? gitResult(args, '0\t0\n')
      if (args.includes('push')) return handlers.push?.(args) ?? gitResult(args)
      if (args.includes('pull')) return handlers.pull?.(args) ?? gitResult(args)
      if (args.includes('fetch')) return handlers.fetch?.(args) ?? gitResult(args)
      return gitResult(args)
    })
  }
}

function withWorkspace(host: ExecutionHost): { service: GitService; config: AppConfig } {
  const service = new GitService(() => host)
  return {
    service,
    config: {
      ...config,
      workspaces: [{ id: 'repo', name: 'repo', hostId: 'remote', path: '/srv/repo', kind: 'folder' }]
    }
  }
}

describe('classifyGitRemoteError (pure)', () => {
  it('scrubs an embedded credential out of a surfaced error before it can reach the UI or a log', () => {
    const failure = classifyGitRemoteError({
      stdout: '',
      stderr: "fatal: unable to access 'https://alice:ghp_secret@github.com/o/r.git/': The requested URL returned error: 403"
    })
    expect(failure.kind).toBe('error')
    expect(failure.message).toContain('***@github.com')
    expect(failure.message).not.toContain('ghp_secret')
    expect(failure.message).not.toContain('alice')
  })

  // The bare-token form carries the whole secret in the userinfo with NO colon — it is how CI and
  // `git remote set-url origin https://$TOKEN@github.com/...` embed a PAT, so it is at least as common
  // as user:pass. A scrub that only matches a colon-separated pair leaks this one verbatim.
  it('scrubs a bare token with no password half, the form CI actually uses', () => {
    const failure = classifyGitRemoteError({
      stdout: '',
      stderr: "fatal: unable to access 'https://ghp_REALTOKEN123@github.com/o/r.git/': 403"
    })
    expect(failure.message).not.toContain('ghp_REALTOKEN123')
    expect(failure.message).toContain('***@github.com')
  })

  it('leaves an ssh username intact — git@host is an identity, not a secret', () => {
    const failure = classifyGitRemoteError({
      stdout: '',
      stderr: 'fatal: could not read from remote repository git@github.com:o/r.git'
    })
    // Redacting this would destroy the only useful detail in the message without hiding anything.
    expect(failure.message).toContain('git@github.com')
  })

  it('swallows only a real "no upstream" fatal — the phrase must carry the fatal: prefix', () => {
    expect(classifyGitRemoteError({ stdout: '', stderr: "fatal: no upstream configured for branch 'main'" }).kind).toBe(
      'no-upstream'
    )
    expect(
      classifyGitRemoteError({ stdout: '', stderr: 'fatal: The current branch feature has no upstream branch.' }).kind
    ).toBe('no-upstream')
    // 第三个 alternation：detached HEAD 上 push 时 git 打的就是这句。实测过：把它从正则里去掉，
    // 这个文件 28 条全绿。后果不是数据损坏而是分类精度下降——git-remote-outcome 那格本该给
    // 「先 checkout 一个分支」的可行动提示，退化成直接甩 git 原话。
    expect(
      classifyGitRemoteError({ stdout: '', stderr: 'fatal: You are not currently on a branch.' }).kind
    ).toBe('no-upstream')
  })

  it('never lets a non-fatal line that merely mentions "no upstream" masquerade as no-upstream', () => {
    // A hook or progress line can echo arbitrary words — even git's own known phrase — without the
    // fatal: prefix. The prefix is the gate: the same phrase carried by a `remote:`/`hint:` line is a
    // real error, not a benign missing-upstream, and must surface rather than be swallowed. Feeding the
    // exact guarded phrase here (minus the prefix) is what keeps the fatal: anchor load-bearing.
    expect(
      classifyGitRemoteError({ stdout: '', stderr: 'remote: note: there is no upstream mirror here' }).kind
    ).toBe('error')
    expect(
      classifyGitRemoteError({
        stdout: '',
        stderr: "hint: no upstream configured for branch 'main' (echoed by a hook, not a fatal)"
      }).kind
    ).toBe('error')
    expect(
      classifyGitRemoteError({ stdout: '', stderr: 'remote: The current branch feature has no upstream branch. FYI' }).kind
    ).toBe('error')
  })

  it('classifies an auth failure as a surfaced error, not as no-upstream', () => {
    const failure = classifyGitRemoteError({
      stdout: '',
      stderr: "fatal: Authentication failed for 'https://github.com/o/r.git/'"
    })
    expect(failure.kind).toBe('error')
  })

  it('turns a non-fast-forward push rejection into an actionable, credential-free message', () => {
    const failure = classifyGitRemoteError({
      stdout: '',
      stderr: [
        "To https://alice:ghp_secret@github.com/o/r.git",
        ' ! [rejected]        main -> main (non-fast-forward)',
        "error: failed to push some refs to 'https://alice:ghp_secret@github.com/o/r.git'",
        'hint: Updates were rejected because the tip of your current branch is behind'
      ].join('\n')
    })
    expect(failure.kind).toBe('non-fast-forward')
    expect(failure.message.length).toBeGreaterThan(0)
    expect(failure.message).not.toContain('ghp_secret')
  })

  it('recognizes a diverged pull (fast-forward impossible / reconcile needed)', () => {
    expect(
      classifyGitRemoteError({ stdout: '', stderr: 'fatal: Not possible to fast-forward, aborting.' }).kind
    ).toBe('diverged')
    expect(
      classifyGitRemoteError({
        stdout: '',
        stderr: 'fatal: Need to specify how to reconcile divergent branches.'
      }).kind
    ).toBe('diverged')
  })

  it('surfaces a corrupt/unknown failure verbatim (scrubbed) rather than mislabeling it', () => {
    const failure = classifyGitRemoteError({ stdout: '', stderr: 'error: object file .git/objects/ab/cd is empty' })
    expect(failure.kind).toBe('error')
    expect(failure.message).toContain('object file')
  })
})

describe('GitService.push (fake executor)', () => {
  it('pushes origin HEAD with --set-upstream through a non-interactive env by default', async () => {
    const host = remoteHost()
    const { service, config: cfg } = withWorkspace(host)

    await expect(service.push('repo', cfg)).resolves.toEqual({ kind: 'ok' })

    expect(host.run).toHaveBeenCalledWith(
      'git',
      ['-C', '/srv/repo', 'push', '--set-upstream', 'origin', 'HEAD'],
      REMOTE_OPTIONS
    )
  })

  it('adds --force-with-lease before --set-upstream when asked, never a bare --force', async () => {
    const host = remoteHost()
    const { service, config: cfg } = withWorkspace(host)

    await service.push('repo', cfg, { forceWithLease: true })

    expect(host.run).toHaveBeenCalledWith(
      'git',
      ['-C', '/srv/repo', 'push', '--force-with-lease', '--set-upstream', 'origin', 'HEAD'],
      REMOTE_OPTIONS
    )
  })

  it('turns a rejected push into a non-fast-forward result without leaking the remote credential', async () => {
    const host = remoteHost({
      push: () =>
        gitResult(
          [],
          '',
          [
            "To https://alice:ghp_secret@github.com/o/r.git",
            ' ! [rejected]        main -> main (non-fast-forward)',
            "error: failed to push some refs to 'https://alice:ghp_secret@github.com/o/r.git'"
          ].join('\n'),
          1
        )
    })
    const { service, config: cfg } = withWorkspace(host)

    const result = await service.push('repo', cfg)
    expect(result.kind).toBe('non-fast-forward')
    if (result.kind === 'ok') throw new Error('expected a failure')
    expect(result.message).not.toContain('ghp_secret')
  })

  it('rejects a remote or refspec that begins with a dash before any git call (flag injection)', async () => {
    const host = remoteHost()
    const { service, config: cfg } = withWorkspace(host)

    await expect(service.push('repo', cfg, { remote: '--upload-pack=sh' })).rejects.toThrow()
    await expect(service.push('repo', cfg, { refspec: '--force' })).rejects.toThrow()
    expect(host.run).not.toHaveBeenCalled()
  })

  // assertSafeRef 有三道闸：空串、`-` 前缀、以及 git 自己就禁止的那组控制/空白/ref 元字符。上面那条
  // 只喂 dash 前缀的输入，全部被第二道闸拦下——第三道字符类闸因此**没有任何独占靶子**。实测过：
  // 把那一整行 `if (/[\0\n\r\t ~^:?*[\\]/.test(value)) throw` 删掉，git-remote-error + git-service +
  // git-diff 共 65 条全绿。
  //
  // 今天是潜伏的：GitPushOptions.remote/refspec 透传到 preload 与 ipc，但还没有面板给用户填自定义
  // remote/refspec。一旦加上「push 到指定 remote/分支」那个输入框，这道 flag/ref 注入防线的一半就
  // 静默失效。判据按闸分靶：dash 归上一条，元字符归这条，删任一道都有人红。
  it('rejects a ref carrying the control/metacharacter bytes git forbids, before any git call', async () => {
    const host = remoteHost()
    const { service, config: cfg } = withWorkspace(host)

    // 每一个都不带 dash 前缀，所以只有第三道闸能拦住它们。
    await expect(service.push('repo', cfg, { remote: 'ori gin' })).rejects.toThrow()
    await expect(service.push('repo', cfg, { remote: 'a~b' })).rejects.toThrow()
    await expect(service.push('repo', cfg, { refspec: 'HEAD^' })).rejects.toThrow()
    await expect(service.push('repo', cfg, { refspec: 'refs/heads/*' })).rejects.toThrow()
    await expect(service.push('repo', cfg, { refspec: 'HEAD:main:extra' })).rejects.toThrow()
    await expect(service.fetch('repo', cfg, { remote: 'orig\nin' })).rejects.toThrow()
    // 拒绝必须发生在拼 argv 之前：抛得晚一点等于那串字节已经进过一次 git。
    expect(host.run).not.toHaveBeenCalled()
  })

  // 自检：上面全是拒绝断言，于是「assertSafeRef 变成无条件 throw」也能让它们全过——那会把合法的
  // 自定义 remote 一起毙掉，而这条测试对此完全失明。所以再钉一次正向：一个干净的 remote 必须过闸
  // 并真的到达 git。
  it('lets a clean custom remote through the same gate', async () => {
    const host = remoteHost()
    const { service, config: cfg } = withWorkspace(host)

    await expect(service.push('repo', cfg, { remote: 'upstream' })).resolves.toBeDefined()
    expect(host.run).toHaveBeenCalled()
  })
})

describe('GitService.pull (fake executor)', () => {
  it('exposes fast-forward-only as its own pinned strategy', async () => {
    const host = remoteHost()
    const { service, config: cfg } = withWorkspace(host)

    await service.pull('repo', cfg, { strategy: 'ff-only' })

    // No positional remote/refspec: pull integrates the configured upstream, the same as a bare
    // `git pull`. `origin HEAD` is a push idiom — git would read HEAD as a remote ref to fetch.
    expect(host.run).toHaveBeenCalledWith('git', ['-C', '/srv/repo', 'pull', '--ff-only'], REMOTE_OPTIONS)
  })

  it('passes --no-rebase for a pinned merge and --rebase for a pinned rebase', async () => {
    const mergeHost = remoteHost()
    const merge = withWorkspace(mergeHost)
    await merge.service.pull('repo', merge.config, { strategy: 'merge' })
    expect(mergeHost.run).toHaveBeenCalledWith('git', ['-C', '/srv/repo', 'pull', '--no-rebase'], REMOTE_OPTIONS)

    const rebaseHost = remoteHost()
    const rebase = withWorkspace(rebaseHost)
    await rebase.service.pull('repo', rebase.config, { strategy: 'rebase' })
    expect(rebaseHost.run).toHaveBeenCalledWith('git', ['-C', '/srv/repo', 'pull', '--rebase'], REMOTE_OPTIONS)
  })

  it('falls back to a merge when an unpinned pull hard-fails on divergent branches', async () => {
    // The host has no pull.rebase/pull.ff policy, so a bare pull on a diverged branch fatals with
    // "Need to specify how to reconcile divergent branches." The service must not surface that raw —
    // it retries once with an explicit merge, which is the auto-merge fallback.
    let bareCalls = 0
    const host = remoteHost({
      pull: (args) => {
        if (args.includes('--no-rebase')) return gitResult(args, "Merge made by the 'ort' strategy.\n")
        bareCalls += 1
        return gitResult(args, '', 'fatal: Need to specify how to reconcile divergent branches.', 128)
      }
    })
    const { service, config: cfg } = withWorkspace(host)

    const result = await service.pull('repo', cfg)
    expect(result).toEqual({ kind: 'ok' })
    expect(bareCalls).toBe(1)
    // First a bare pull (no strategy flag), then the merge retry.
    expect(host.run).toHaveBeenCalledWith('git', ['-C', '/srv/repo', 'pull'], REMOTE_OPTIONS)
    expect(host.run).toHaveBeenCalledWith('git', ['-C', '/srv/repo', 'pull', '--no-rebase'], REMOTE_OPTIONS)
  })

  it('does NOT fall back when the caller pinned ff-only — the diverged result is surfaced', async () => {
    let calls = 0
    const host = remoteHost({
      pull: (args) => {
        calls += 1
        return gitResult(args, '', 'fatal: Not possible to fast-forward, aborting.', 128)
      }
    })
    const { service, config: cfg } = withWorkspace(host)

    const result = await service.pull('repo', cfg, { strategy: 'ff-only' })
    expect(result.kind).toBe('diverged')
    expect(calls).toBe(1)
  })
})

describe('GitService.fetch (fake executor)', () => {
  it('fetches with --prune from origin by default', async () => {
    const host = remoteHost()
    const { service, config: cfg } = withWorkspace(host)

    await expect(service.fetch('repo', cfg)).resolves.toEqual({ kind: 'ok' })

    expect(host.run).toHaveBeenCalledWith('git', ['-C', '/srv/repo', 'fetch', '--prune', 'origin'], REMOTE_OPTIONS)
  })

  it('rejects a dash-prefixed remote before any git call', async () => {
    const host = remoteHost()
    const { service, config: cfg } = withWorkspace(host)

    await expect(service.fetch('repo', cfg, { remote: '--exec=sh' })).rejects.toThrow()
    expect(host.run).not.toHaveBeenCalled()
  })
})

describe('GitService.aheadBehind (fake executor)', () => {
  it('counts against the real push target when a branch tracks origin/main but pushes origin/feature', async () => {
    // The effective upstream is the push target (@{push}), not the configured upstream (@{upstream}).
    const host = remoteHost({
      pushRef: () => gitResult([], 'refs/remotes/origin/feature\n'),
      upstreamRef: () => gitResult([], 'refs/remotes/origin/main\n'),
      revList: (args) =>
        args.some((a) => a.includes('refs/remotes/origin/feature')) ? gitResult(args, '1\t0\n') : gitResult(args, '2\t0\n')
    })
    const { service, config: cfg } = withWorkspace(host)

    await expect(service.aheadBehind('repo', cfg)).resolves.toEqual({
      upstream: 'refs/remotes/origin/feature',
      ahead: 1,
      behind: 0
    })
    // @{push} / @{upstream} are magic revisions: they must be plain revision args, never behind
    // --end-of-options (git cannot resolve them there), and resolution uses --verify --quiet so a
    // missing ref is a clean exit-1 rather than a fatal.
    expect(host.run).toHaveBeenCalledWith(
      'git',
      ['-C', '/srv/repo', 'rev-parse', '--symbolic-full-name', '--verify', '--quiet', '@{push}'],
      LOCAL_OPTIONS
    )
    expect(host.run).toHaveBeenCalledWith(
      'git',
      ['-C', '/srv/repo', 'rev-list', '--left-right', '--count', 'HEAD...refs/remotes/origin/feature'],
      LOCAL_OPTIONS
    )
  })

  it('falls back to the configured upstream when the push target does not exist yet', async () => {
    const host = remoteHost({
      pushRef: () => gitResult([], '', '', 1),
      upstreamRef: () => gitResult([], 'refs/remotes/origin/main\n'),
      revList: (args) => gitResult(args, '3\t2\n')
    })
    const { service, config: cfg } = withWorkspace(host)

    await expect(service.aheadBehind('repo', cfg)).resolves.toEqual({
      upstream: 'refs/remotes/origin/main',
      ahead: 3,
      behind: 2
    })
  })

  it('counts against a local-branch upstream (refs/heads/...) the same way', async () => {
    const host = remoteHost({
      pushRef: () => gitResult([], '', '', 1),
      upstreamRef: () => gitResult([], 'refs/heads/main\n'),
      revList: (args) => gitResult(args, '1\t0\n')
    })
    const { service, config: cfg } = withWorkspace(host)

    await expect(service.aheadBehind('repo', cfg)).resolves.toEqual({
      upstream: 'refs/heads/main',
      ahead: 1,
      behind: 0
    })
  })

  it('reports no upstream (zero/zero) when neither push target nor configured upstream resolves', async () => {
    const host = remoteHost({
      pushRef: () => gitResult([], '', '', 1),
      upstreamRef: () => gitResult([], '', '', 1)
    })
    const { service, config: cfg } = withWorkspace(host)

    await expect(service.aheadBehind('repo', cfg)).resolves.toEqual({ upstream: null, ahead: 0, behind: 0 })
  })
})

// These exercise real git against throwaway repositories, proving the argv the fakes assert actually
// drive git the way the derived conclusions claim: fetch really writes FETCH_HEAD (not a no-op that
// still "passes"), ahead/behind counts the effective upstream, and the unpinned pull fallback merges a
// diverged branch a bare pull would refuse on a host with no reconcile policy.
describe('GitService remote verbs (real git, temporary repositories)', () => {
  const temporaryRoots: string[] = []

  afterEach(async () => {
    await Promise.all(temporaryRoots.splice(0).map(async (path) => await rm(path, { recursive: true, force: true })))
  })

  async function gitIn(root: string, args: string[]): Promise<string> {
    const host = new LocalExecutionHost()
    // Isolate from the developer's global/system git config (pull.rebase etc.) so "no reconcile policy"
    // is actually reproduced, and so identity comes only from the repo-local config set below.
    const result = await host.run('git', ['-C', root, ...args], {
      timeoutMs: 20_000,
      env: { HOME: root, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(root, '.gitconfig-none') }
    })
    if (result.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`)
    return result.stdout
  }

  async function scratch(prefix: string): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), `agentmux-remote-${prefix}-`))
    temporaryRoots.push(root)
    return root
  }

  async function makeClone(remote: string, prefix: string): Promise<string> {
    const root = await scratch(prefix)
    await gitIn(process.cwd(), ['clone', '-q', remote, root])
    await gitIn(root, ['config', 'user.email', 't@example.com'])
    await gitIn(root, ['config', 'user.name', 'Test'])
    return root
  }

  function serviceFor(root: string): { service: GitService; config: AppConfig } {
    return {
      service: new GitService(() => new LocalExecutionHost()),
      config: { ...config, workspaces: [{ id: 'repo', name: 'repo', hostId: 'local', path: root, kind: 'folder' }] }
    }
  }

  async function seededRemote(): Promise<string> {
    const remote = await scratch('bare')
    await gitIn(process.cwd(), ['init', '-q', '--bare', remote])
    const seed = await makeClone(remote, 'seed')
    await gitIn(seed, ['commit', '-q', '--allow-empty', '-m', 'init'])
    await gitIn(seed, ['push', '-q', 'origin', 'HEAD:refs/heads/main'])
    return remote
  }

  it('push publishes the branch and sets upstream, then ahead/behind reads zero/zero', async () => {
    const remote = await seededRemote()
    const work = await makeClone(remote, 'work')
    await gitIn(work, ['checkout', '-q', 'main'])
    await gitIn(work, ['commit', '-q', '--allow-empty', '-m', 'local'])

    const { service, config: cfg } = serviceFor(work)
    await expect(service.push('repo', cfg)).resolves.toEqual({ kind: 'ok' })

    const ahead = await service.aheadBehind('repo', cfg)
    expect(ahead).toEqual({ upstream: 'refs/remotes/origin/main', ahead: 0, behind: 0 })
  })

  it('a second push of a diverged branch is rejected as non-fast-forward, credential-free', async () => {
    const remote = await seededRemote()
    const a = await makeClone(remote, 'a')
    const b = await makeClone(remote, 'b')
    await gitIn(a, ['checkout', '-q', 'main'])
    await gitIn(b, ['checkout', '-q', 'main'])
    // b pushes first; a is now behind and its push cannot fast-forward.
    await gitIn(b, ['commit', '-q', '--allow-empty', '-m', 'b1'])
    await gitIn(b, ['push', '-q', 'origin', 'HEAD:refs/heads/main'])
    await gitIn(a, ['commit', '-q', '--allow-empty', '-m', 'a1'])

    const { service, config: cfg } = serviceFor(a)
    const result = await service.push('repo', cfg)
    expect(result.kind).toBe('non-fast-forward')
  })

  it('fetch --prune really contacts the remote (FETCH_HEAD is written)', async () => {
    const remote = await seededRemote()
    const work = await makeClone(remote, 'fetch')

    const { service, config: cfg } = serviceFor(work)
    await expect(service.fetch('repo', cfg)).resolves.toEqual({ kind: 'ok' })
    // A no-op that still returned ok would not have written FETCH_HEAD; reading it proves real contact.
    const head = await gitIn(work, ['rev-parse', '--verify', 'FETCH_HEAD'])
    expect(head.trim()).toMatch(/^[0-9a-f]{40}$/)
  })

  it('an unpinned pull auto-merges a diverged branch a bare pull would refuse without a reconcile policy', async () => {
    const remote = await seededRemote()
    const other = await makeClone(remote, 'other')
    const work = await makeClone(remote, 'diverge')
    await gitIn(work, ['checkout', '-q', 'main'])
    await gitIn(work, ['branch', '--set-upstream-to=origin/main', 'main'])
    // Remote advances; local advances on a different commit → divergence.
    await gitIn(other, ['checkout', '-q', 'main'])
    await gitIn(other, ['commit', '-q', '--allow-empty', '-m', 'remote-c'])
    await gitIn(other, ['push', '-q', 'origin', 'HEAD:refs/heads/main'])
    await gitIn(work, ['commit', '-q', '--allow-empty', '-m', 'local-c'])

    const { service, config: cfg } = serviceFor(work)
    // No pull.rebase / pull.ff policy anywhere (config is isolated), so a bare pull would fatal with
    // "Need to specify how to reconcile divergent branches." The unpinned fallback retries as a merge.
    const result = await service.pull('repo', cfg)
    expect(result).toEqual({ kind: 'ok' })
    // The merge produced a commit with two parents.
    const parents = await gitIn(work, ['rev-list', '--parents', '-n', '1', 'HEAD'])
    expect(parents.trim().split(/\s+/).length).toBe(3)
  })

  it('ahead/behind counts the push target when a branch tracks origin/main but pushes origin/<branch>', async () => {
    const remote = await seededRemote()
    const work = await makeClone(remote, 'triangular')
    // Create origin/feature so the push target exists as a tracking ref.
    await gitIn(work, ['checkout', '-q', '-b', 'feature'])
    await gitIn(work, ['commit', '-q', '--allow-empty', '-m', 'f1'])
    await gitIn(work, ['push', '-q', '-u', 'origin', 'feature'])
    // Now reconfigure: feature tracks origin/main for reads but pushes to origin/feature.
    await gitIn(work, ['branch', '--set-upstream-to=origin/main', 'feature'])
    await gitIn(work, ['config', 'push.default', 'current'])
    await gitIn(work, ['config', 'remote.pushDefault', 'origin'])
    // One local commit past origin/feature; origin/main is the same as origin/feature's base here.
    await gitIn(work, ['commit', '-q', '--allow-empty', '-m', 'f2'])
    await gitIn(work, ['fetch', '-q'])

    const { service, config: cfg } = serviceFor(work)
    const result = await service.aheadBehind('repo', cfg)
    // The effective upstream is the push target origin/feature (ahead 1), NOT the configured
    // origin/main. If the service read @{upstream} instead, the count would differ.
    expect(result.upstream).toBe('refs/remotes/origin/feature')
    expect(result.ahead).toBe(1)
    expect(result.behind).toBe(0)
  })
})

