import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalExecutionHost, type ExecutionHost } from '@agentmux/core'
import type { AppConfig } from '../src/shared/contracts.js'
import { GitService, buildFileDiff, assertInWorktree } from '../src/main/git-service.js'

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

type ShowHandler = (args: readonly string[]) => ReturnType<typeof gitResult> | Promise<never>

/**
 * A fake host that resolves the repo root and answers the git verbs T-002 needs. `show` is the HEAD
 * blob read; `restore`/`clean` are the discard/unstage verbs. A handler may throw to simulate an
 * ExecutionHost that rejects (output-limit, transport failure) rather than returning a nonzero exit.
 */
function gitHost(handlers: {
  show?: ShowHandler
  restore?: (args: readonly string[]) => ReturnType<typeof gitResult>
  clean?: (args: readonly string[]) => ReturnType<typeof gitResult>
} = {}): ExecutionHost {
  return {
    id: 'remote',
    kind: 'ssh',
    label: 'Remote',
    exposeLoopbackPort: vi.fn(async (port: number) => port),
    dispose: vi.fn(async () => {}),
    run: vi.fn(async (_command: string, args: readonly string[]) => {
      if (args.includes('rev-parse')) return gitResult(args, '/srv/repo\n')
      if (args.includes('show')) return await (handlers.show?.(args) ?? gitResult(args, ''))
      if (args.includes('restore')) return handlers.restore?.(args) ?? gitResult(args)
      if (args.includes('clean')) return handlers.clean?.(args) ?? gitResult(args)
      return gitResult(args)
    })
  }
}

/** A fake worktree reader keyed by repo-relative path; `null` means the file is not on disk. */
function worktreeReader(files: Record<string, Buffer | 'oversized' | null>) {
  return vi.fn(async (absPath: string) => {
    const rel = absPath.startsWith('/srv/repo/') ? absPath.slice('/srv/repo/'.length) : absPath
    const value = files[rel]
    if (value === undefined || value === null) return { present: false as const }
    if (value === 'oversized') return { present: true as const, oversized: true as const }
    return { present: true as const, oversized: false as const, bytes: value }
  })
}

function withWorkspace(
  host: ExecutionHost,
  reader?: Parameters<typeof GitService>[1]
): { service: GitService; config: AppConfig } {
  const service = new GitService(() => host, reader)
  return {
    service,
    config: {
      ...config,
      workspaces: [{ id: 'repo', name: 'repo', hostId: 'remote', path: '/srv/repo', kind: 'folder' }]
    }
  }
}

describe('GitService.diff (structured, fake executor)', () => {
  it('reads the HEAD blob with --end-of-options and pairs it with the worktree file for a modified text file', async () => {
    const host = gitHost({ show: () => gitResult([], 'old line\n') })
    const reader = worktreeReader({ 'a.txt': Buffer.from('new line\n') })
    const { service, config: cfg } = withWorkspace(host, reader)

    const diff = await service.diff('repo', 'a.txt', cfg)

    expect(diff).toEqual({
      path: 'a.txt',
      old: { present: true, binary: false, text: 'old line\n' },
      new: { present: true, binary: false, text: 'new line\n' },
      binary: false,
      change: 'modified'
    })
    expect(host.run).toHaveBeenCalledWith(
      'git',
      ['-C', '/srv/repo', 'show', '--end-of-options', 'HEAD:a.txt'],
      RUN_OPTIONS
    )
    expect(reader).toHaveBeenCalledWith('/srv/repo/a.txt')
  })

  it('renders a new file as added: HEAD blob absent (not swallowed to empty), worktree present', async () => {
    const host = gitHost({
      show: () => gitResult([], '', "fatal: path 'fresh.txt' does not exist in 'HEAD'\n", 128)
    })
    const reader = worktreeReader({ 'fresh.txt': Buffer.from('brand new\n') })
    const { service, config: cfg } = withWorkspace(host, reader)

    const diff = await service.diff('repo', 'fresh.txt', cfg)

    expect(diff.change).toBe('added')
    expect(diff.old).toEqual({ present: false })
    expect(diff.new).toEqual({ present: true, binary: false, text: 'brand new\n' })
  })

  it('renders a deleted file: HEAD blob present, worktree file gone', async () => {
    const host = gitHost({ show: () => gitResult([], 'was here\n') })
    const reader = worktreeReader({ 'gone.txt': null })
    const { service, config: cfg } = withWorkspace(host, reader)

    const diff = await service.diff('repo', 'gone.txt', cfg)

    expect(diff.change).toBe('deleted')
    expect(diff.old).toEqual({ present: true, binary: false, text: 'was here\n' })
    expect(diff.new).toEqual({ present: false })
  })

  it('does NOT fall back to HEAD or swallow an unexpected git failure into an empty diff', async () => {
    // An error whose text is not the benign "does not exist in HEAD" absence marker must surface,
    // never be silently read as "old side absent" — that is the trap this task warns about.
    const host = gitHost({
      show: () => gitResult([], '', 'fatal: unable to read tree (deadbeef): No such file or directory\n', 128)
    })
    const reader = worktreeReader({ 'x.txt': Buffer.from('present\n') })
    const { service, config: cfg } = withWorkspace(host, reader)

    await expect(service.diff('repo', 'x.txt', cfg)).rejects.toThrow(/unable to read tree/)
  })

  it('treats an empty file as present-with-empty-text, distinct from an absent side', async () => {
    const host = gitHost({ show: () => gitResult([], 'seed\n') })
    const reader = worktreeReader({ 'empty.txt': Buffer.from('') })
    const { service, config: cfg } = withWorkspace(host, reader)

    const diff = await service.diff('repo', 'empty.txt', cfg)

    expect(diff.new).toEqual({ present: true, binary: false, text: '' })
    expect(diff.change).toBe('modified')
  })

  it('flags a worktree file containing a NUL byte as binary, never putting bytes in the text field', async () => {
    const host = gitHost({ show: () => gitResult([], 'text before\n') })
    const reader = worktreeReader({ 'image.png': Buffer.from([0x89, 0x50, 0x00, 0x4e, 0x47]) })
    const { service, config: cfg } = withWorkspace(host, reader)

    const diff = await service.diff('repo', 'image.png', cfg)

    expect(diff.binary).toBe(true)
    expect(diff.new).toEqual({ present: true, binary: true })
    expect('text' in diff.new).toBe(false)
  })

  it('flags an oversized HEAD blob as binary rather than throwing an output-limit error', async () => {
    const host = gitHost({
      show: () => {
        const error = Object.assign(new Error('Command output exceeded its byte limit.'), {
          code: 'COMMAND_OUTPUT_LIMIT'
        })
        return Promise.reject(error) as Promise<never>
      }
    })
    const reader = worktreeReader({ 'huge.bin': Buffer.from('small worktree\n') })
    const { service, config: cfg } = withWorkspace(host, reader)

    const diff = await service.diff('repo', 'huge.bin', cfg)

    expect(diff.binary).toBe(true)
    expect(diff.old).toEqual({ present: true, binary: true })
  })

  it('flags a NUL-bearing HEAD blob as binary — the old side needs its own scan, not just the new one', async () => {
    // 与 :160 那条镜像对称：那条把 NUL 放在 worktree/new 侧，于是 old 侧的 NUL 扫描（git-service 的
    // blobTextToDiffSide）一直没有任何用例走到。删掉那一行时整个文件仍会全绿，而用户打开一个**被修改
    // 过的已提交二进制文件**（tracked .png 之类）的 diff 时，old 侧的原始字节会被当 text 交给 Monaco，
    // 渲染成乱码而不是 binary 占位。所以两侧各要一条：这是同一个判断的两个出口。
    const host = gitHost({ show: () => gitResult([], 'PNG header') })
    const reader = worktreeReader({ 'logo.png': Buffer.from('now plain text\n') })
    const { service, config: cfg } = withWorkspace(host, reader)

    const diff = await service.diff('repo', 'logo.png', cfg)

    expect(diff.binary).toBe(true)
    expect(diff.old).toEqual({ present: true, binary: true })
    // 绝不把原始字节塞进 text——那正是「渲染成乱码」的形状。
    expect('text' in diff.old).toBe(false)
    // 而 new 侧此刻是干净文本，必须仍按文本呈现：证明这条断言咬的是 old 侧，不是整体一刀切。
    expect(diff.new).toEqual({ present: true, binary: false, text: 'now plain text\n' })
  })

  it('flags an oversized worktree file as binary — the stat-size ceiling, not the executor output limit', async () => {
    // reader 的 'oversized' 分支（worktreeReader helper 早就支持）此前没有任何用例构造过，所以
    // git-service 里那句 `if (read.oversized) return { present: true, binary: true }` 无人守。它不只是
    // 一个标签：oversized 变体**不带 bytes 字段**，删掉这一行后紧接着的 `read.bytes.includes(0)` 会
    // 在运行时抛，diff 面板整个开不出来。改成 `binary: false, text: '' }` 则更隐蔽——用户看到一个空
    // diff，读作「没有改动」。
    const host = gitHost({ show: () => gitResult([], 'small in HEAD\n') })
    const reader = worktreeReader({ 'big.bin': 'oversized' })
    const { service, config: cfg } = withWorkspace(host, reader)

    const diff = await service.diff('repo', 'big.bin', cfg)

    expect(diff.binary).toBe(true)
    expect(diff.new).toEqual({ present: true, binary: true })
    expect('text' in diff.new).toBe(false)
    // 超大 ≠ 不存在：present 必须为真，否则这个文件会被画成「已删除」。
    expect(diff.new.present).toBe(true)
    expect(diff.change).toBe('modified')
  })

  it('classifies identical content on both sides as unchanged (the mode-only / no-content-change case)', async () => {
    const host = gitHost({ show: () => gitResult([], 'same\n') })
    const reader = worktreeReader({ 'exec.sh': Buffer.from('same\n') })
    const { service, config: cfg } = withWorkspace(host, reader)

    const diff = await service.diff('repo', 'exec.sh', cfg)

    expect(diff.change).toBe('unchanged')
  })

  it('never lets a dash-prefixed path be read as a flag: rev is HEAD:<path>, worktree read is guarded', async () => {
    const host = gitHost({ show: () => gitResult([], 'old\n') })
    const reader = worktreeReader({ '-rf danger.txt': Buffer.from('new\n') })
    const { service, config: cfg } = withWorkspace(host, reader)

    await service.diff('repo', '-rf danger.txt', cfg)

    expect(host.run).toHaveBeenCalledWith(
      'git',
      ['-C', '/srv/repo', 'show', '--end-of-options', 'HEAD:-rf danger.txt'],
      RUN_OPTIONS
    )
    expect(reader).toHaveBeenCalledWith('/srv/repo/-rf danger.txt')
  })

  it('refuses to read a worktree path that escapes the repository root', async () => {
    const host = gitHost({ show: () => gitResult([], 'old\n') })
    const reader = worktreeReader({})
    const { service, config: cfg } = withWorkspace(host, reader)

    await expect(service.diff('repo', '../../etc/passwd', cfg)).rejects.toThrow(/outside the worktree/)
    expect(reader).not.toHaveBeenCalled()
  })
})

describe('GitService.unstage / discard (argv, fake executor)', () => {
  it('unstages through restore --staged with -- and a :(literal) pathspec', async () => {
    const host = gitHost()
    const { service, config: cfg } = withWorkspace(host)

    await service.unstage('repo', '-weird name.txt', cfg)

    expect(host.run).toHaveBeenCalledWith(
      'git',
      ['-C', '/srv/repo', 'restore', '--staged', '--', ':(literal)-weird name.txt'],
      RUN_OPTIONS
    )
  })

  it('discards a tracked file with restore --worktree --source=HEAD', async () => {
    const host = gitHost()
    const { service, config: cfg } = withWorkspace(host)

    await service.discard('repo', 'tracked.txt', false, cfg)

    expect(host.run).toHaveBeenCalledWith(
      'git',
      ['-C', '/srv/repo', 'restore', '--worktree', '--source=HEAD', '--', ':(literal)tracked.txt'],
      RUN_OPTIONS
    )
  })

  it('discards an untracked file with clean --force scoped to that literal path', async () => {
    const host = gitHost({ clean: (args) => gitResult(args, 'Removing junk.txt\n') })
    const { service, config: cfg } = withWorkspace(host)

    await service.discard('repo', 'junk.txt', true, cfg)

    expect(host.run).toHaveBeenCalledWith(
      'git',
      ['-C', '/srv/repo', 'clean', '--force', '--', ':(literal)junk.txt'],
      RUN_OPTIONS
    )
  })

  it('never cleans outside the worktree: a traversal path is rejected before git clean runs', async () => {
    const host = gitHost()
    const { service, config: cfg } = withWorkspace(host)

    await expect(service.discard('repo', '../escape.txt', true, cfg)).rejects.toThrow(/outside the worktree/)
    const cleanCalls = vi.mocked(host.run).mock.calls.filter(([, args]) => args.includes('clean'))
    expect(cleanCalls).toHaveLength(0)
  })
})

describe('buildFileDiff (pure classifier)', () => {
  it('added when only the new side is present', () => {
    const diff = buildFileDiff('a', { present: false }, { present: true, binary: false, text: 'x' })
    expect(diff.change).toBe('added')
    expect(diff.binary).toBe(false)
  })

  it('deleted when only the old side is present', () => {
    const diff = buildFileDiff('a', { present: true, binary: false, text: 'x' }, { present: false })
    expect(diff.change).toBe('deleted')
  })

  it('modified when text differs, unchanged when text is identical', () => {
    expect(buildFileDiff('a', { present: true, binary: false, text: 'x' }, { present: true, binary: false, text: 'y' }).change).toBe('modified')
    expect(buildFileDiff('a', { present: true, binary: false, text: 'x' }, { present: true, binary: false, text: 'x' }).change).toBe('unchanged')
  })

  it('binary on either side sets the binary flag and treats a two-sided binary change as modified', () => {
    const diff = buildFileDiff('a', { present: true, binary: true }, { present: true, binary: true })
    expect(diff.binary).toBe(true)
    expect(diff.change).toBe('modified')
  })
})

describe('assertInWorktree (pure guard)', () => {
  it('returns the absolute path for a path that stays inside the root', () => {
    expect(assertInWorktree('/srv/repo', 'src/a.txt')).toBe('/srv/repo/src/a.txt')
  })

  it('rejects a traversal path, an absolute path, and the root itself', () => {
    expect(() => assertInWorktree('/srv/repo', '../evil')).toThrow(/outside the worktree/)
    expect(() => assertInWorktree('/srv/repo', '/etc/passwd')).toThrow(/outside the worktree/)
    expect(() => assertInWorktree('/srv/repo', '')).toThrow()
  })
})

describe('GitService.diff / discard (real git, temporary repository)', () => {
  async function makeRepo(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'agentmux-gitdiff-'))
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
    await run(['config', 'user.email', 't@example.com'])
    await run(['config', 'user.name', 'Test'])
    await writeFile(join(root, 'kept.txt'), 'v1\n')
    await run(['add', '--', 'kept.txt'])
    await run(['commit', '-q', '-m', 'init'])
    return root
  }

  function service(): GitService {
    return new GitService(() => new LocalExecutionHost())
  }

  function cfgFor(root: string): AppConfig {
    return { ...config, workspaces: [{ id: 'repo', name: 'repo', hostId: 'local', path: root, kind: 'folder' }] }
  }

  it("matches real git's absence phrasing for an added file rather than throwing", async () => {
    const root = await makeRepo()
    await writeFile(join(root, 'added.txt'), 'hello\n')
    const diff = await service().diff('repo', 'added.txt', cfgFor(root))
    expect(diff.change).toBe('added')
    expect(diff.old).toEqual({ present: false })
  })

  it('discards a tracked edit back to HEAD content', async () => {
    const root = await makeRepo()
    await writeFile(join(root, 'kept.txt'), 'v2 dirty\n')
    const svc = service()
    const before = await svc.diff('repo', 'kept.txt', cfgFor(root))
    expect(before.change).toBe('modified')
    await svc.discard('repo', 'kept.txt', false, cfgFor(root))
    const after = await svc.diff('repo', 'kept.txt', cfgFor(root))
    expect(after.change).toBe('unchanged')
  })

  it('discards an untracked file by removing it from the worktree', async () => {
    const root = await makeRepo()
    await writeFile(join(root, 'junk.txt'), 'delete me\n')
    const svc = service()
    await svc.discard('repo', 'junk.txt', true, cfgFor(root))
    const diff = await svc.diff('repo', 'junk.txt', cfgFor(root))
    expect(diff.new).toEqual({ present: false })
  })
})
