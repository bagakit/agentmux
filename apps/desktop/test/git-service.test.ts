import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalExecutionHost, type ExecutionHost } from '@agentmux/core'
import type { AppConfig } from '../src/shared/contracts.js'
import { GitService, isNotAGitRepositoryStderr, isNotAWorkingTreeStderr } from '../src/main/git-service.js'

const config: AppConfig = {
  version: 7,
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
const RUN_OPTIONS = { env: NONINTERACTIVE_ENV, timeoutMs: 20_000, maxOutputBytes: 2 * 1024 * 1024 }

const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(async (path) => await rm(path, { recursive: true, force: true })))
})

function gitResult(args: readonly string[], stdout = '', stderr = '', exitCode = 0) {
  return { command: 'git', args, exitCode, stdout, stderr, durationMs: 1 }
}

/** A fake host that resolves the repo root and answers each git verb with canned output. */
function gitHost(handlers: {
  status?: () => ReturnType<typeof gitResult>
  add?: (args: readonly string[]) => ReturnType<typeof gitResult>
  commit?: (args: readonly string[], input?: unknown) => ReturnType<typeof gitResult>
} = {}): ExecutionHost {
  return {
    id: 'remote',
    kind: 'ssh',
    label: 'Remote',
    exposeLoopbackPort: vi.fn(async (port: number) => port),
    dispose: vi.fn(async () => {}),
    run: vi.fn(async (_command: string, args: readonly string[], options?: { input?: unknown }) => {
      if (args.includes('rev-parse')) return gitResult(args, '/srv/repo\n')
      if (args.includes('status')) return handlers.status?.() ?? gitResult(args, '## main\0')
      if (args.includes('add')) return handlers.add?.(args) ?? gitResult(args)
      if (args.includes('commit')) return handlers.commit?.(args, options?.input) ?? gitResult(args)
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

describe('GitService (contract, fake executor)', () => {
  it('reads status at the working-tree root with a non-interactive, locale-locked env', async () => {
    const host = gitHost({ status: () => gitResult([], '## main\0 M a.txt\0?? b.txt\0') })
    const { service, config: cfg } = withWorkspace(host)

    const result = await service.status('repo', cfg)

    expect(result).toEqual({
      kind: 'git-repository',
      hostId: 'remote',
      repoPath: '/srv/repo',
      branch: 'main',
      changes: [
        { path: 'a.txt', origPath: null, index: ' ', worktree: 'M', staged: false, unstaged: true, untracked: false },
        { path: 'b.txt', origPath: null, index: '?', worktree: '?', staged: false, unstaged: false, untracked: true }
      ]
    })
    expect(host.run).toHaveBeenCalledWith(
      'git',
      ['-C', '/srv/repo', 'status', '--porcelain=v1', '-z', '--branch', '--untracked-files=all'],
      RUN_OPTIONS
    )
  })

  it('models a plain folder as a non-Git state rather than throwing', async () => {
    const host = gitHost()
    vi.mocked(host.run).mockImplementation(async (_command, args) =>
      gitResult(args, '', 'fatal: not a git repository (or any of the parent directories): .git\n', 128)
    )
    const { service, config: cfg } = withWorkspace(host)

    await expect(service.status('repo', cfg)).resolves.toEqual({
      kind: 'not-a-git-repository',
      hostId: 'remote',
      workspacePath: '/srv/repo'
    })
  })

  /**
   * 非零退出**不等于**「不是仓库」。判据必须读 git 说了什么，而不只是它退了几。
   *
   * 为什么必须单独钉：上一条「plain folder」测试把**所有** git 调用都 mock 成那条
   * `not a git repository` fatal，于是「读 stderr」与「只读 exitCode」两种写法在那个 fixture 下算出
   * 同一个答案——它无法区分二者。实测把 :611 的谓词化简成 `if (result.exitCode !== 0) return null`
   * （正是那处注释自己警告的 careless refactor），这个文件 8 条全绿。
   *
   * 后果覆盖整个 Source Control 面板：`resolveRepoPath` 喂给 status/stage/commit/diff 四个方法
   * （:335 :358 :375 :590）。谓词化简后，只要 git 因**任何**原因非零退出（权限不足、dubious
   * ownership、仓库损坏、git 二进制缺失、index.lock 冲突），面板都答「未关联 Git 仓库」：用户在一个
   * 明明是仓库的目录里失去暂存、提交、看 diff 的全部入口，而**真因被吞掉**，界面上没有任何线索。
   *
   * 孪生谓词在 worktree-service.ts:303 有同一份判断，那一份被守住了
   * （worktree-service.test.ts「keeps unrelated Git discovery failures fail-closed」，等价变异实测
   * 5 failed | 23 passed）。这一条是把那个样板补到这一侧。
   */
  it.each([
    'fatal: detected dubious ownership in repository at /srv/repo\n',
    'fatal: cannot change to /srv/repo: Permission denied\n',
    'error: object file .git/objects/ab/cdef is empty\n',
    'fatal: Unable to create /srv/repo/.git/index.lock: File exists.\n'
  ])('把非零退出的真错误如实抛出，绝不压平成「不是仓库」: %s', async (stderr) => {
    const host = gitHost()
    vi.mocked(host.run).mockImplementation(async (_command, args) => gitResult(args, '', stderr, 128))
    const { service, config: cfg } = withWorkspace(host)

    // 断言落在 status 上——它是唯一把 null 变成一个**用户可见状态**的入口，所以「压平」在这里可观测。
    await expect(
      service.status('repo', cfg),
      '一个真正的 git 失败被压平成「不是仓库」，用户看不到真因也失去全部 git 入口'
    ).rejects.toThrow(stderr.trim())
  })

  it('stages a file through -- and a :(literal) pathspec so a name is never read as a flag', async () => {
    const host = gitHost()
    const { service, config: cfg } = withWorkspace(host)

    await service.stage('repo', '-rf dangerous.txt', cfg)

    expect(host.run).toHaveBeenCalledWith(
      'git',
      ['-C', '/srv/repo', 'add', '--', ':(literal)-rf dangerous.txt'],
      RUN_OPTIONS
    )
  })

  it('rejects an empty path before any git call', async () => {
    const host = gitHost()
    const { service, config: cfg } = withWorkspace(host)

    await expect(service.stage('repo', '', cfg)).rejects.toThrow('A file path is required')
    expect(host.run).not.toHaveBeenCalled()
  })

  it('passes the commit message over stdin, never in argv', async () => {
    let seenInput: unknown
    const host = gitHost({
      commit: (_args, input) => {
        seenInput = input
        return gitResult([], '[main abc] done\n')
      }
    })
    const { service, config: cfg } = withWorkspace(host)

    await service.commit('repo', '  a message starting with -m  ', cfg)

    expect(seenInput).toBe('a message starting with -m')
    expect(host.run).toHaveBeenCalledWith(
      'git',
      ['-C', '/srv/repo', 'commit', '--file=-', '--cleanup=whitespace'],
      { ...RUN_OPTIONS, input: 'a message starting with -m' }
    )
  })

  it('rejects an empty commit message before any git call', async () => {
    const host = gitHost()
    const { service, config: cfg } = withWorkspace(host)

    await expect(service.commit('repo', '   ', cfg)).rejects.toThrow('A commit message is required')
    expect(host.run).not.toHaveBeenCalled()
  })

  it('scrubs credentials out of a failing git error before it can surface', async () => {
    const host = gitHost({
      commit: () => gitResult(
        [],
        '',
        'fatal: unable to access https://alice:ghp_secret@github.com/o/r.git/',
        128
      )
    })
    const { service, config: cfg } = withWorkspace(host)

    await expect(service.commit('repo', 'msg', cfg)).rejects.toThrow(/\*\*\*@github\.com/)
    await expect(service.commit('repo', 'msg', cfg)).rejects.not.toThrow(/ghp_secret/)
  })
})

describe('GitService (real git, temporary repository)', () => {
  async function makeRepo(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'agentmux-git-'))
    temporaryRoots.push(root)
    const host = new LocalExecutionHost()
    const run = async (args: string[], input?: string) => {
      const result = await host.run('git', ['-C', root, ...args], {
        timeoutMs: 20_000,
        ...(input === undefined ? {} : { input })
      })
      if (result.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`)
      return result
    }
    await run(['init', '-q'])
    // Identity is set repo-local, not via env: GitService.commit deliberately runs with only its
    // non-interactive env, so it must inherit the identity from git config the way a real checkout
    // does. This also proves the service does not depend on author env being passed in.
    await run(['config', 'user.email', 't@example.com'])
    await run(['config', 'user.name', 'Test'])
    await run(['commit', '-q', '--allow-empty', '-m', 'init'])
    return root
  }

  it('sees a change, stages exactly it, and commits it — the full slice against real git', async () => {
    const root = await makeRepo()
    // A name that begins with a dash and contains a space: the exact shape the argv hardening exists
    // for. If the `--`/`:(literal)` guard regressed, `git add` would read it as a flag and fail.
    const fileName = '-tricky name.txt'
    await writeFile(join(root, fileName), 'hello\n')

    const service = new GitService(() => new LocalExecutionHost())
    const cfg: AppConfig = {
      ...config,
      workspaces: [{ id: 'repo', name: 'repo', hostId: 'local', path: root, kind: 'folder' }]
    }

    const before = await service.status('repo', cfg)
    expect(before.kind).toBe('git-repository')
    if (before.kind !== 'git-repository') throw new Error('expected a git repository')
    expect(before.branch).not.toBeNull()
    const untracked = before.changes.find((change) => change.path === fileName)
    expect(untracked).toMatchObject({ untracked: true, staged: false })

    await service.stage('repo', fileName, cfg)
    const staged = await service.status('repo', cfg)
    if (staged.kind !== 'git-repository') throw new Error('expected a git repository')
    expect(staged.changes.find((change) => change.path === fileName)).toMatchObject({ staged: true })

    await service.commit('repo', 'add the tricky file', cfg)
    const after = await service.status('repo', cfg)
    if (after.kind !== 'git-repository') throw new Error('expected a git repository')
    expect(after.changes.find((change) => change.path === fileName)).toBeUndefined()
  })

  // Both stderr predicates say in their own docs that the anchoring is the load-bearing part: an
  // unanchored match would also accept a stderr that merely *mentions* the phrase beside a real error,
  // and the callers then flatten a genuine failure into a benign classification. Nothing asserted that
  // until now — dropping the `^`/`$` from either pattern left the whole suite green.
  //
  // The sentences come from running real git rather than from string literals here, because a literal
  // would be a second hand-written copy of the very claim under test: it would keep passing after git
  // changed its wording, and it could be "fixed" by editing the copy instead of the pattern.
  it('the two stderr predicates accept only git\'s own whole sentence, never a mention inside a longer error', async () => {
    const root = await makeRepo()
    const host = new LocalExecutionHost()
    const plainDirectory = await mkdtemp(join(tmpdir(), 'agentmux-git-notrepo-'))
    temporaryRoots.push(plainDirectory)

    const notARepository = await host.run('git', ['-C', plainDirectory, 'status', '--porcelain'],
      { timeoutMs: 20_000 })
    const notAWorkingTree = await host.run(
      'git', ['-C', root, 'worktree', 'remove', '--', join(root, 'never-a-worktree')],
      { timeoutMs: 20_000 })

    // Self-check: git really did produce each situation, so the assertions below are not vacuous.
    expect(notARepository.exitCode).not.toBe(0)
    expect(notAWorkingTree.exitCode).not.toBe(0)
    expect(isNotAGitRepositoryStderr(notARepository.stderr)).toBe(true)
    expect(isNotAWorkingTreeStderr(notAWorkingTree.stderr)).toBe(true)

    // Each predicate answers only its own question — the sentences are not interchangeable.
    expect(isNotAWorkingTreeStderr(notARepository.stderr)).toBe(false)
    expect(isNotAGitRepositoryStderr(notAWorkingTree.stderr)).toBe(false)

    // The anchoring, stated as behaviour: git's real sentence buried in a wider stderr is a real error
    // that happens to mention the phrase, and must not be classified as the benign case. Both a leading
    // and a trailing neighbour, because `^` and `$` are separate mutations.
    for (const [predicate, real] of [
      [isNotAGitRepositoryStderr, notARepository.stderr],
      [isNotAWorkingTreeStderr, notAWorkingTree.stderr]
    ] as const) {
      expect(predicate(`error: could not lock config file .git/config\n${real}`)).toBe(false)
      expect(predicate(`${real}fatal: the remote end hung up unexpectedly\n`)).toBe(false)
    }
  })
})
