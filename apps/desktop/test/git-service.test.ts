import { afterEach, describe, expect, it, vi } from 'vitest'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
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
      // The two `rev-parse` questions are answered separately on purpose. Collapsing them (one canned
      // answer for anything containing `rev-parse`) would hand the toplevel string back as the
      // repo-relative prefix and the fixture would silently disagree with real git.
      if (args.includes('--show-prefix')) return gitResult(args, '\n')
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
      repoRelativePrefix: '',
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

  /**
   * "Not in HEAD" versus "could not be read from HEAD" — the two must never collapse.
   *
   * `git show HEAD:<path>` exits non-zero for both, and the benign one (the path is not in HEAD) is
   * how an ADDED file is drawn: no old side. So the predicate deciding between them owns whether a
   * committed file's entire HEAD side appears in the diff. It had no test at all before this block.
   *
   * The trap is that the fatal alone does not separate the two cases. Measured against real git (see
   * the sibling real-git case below), an unreadable loose object prints `error:` lines AND THEN the
   * same `exists on disk, but not in 'HEAD'` fatal. A predicate that only tests the fatal reads that
   * as absence and reports the file as newly added — silently dropping the HEAD side of a file that is
   * very much committed, with no error anywhere. Hence the two directions below: the benign fatals must
   * be read as absence, and a fatal arriving with other diagnostics must NOT be.
   */
  describe('the HEAD side of a diff: absent and unreadable must not collapse', () => {
    /** A host whose `git show HEAD:<path>` fails with the given stderr; the worktree side is a plain file. */
    function diffHost(stderr: string): { service: GitService; config: AppConfig } {
      const host = gitHost()
      vi.mocked(host.run).mockImplementation(async (_command, args) => {
        if (args.includes('rev-parse')) return gitResult(args, '/srv/repo\n')
        if (args.includes('show')) return gitResult(args, '', stderr, 128)
        return gitResult(args)
      })
      const service = new GitService(
        () => host,
        async () => ({ present: true, oversized: false, bytes: Buffer.from('new contents\n') })
      )
      return {
        service,
        config: {
          ...config,
          workspaces: [{ id: 'repo', name: 'repo', hostId: 'remote', path: '/srv/repo', kind: 'folder' }]
        }
      }
    }

    // Both spellings git uses for "the path is not in this commit". `does not exist in` is a path that
    // was never committed; `exists on disk, but not in` is an untracked file sitting in the worktree.
    // The last two are the case that a fenced `'[^']*'` path span got WRONG: git does not escape a
    // single quote inside the path it echoes back — captured byte-for-byte from real git for a file
    // named `bob's.txt` — so a fenced span stopped at the embedded quote, absence was not recognized,
    // and a legitimately-added file made the whole diff throw instead of being drawn as added.
    it.each([
      "fatal: path 'nosuch.txt' does not exist in 'HEAD'\n",
      "fatal: path 'ondisk.txt' exists on disk, but not in 'HEAD'\n",
      "fatal: path 'bob's.txt' exists on disk, but not in 'HEAD'\n",
      "fatal: path 'no'such.txt' does not exist in 'HEAD'\n"
    ])('draws a file that is genuinely not in HEAD as added: %s', async (stderr) => {
      const { service, config: cfg } = diffHost(stderr)

      const diff = await service.diff('repo', 'ondisk.txt', cfg)

      // The observable is the whole diff shape, not the predicate's boolean: absent old side → added.
      expect(diff.old).toEqual({ present: false })
      expect(diff.change).toBe('added')
    })

    // The defect this block exists for, using git's real transcript (reproduced from the real-git case
    // below — that case is what keeps this fixture honest). The fatal is byte-identical to the accepted
    // one above; the `error:` lines are the only thing separating "not in HEAD" from "could not read
    // HEAD". The oid is a TREE: it is the tree walk that fails this way, not the blob read.
    it('refuses to read an unreadable tree as absence — it surfaces the real failure', async () => {
      const { service, config: cfg } = diffHost(
        'error: unable to open loose object 66321a3e387d80427fbe0a36266bfdf8f2b12156: Permission denied\n' +
          'error: unable to open loose object 66321a3e387d80427fbe0a36266bfdf8f2b12156: Permission denied\n' +
          "fatal: path 'tracked.txt' exists on disk, but not in 'HEAD'\n"
      )

      // Loud, and carrying git's own words — a committed file must never be reported as newly added
      // just because its blob could not be opened.
      await expect(service.diff('repo', 'tracked.txt', cfg)).rejects.toThrow(/unable to open loose object/)
    })

    // A longer line that merely CONTAINS the absence phrase must not be read as absence. What rejects
    // it is the REF literal plus `$`: the message has to end in `'HEAD'`, so `'HEAD:sub' at '…'` fails
    // on the ref. That is deliberately not a fence around the path span — fencing the path was measured
    // to break quoted filenames (see the added cases above) while buying nothing this case needs.
    //
    // The line has to end in a quote to probe this at all. My first attempt used a trailing
    // `(which is not a tree object)` suffix and did not discriminate: `$` rejected it under every
    // spelling, so the wildcard change it was meant to catch left the suite green (measured).
    it('does not accept a longer line that merely contains the absence phrase', async () => {
      const { service, config: cfg } = diffHost(
        "fatal: path 'a.txt' exists on disk, but not in 'HEAD:sub' at 'refs/heads/x'\n"
      )

      await expect(service.diff('repo', 'a.txt', cfg)).rejects.toThrow(/refs\/heads\/x/)
    })

    // The ref literal, probed on its own. `readHeadBlob` only ever asks for `HEAD:<path>`, so a fatal
    // naming a DIFFERENT ref did not come from the read we made and cannot be evidence about HEAD.
    // Without this the ref could be widened back to a wildcard and only the case above would notice —
    // and that case is also satisfied by `$`, so the ref literal would have no witness of its own.
    it('does not accept an absence fatal about some other ref', async () => {
      const { service, config: cfg } = diffHost("fatal: path 'a.txt' does not exist in 'main'\n")

      await expect(service.diff('repo', 'a.txt', cfg)).rejects.toThrow(/does not exist in 'main'/)
    })
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

  // The accepted side of NOT_A_WORKING_TREE, and specifically a path containing a single quote.
  //
  // Why this needs its own case: git echoes the caller's path back INSIDE single quotes, so the
  // pattern's wildcard sits fenced between two quote literals. A wildcard in that position gets no
  // incidental coverage — narrowing `.+` to `[^']+` left the whole suite green, even though a single
  // quote is legal in directory names and such a user would permanently hit the original defect
  // (their removal of an already-gone worktree reads as an unclassified failure). The sibling
  // predicate's wildcard is at the tail, where greedy matching eats the trailing neighbour noise the
  // test above feeds it and trips `$` — so "the anchor mutations are caught" proves nothing here.
  //
  // Real git again, not a literal: the quoting and the exact wording are git's to decide.
  it('classifies an already-gone worktree whose path contains a quote — the fenced wildcard', async () => {
    const root = await makeRepo()
    const host = new LocalExecutionHost()
    const quoted = join(root, "bob's-laptop", 'wt')

    const removal = await host.run('git', ['-C', root, 'worktree', 'remove', '--', quoted],
      { timeoutMs: 20_000 })

    // Self-check: the quote really did survive into git's message, so this case exercises the
    // wildcard rather than passing on a path git happened to rewrite.
    expect(removal.exitCode).not.toBe(0)
    expect(removal.stderr, "git did not echo the quote back — this case no longer probes the wildcard")
      .toContain("bob's-laptop")
    expect(isNotAWorkingTreeStderr(removal.stderr)).toBe(true)
  })

  /**
   * The premise behind the fake-host corruption case above, taken from git itself.
   *
   * The claim being pinned is narrow and entirely git's behaviour, not ours: when `git show HEAD:<path>`
   * cannot READ the tree it must walk, it prints its own `error:` diagnostics and then the SAME
   * `exists on disk, but not in 'HEAD'` fatal it prints for an untracked file. That collision is the
   * whole reason `isPathAbsentInHead` requires stderr to hold nothing but the fatal.
   *
   * It is specifically the TREE (or the commit) that must be unreadable — measured: an unreadable BLOB
   * says `fatal: bad object HEAD:<path>` instead, which never looked like absence. My first version of
   * this test made the blob unreadable and failed here, which is the reason it exists: the collision
   * lives on the path-resolution step, not the content-read step. That distinction is invisible from
   * the fake-host case alone, and an unreadable tree is the worse of the two — git cannot tell whether
   * the path is in the commit at all, so "not in HEAD" is the answer it reaches for.
   *
   * Deliberately does NOT assert our predicate: the point is what git emits. The consequence of
   * misreading it is asserted above, where the diff shape is observable.
   */
  it('git prints the absence fatal when it merely could not read the tree', async () => {
    const root = await makeRepo()
    const host = new LocalExecutionHost()
    const run = async (args: string[]) => await host.run('git', ['-C', root, ...args], { timeoutMs: 20_000 })

    await writeFile(join(root, 'tracked.txt'), 'committed contents\n')
    await run(['add', 'tracked.txt'])
    await run(['commit', '-q', '-m', 'add tracked'])

    // Make the tree unreadable rather than deleting it: a missing object gives a different message,
    // and "present but unopenable" is the case that collides with the absence fatal.
    const hashed = await run(['rev-parse', 'HEAD^{tree}'])
    const oid = hashed.stdout.trim()
    const loose = join(root, '.git', 'objects', oid.slice(0, 2), oid.slice(2))
    await chmod(loose, 0o000)

    const shown = await run(['show', '--end-of-options', 'HEAD:tracked.txt'])

    try {
      // Skip rather than fail where the chmod cannot bite (a root-run CI, or a filesystem that ignores
      // mode bits): an environment that cannot make an object unreadable has nothing to say here. A
      // silent pass would be worse — it would look like the collision was verified.
      if (shown.exitCode === 0) {
        expect(shown.stdout, 'chmod 000 did not make the object unreadable in this environment').toBe(
          'committed contents\n'
        )
        return
      }
      // The collision, stated as two facts about the same stderr: git's own read error is present, AND
      // the fatal is the byte-identical one an untracked file produces.
      expect(shown.stderr).toMatch(/error: unable to open loose object/)
      expect(shown.stderr).toContain("fatal: path 'tracked.txt' exists on disk, but not in 'HEAD'")
    } finally {
      // Restore before the afterEach cleanup, which cannot remove an unreadable object.
      await chmod(loose, 0o444)
    }
  })

  /**
   * 行为层：workspace 是 repo 子目录时，`status()` 必须给出那段真实的相对前缀。
   *
   * 为什么必须用真 git：这个前缀曾经在渲染层用 `repoPath` 与 `workspace.path` 两个字符串做词法比较
   * 推出来（`workspace.startsWith(repo + '/')` 就切，否则 `''`）。而这两个字符串来自不同的世界——git
   * 会把祖先里的 symlink 与磁盘大小写规范化，配置里那条路径不会。macOS 上这一点在本用例里免费成立：
   * `os.tmpdir()` 给的是 `/var/folders/...`，git 的 `--show-toplevel` 给的是 `/private/var/folders/...`，
   * 于是那次比较必然落空、返回 `''`。而 `''` 不是安全的兜底：投影侧的过滤写成
   * `if (prefix && !change.path.startsWith(prefix)) continue`，空前缀让它既不过滤也不切，于是 repo-相对
   * 的路径被原样当成 workspace-相对的键——一个**干净**的文件就此挂上别人的 git 标记。
   *
   * 断言分成三步且都要在场：
   * 1. 自检——那次已失效的词法比较在这个环境里**真的**落空（否则本用例证不到任何东西）；
   * 2. 前缀正是那段子目录名（不是 `''`，也不是被整条 toplevel 顶替）；
   * 3. porcelain 路径确实带着这个前缀——即前缀与要被它剥掉的那些路径同属一套坐标系。
   */
  it('gives the real repo-relative prefix for a workspace inside its repository, where the old string surgery returned nothing', async () => {
    const root = await makeRepo()
    const subdirectory = 'nested-workspace'
    await mkdir(join(root, subdirectory))
    await writeFile(join(root, subdirectory, 'inside.txt'), 'hello\n')

    const service = new GitService(() => new LocalExecutionHost())
    const workspacePath = join(root, subdirectory)
    const cfg: AppConfig = {
      ...config,
      workspaces: [{ id: 'repo', name: 'repo', hostId: 'local', path: workspacePath, kind: 'folder' }]
    }

    const result = await service.status('repo', cfg)
    if (result.kind !== 'git-repository') throw new Error('expected a git repository')

    // 1. 自检：git 报的 toplevel 与配置里的路径在这个环境里确实分岔，所以那次词法比较落空、旧实现
    //    在这里返回的是 `''`。若某个环境不分岔（比如 tmpdir 已经是规范路径），这条会响亮地说清楚，
    //    而不是让本用例悄悄退化成「顺便也过了」。
    expect(
      workspacePath.startsWith(`${result.repoPath}/`),
      '这个环境里配置路径与 git 的 toplevel 没有分岔——本用例不再能观测到那次落空的比较'
    ).toBe(false)

    // 2. 前缀是那段子目录，既不是空串（旧实现的答案）也不是整条 toplevel。
    expect(result.repoRelativePrefix).toBe(subdirectory)

    // 3. 同一套坐标系：porcelain 给的路径带着这个前缀，所以剥掉它才是 workspace-相对的键。
    const untracked = result.changes.find((change) => change.path.endsWith('inside.txt'))
    expect(untracked?.path).toBe(`${subdirectory}/inside.txt`)
  })
})
