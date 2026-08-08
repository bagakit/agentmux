import { afterEach, describe, expect, it, vi } from 'vitest'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalExecutionHost, type ExecutionHost } from '@agentmux/core'
import type { AppConfig } from '../src/shared/contracts.js'
import { GitService, isNotAGitRepositoryStderr, isNotAWorkingTreeStderr } from '../src/main/git-service.js'

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

  /**
   * 行为层（#761）：`diff()` 的路径是 **workspace-相对**的，且这件事只在 workspace 是子目录时可观测。
   *
   * 缺陷的原样：`diff()` 把这个形参当成 repo-根-相对来解析（`-C repoPath` + `HEAD:<path>`），而它唯一
   * 的两个调用方（EditorPane 的重载、store 的 loadRegionDiff）喂进来的是编辑器坐标——`surface.path`，
   * 也就是文档键与页签身份用的那一个。repo 根 == workspace 时两者逐字相同，所以这个错配在自家仓库里
   * 完全不显形。子目录 workspace 下它有**两种**形态，都不报错：
   *
   *   A. repo 根下恰好有同名文件 → 用户看的是 `app/src/a.ts`，diff 画的是仓库根的 `src/a.ts`。
   *      静默展示另一个文件的内容，是本条最坏的形态。
   *   B. repo 根下没有同名文件 → git 报 `does not exist in 'HEAD'`，而那个 fatal 正是「新加的文件」
   *      的判据，于是 HEAD 那半边整段消失，一个有历史的文件被画成 added。
   *
   * 判据必须落在**内容**上，不能只判 `change`：A 的 `change` 也是 `modified`，两个世界在那个字段上
   * 逐字相同（记忆 presence-assertion-blind-when-shape-repeats）。所以 A 断言 `old.text` 是子目录里
   * 那份的历史内容、且**不是**诱饵那份；B 断言 old 边在场。
   *
   * 用真 git 而不是 fake host：这条走的是 `HEAD:./<path>` 的解析语义——`./` 让 git 自己按 `-C` 的
   * prefix 解析，是本修法「只有一次解析，而且是 git 的」的全部依据。fake host 只会把 argv 回放给我，
   * 证不到解析结果；真 git 才能证明这个 rev 语法确实拿到了子目录那份。
   */
  it('diff() reads the file inside the workspace subdirectory, not the same-named decoy at the repo root', async () => {
    const root = await makeRepo()
    const subdirectory = 'app'
    const relative = 'src/a.ts'
    const host = new LocalExecutionHost()
    const run = async (args: string[]) => {
      const result = await host.run('git', ['-C', root, ...args], { timeoutMs: 20_000 })
      if (result.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`)
      return result
    }

    // 诱饵在 repo 根的同一相对路径上，内容与子目录那份不同。这是形态 A 的靶子：缺陷把
    // `HEAD:src/a.ts` 解析到这一份。
    await mkdir(join(root, 'src'), { recursive: true })
    await writeFile(join(root, 'src', 'a.ts'), 'DECOY: repo-root src/a.ts\n')
    await mkdir(join(root, subdirectory, 'src'), { recursive: true })
    await writeFile(join(root, subdirectory, relative), 'committed content\n')
    await run(['add', '--', 'src/a.ts', `${subdirectory}/${relative}`])
    await run(['commit', '-q', '-m', 'add both'])
    // 只改子目录那份，让它的 HEAD 侧与工作区侧不同——否则 change 会是 unchanged，A/B 都观测不到。
    await writeFile(join(root, subdirectory, relative), 'worktree content\n')

    const service = new GitService(() => new LocalExecutionHost())
    const cfg: AppConfig = {
      ...config,
      workspaces: [
        { id: 'repo', name: 'repo', hostId: 'local', path: join(root, subdirectory), kind: 'folder' }
      ]
    }

    const diff = await service.diff('repo', relative, cfg)

    // 自检：诱饵真的在 HEAD 里，且内容与子目录那份不同——否则形态 A 无从区分，本用例会退化成
    // 「顺便也过了」（记忆 property-unobservable-in-default-env）。
    const decoy = await run(['show', '--end-of-options', 'HEAD:src/a.ts'])
    expect(decoy.stdout, '诱饵不在 HEAD 里或内容相同——本用例不再能区分两套坐标系').toBe(
      'DECOY: repo-root src/a.ts\n'
    )

    // 形态 B：HEAD 那半边必须在场。缺陷下 git 报的是 `does not exist in 'HEAD'`（当根下无同名文件），
    // 而那个 fatal 就是「新加的文件」的判据，于是整边静默消失。
    expect(diff.old.present, 'HEAD 侧整段消失——有历史的文件被画成新加的').toBe(true)
    // 形态 A：HEAD 侧内容必须是子目录那份的历史，而不是诱饵。`change` 在两个世界里都是 modified，所以
    // 判据只能落在内容上。
    expect(diff.old).toEqual({ present: true, binary: false, text: 'committed content\n' })
    // 工作区那半边同样钉住：它走的是 `assertInWorktree` 返回的绝对路径，所以这一条也是「围栏锚在
    // workspace 而不是 repo 根」的唯一判据——实测把锚点改成 repo 根时，红的就是这一行（诱饵内容）。
    // 拒绝行为区分不出锚点（`../x` 对两个锚点都越界），落点才行。
    expect(diff.new).toEqual({ present: true, binary: false, text: 'worktree content\n' })
    expect(diff.change).toBe('modified')
    // 回声的那个 path 也是 workspace-相对的：它是文档键与页签身份用的同一串，repo-相对会让 store
    // 对同一个打开的文件持有两串不同的字符串。
    expect(diff.path).toBe(relative)
  })

  /**
   * 同一坐标系合同的另一半：diff 的**两个半边必须从同一个目录解析**。
   *
   * 这一条的前提被实测改写过一次，值得写下来：我原来写的是「把围栏锚在 repo 根会放行 `../src/a.ts`」——
   * 假的。`../src/a.ts` 从 workspace 出发越界，从 repo 根出发也一样越界（`resolve('/r','../src/a.ts')`
   * = `/src/a.ts`），两个锚点都抛。所以**拒绝行为区分不出锚点**，锚点决定的是「放行的那条路落在哪」：
   * `resolve(repoRoot, 'src/a.ts')` 是仓库根那份，而 HEAD 侧由 git 从 workspace 解析出的是子目录那份，
   * 于是一次 diff 横跨两个文件，界面上看起来只是一处普通改动。上面那条子目录用例正是靠 `diff.new` 钉住
   * 这个错配（实测：把围栏改锚 repo 根，它的 `diff.new` 变成诱饵内容）。
   *
   * 这里剩下要单独钉的，是围栏本身还在：越界路径必须在任何 git / fs 动作之前就被拒。缺了它，`../` 会
   * 一路走到 `readFile`，把 workspace 之外的文件读进编辑器。
   */
  it('diff() rejects a path that escapes the workspace before it reads anything', async () => {
    const root = await makeRepo()
    const subdirectory = 'app'
    await mkdir(join(root, subdirectory), { recursive: true })
    await mkdir(join(root, 'src'), { recursive: true })
    await writeFile(join(root, 'src', 'a.ts'), 'sibling of the workspace\n')

    const service = new GitService(() => new LocalExecutionHost())
    const cfg: AppConfig = {
      ...config,
      workspaces: [
        { id: 'repo', name: 'repo', hostId: 'local', path: join(root, subdirectory), kind: 'folder' }
      ]
    }

    await expect(service.diff('repo', '../src/a.ts', cfg)).rejects.toThrow(/outside the worktree/)

    // 自检：那个文件**真的存在**且可读，所以拒绝来自围栏，而不是顺便被「文件不存在」挡住了——否则这条
    // 用例在围栏被删掉后依然会红，对被测性质失明（记忆 property-unobservable-in-default-env）。
    const sibling = await readFile(join(root, 'src', 'a.ts'), 'utf8')
    expect(sibling, '兄弟文件不可读——本用例的拒绝可能来自缺文件而不是围栏').toBe(
      'sibling of the workspace\n'
    )
  })

  /**
   * Behaviour (#765, first half): a brand-new project — `git init`, no commit yet — must diff its files,
   * not surface git's raw fatal.
   *
   * The mechanism, traced to the byte: `diff()` reads the old side with `git show HEAD:./<path>`. In a
   * commit-less repository HEAD is *unborn* (it names a branch ref that does not exist), so git exits 128
   * with `fatal: invalid object name 'HEAD'.` — a DIFFERENT sentence from the two `path … 'HEAD'` fatals
   * the sibling block covers, so `isPathAbsentInHead` returns false and, before the fix, `assertGit`
   * threw the raw fatal into the diff pane. A user could not see a diff of any file in a fresh project.
   *
   * The honest answer is not a new error class: an unborn HEAD means nothing is committed, so every file
   * on disk is genuinely new — the exact added-file shape (`old` absent). That is a normal state, not a
   * failure. This is why the fix is `isHeadUnborn` feeding the same `present: false` branch as the path
   * fatals, and why the observable here is the whole diff shape, not a predicate boolean.
   *
   * Real git, and specifically a repository with NO commit: the existing suite's `makeRepo` commits
   * `--allow-empty`, which BORNS HEAD and hides this entirely (measured — that repo has a valid HEAD and
   * `git show HEAD:<path>` gives the path fatal, not the object-name fatal). No test anywhere used a
   * commit-less repo before this, so the fixture shape itself is the thing that was missing.
   */
  it('draws a file in a commit-less repository as added, instead of leaking git\'s unborn-HEAD fatal', async () => {
    // A repository with an unborn HEAD: init and identity, deliberately NO commit. Not makeRepo(), which
    // commits --allow-empty and would give HEAD a value, changing which fatal git prints.
    const root = await mkdtemp(join(tmpdir(), 'agentmux-git-unborn-'))
    temporaryRoots.push(root)
    const host = new LocalExecutionHost()
    const run = async (args: string[]) => {
      const result = await host.run('git', ['-C', root, ...args], { timeoutMs: 20_000 })
      if (result.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`)
      return result
    }
    await run(['init', '-q'])
    await run(['config', 'user.email', 't@example.com'])
    await run(['config', 'user.name', 'Test'])
    await writeFile(join(root, 'brand-new.txt'), 'first ever line\n')

    // Self-check: HEAD really is unborn here, and git really prints the object-name fatal (not a path
    // fatal) — otherwise this case proves nothing about `isHeadUnborn`. If a future git changes either,
    // this speaks up rather than passing vacuously (记忆 property-unobservable-in-default-env).
    const verify = await host.run('git', ['-C', root, 'rev-parse', '--verify', '--quiet', 'HEAD'],
      { timeoutMs: 20_000 })
    expect(verify.exitCode, 'HEAD is not unborn — this repo has a commit, so it cannot probe the fatal').toBe(1)
    const shown = await host.run('git', ['-C', root, 'show', '--end-of-options', 'HEAD:./brand-new.txt'],
      { timeoutMs: 20_000 })
    expect(shown.exitCode).toBe(128)
    expect(shown.stderr.trim(), 'git no longer prints the unborn-HEAD fatal this test pins')
      .toBe("fatal: invalid object name 'HEAD'.")

    const service = new GitService(() => new LocalExecutionHost())
    const cfg: AppConfig = {
      ...config,
      workspaces: [{ id: 'repo', name: 'repo', hostId: 'local', path: root, kind: 'folder' }]
    }

    const diff = await service.diff('repo', 'brand-new.txt', cfg)

    // The whole diff shape, not the predicate: an unborn HEAD has no old side, so the file is ADDED, and
    // its new side is the worktree content — never a raw fatal reaching the pane.
    expect(diff.old).toEqual({ present: false })
    expect(diff.change).toBe('added')
    expect(diff.new).toEqual({ present: true, binary: false, text: 'first ever line\n' })
  })

  /**
   * Safety (#765, first half): `isHeadUnborn` must NOT swallow a HEAD that resolves to a missing or
   * unreadable commit. Only a genuinely unborn HEAD prints `invalid object name 'HEAD'` standing alone;
   * a HEAD whose commit object is gone or unopenable prints the PATH fatal instead — and if that ever
   * arrives paired with `error:` diagnostics, the extra text means git is telling us something more.
   *
   * This pins the sole-line half of the predicate the same way the sibling `isPathAbsentInHead` block
   * does: git's unborn fatal, with any other diagnostic line beside it, is a real failure that must
   * surface — not "added". Measured discriminator: for a corrupt-but-resolvable HEAD `rev-parse --verify
   * --quiet HEAD` exits 0, for an unborn HEAD it exits 1, so the two are genuinely different states and
   * this is not a hypothetical.
   */
  it('refuses to read the unborn-HEAD fatal as absence when other diagnostics accompany it', async () => {
    const host = gitHost()
    vi.mocked(host.run).mockImplementation(async (_command, args) => {
      if (args.includes('--show-prefix')) return gitResult(args, '\n')
      if (args.includes('rev-parse')) return gitResult(args, '/srv/repo\n')
      if (args.includes('show')) {
        return gitResult(
          args,
          '',
          'error: refs/heads/main does not point to a valid object!\n' +
            "fatal: invalid object name 'HEAD'.\n",
          128
        )
      }
      return gitResult(args)
    })
    const service = new GitService(
      () => host,
      async () => ({ present: true, oversized: false, bytes: Buffer.from('x\n') })
    )
    const cfg: AppConfig = {
      ...config,
      workspaces: [{ id: 'repo', name: 'repo', hostId: 'remote', path: '/srv/repo', kind: 'folder' }]
    }

    // Loud, carrying git's own words — never flattened into a newly-added file just because the fatal
    // phrase appears somewhere in the stderr.
    await expect(service.diff('repo', 'brand-new.txt', cfg)).rejects.toThrow(/does not point to a valid object/)
  })

  /**
   * Safety (#765, first half): the ref in the unborn fatal must be the literal `HEAD`, not a wildcard.
   *
   * `readHeadBlob` only ever asks git for `HEAD:<path>`, so an `invalid object name '<rev>'` fatal that
   * names any OTHER rev did not come from the read we made and is not evidence that HEAD is unborn. This
   * is the ref-literal's own witness: without it, widening the pattern's ref span to a wildcard (`.+`)
   * leaves the whole suite green — measured, the mutation survives — because the added/corruption cases
   * above all use `'HEAD'` and none feeds a different rev. `@` is git's shorthand for HEAD and prints
   * `invalid object name '@'.` when unborn, the closest near-miss there is.
   *
   * Fake host, because the point is a string git could emit reaching our predicate, not git's own choice
   * of rev (git would never print a foreign rev for our `HEAD:` read — that is exactly why a wildcard is
   * unsafe and a literal is correct).
   */
  it('does not read an invalid-object-name fatal about some other rev as an unborn HEAD', async () => {
    const host = gitHost()
    vi.mocked(host.run).mockImplementation(async (_command, args) => {
      if (args.includes('--show-prefix')) return gitResult(args, '\n')
      if (args.includes('rev-parse')) return gitResult(args, '/srv/repo\n')
      if (args.includes('show')) return gitResult(args, '', "fatal: invalid object name '@'.\n", 128)
      return gitResult(args)
    })
    const service = new GitService(
      () => host,
      async () => ({ present: true, oversized: false, bytes: Buffer.from('x\n') })
    )
    const cfg: AppConfig = {
      ...config,
      workspaces: [{ id: 'repo', name: 'repo', hostId: 'remote', path: '/srv/repo', kind: 'folder' }]
    }

    // A fatal about `@` is not about `HEAD`: it must surface as the real failure, never become an added
    // file. If the ref span were a wildcard this would be swallowed and `diff.old` would be absent.
    await expect(service.diff('repo', 'brand-new.txt', cfg)).rejects.toThrow(/invalid object name '@'/)
  })

  /**
   * Behaviour (#765, second half): AgentMux must never inherit an exported repo-LOCATION variable.
   *
   * The leak, measured against real git 2.50.1: `git -C <dir>` positions git's working directory but
   * does NOT override an exported `GIT_DIR` / `GIT_WORK_TREE` / `GIT_INDEX_FILE` / `GIT_OBJECT_DIRECTORY`
   * / `GIT_COMMON_DIR`. `runProcess` builds the child env as `{ ...process.env, ...options.env }`, so a
   * user who exports any of these in their shell (a common dotfile shape; anyone who has scripted a bare
   * repo) had every AgentMux git operation silently pointed at another repository. The fix is the five
   * `undefined` entries in `GIT_NONINTERACTIVE_ENV`, which `runProcess` deletes from the child env.
   *
   * Why this is behavioural and not a source grep: the coordinator's own warning — a text guard stays
   * green when the key is present in the source but the runner never receives it, and `'GIT_DIR' in
   * { GIT_DIR: undefined }` is `true`, so an `in`/`toContain` check cannot tell "unset" from "declared".
   * This runs the real GitService → LocalExecutionHost → runProcess path with the variable exported in
   * `process.env`, and asserts the child git did NOT see it. One case per variable, so DELETING any
   * single `GIT_X: undefined` from the constant reddens exactly that row — the guard is per-key.
   *
   * Each row also proves the variable actually BITES (self-check), so no row can pass vacuously: a raw
   * run that does not unset it must diverge from the clean run — either git reads the decoy (silent:
   * GIT_DIR flips the branch, GIT_WORK_TREE flips the files) or it fails loud (GIT_INDEX_FILE /
   * GIT_OBJECT_DIRECTORY / GIT_COMMON_DIR → `bad object` / `unable to read`). If a variable ever stops
   * biting, the self-check fails rather than letting the row certify nothing.
   */
  describe('an exported repo-location git variable is not inherited (#765)', () => {
    async function committedRepo(branch: string, committedFile: string, message: string): Promise<string> {
      const root = await mkdtemp(join(tmpdir(), 'agentmux-git-envleak-'))
      temporaryRoots.push(root)
      const host = new LocalExecutionHost()
      const run = async (args: string[]) => {
        const result = await host.run('git', ['-C', root, ...args], { timeoutMs: 20_000 })
        if (result.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`)
        return result
      }
      await run(['init', '-q', '-b', branch])
      await run(['config', 'user.email', 't@example.com'])
      await run(['config', 'user.name', 'Test'])
      await writeFile(join(root, committedFile), `${message}\n`)
      await run(['add', '--', committedFile])
      await run(['commit', '-q', '-m', message])
      return root
    }

    // Each variable, paired with the decoy location a real shell would export it to. The five that `-C`
    // does not override; the three that were measured to have no effect on our verbs
    // (GIT_NAMESPACE / GIT_CEILING_DIRECTORIES / GIT_ALTERNATE_OBJECT_DIRECTORIES) are deliberately not
    // unset and therefore not tested — unsetting a variable git ignores would be a vacuous guard arm.
    it.each(['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_COMMON_DIR'])(
      'ignores an exported %s and reads the workspace git says it should',
      async (variable) => {
        const target = await committedRepo('target-branch', 'keep.txt', 'base')
        // A file present in the target worktree but not committed: the ONE change a clean status must
        // report. Any decoy leaking in adds or removes entries, so this list is the discriminator.
        await writeFile(join(target, 'only-in-target.txt'), 'uncommitted\n')
        const decoy = await committedRepo('decoy-branch', 'decoy.txt', 'decoy')
        const decoyGitDir = join(decoy, '.git')
        const location: Record<string, string> = {
          GIT_DIR: decoyGitDir,
          GIT_WORK_TREE: decoy,
          GIT_INDEX_FILE: join(decoyGitDir, 'index'),
          GIT_OBJECT_DIRECTORY: join(decoyGitDir, 'objects'),
          GIT_COMMON_DIR: decoyGitDir
        }
        const value = location[variable]!

        const service = new GitService(() => new LocalExecutionHost())
        const cfg: AppConfig = {
          ...config,
          workspaces: [{ id: 'repo', name: 'repo', hostId: 'local', path: target, kind: 'folder' }]
        }

        const hadOwn = Object.prototype.hasOwnProperty.call(process.env, variable)
        const previous = process.env[variable]
        process.env[variable] = value
        try {
          // Self-check: with the variable delivered to git (a run that does NOT unset it), the outcome
          // diverges from clean — silently (wrong branch/changes) or loudly (nonzero exit). If it does
          // not diverge, the variable is inert here and this row would certify nothing.
          const leaked = await new LocalExecutionHost().run(
            'git',
            ['-C', target, 'status', '--porcelain=v1', '-z', '--branch', '--untracked-files=all'],
            { timeoutMs: 20_000 }
          )
          const leakedClean =
            leaked.exitCode === 0 &&
            leaked.stdout.split('\0').filter((t) => t !== '')[0] === '## target-branch' &&
            leaked.stdout.split('\0').filter((t) => t !== '' && !t.startsWith('## ')).length === 1
          expect(leakedClean, `${variable} did not bite — the isolation this row checks is unobservable`).toBe(false)

          // Through the real service, which spreads GIT_NONINTERACTIVE_ENV and therefore unsets the
          // variable: the child git reads the TARGET. Both facts are load-bearing — GIT_DIR flips only
          // the branch, GIT_WORK_TREE flips only the change list.
          const result = await service.status('repo', cfg)
          if (result.kind !== 'git-repository') throw new Error('expected a git repository')
          expect(result.branch).toBe('target-branch')
          expect(result.changes.map((change) => change.path)).toEqual(['only-in-target.txt'])
        } finally {
          if (hadOwn) process.env[variable] = previous
          else delete process.env[variable]
        }
      }
    )
  })
})
