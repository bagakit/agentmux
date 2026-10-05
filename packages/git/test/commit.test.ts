import { fixturePath } from '../../../test/fixture-values.mjs'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  GitRepository, GIT_NONINTERACTIVE_ENV, readLocalWorktreeFile, createRunnerWorktreeReader,
  type GitCommandRunner, type GitCommitDetailsResult, type GitCommitDiffDescriptor
} from '../src/index.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))) })

// Independent system Git port. The package itself has no Core or process lifecycle dependency.
const runner: GitCommandRunner = {
  async run(command, args, options = {}) {
    const env = { ...process.env }
    for (const [key, value] of Object.entries(options.env ?? {})) {
      if (value === undefined) delete env[key]
      else env[key] = value
    }
    try {
      return { exitCode: 0, stdout: execFileSync(command, [...args], {
        env, encoding: 'utf8', timeout: options.timeoutMs, maxBuffer: options.maxOutputBytes,
        ...(options.input === undefined ? {} : { input: options.input }), stdio: ['pipe', 'pipe', 'pipe']
      }), stderr: '' }
    } catch (error) {
      const failure = error as { status?: number; stdout?: Buffer; stderr?: Buffer; code?: string }
      if (failure.code === 'ENOBUFS') throw Object.assign(new Error('Command output exceeded its byte limit'), { code: 'COMMAND_OUTPUT_LIMIT' })
      if (typeof failure.status !== 'number') throw error
      return { exitCode: failure.status, stdout: String(failure.stdout ?? ''), stderr: String(failure.stderr ?? '') }
    }
  }
}

async function fixture(sha256 = false) {
  const path = await mkdtemp(join(tmpdir(), 'agentmux-neutral-git-')); roots.push(path)
  const git = async (...args: string[]) => {
    const result = await runner.run('git', ['-C', path, ...args], { env: GIT_NONINTERACTIVE_ENV, timeoutMs: 20_000, maxOutputBytes: 8 * 1024 * 1024 })
    if (result.exitCode !== 0) throw new Error(result.stderr)
    return result.stdout.trim()
  }
  await git('init', '-b', 'main', ...(sha256 ? ['--object-format=sha256'] : []))
  await git('config', 'user.name', 'Private Author'); await git('config', 'user.email', 'fixture@example.invalid')
  const repo = new GitRepository({ hostId: 'private-host', path }, runner, readLocalWorktreeFile)
  const commit = async (message: string) => { await git('add', '--all'); await git('commit', '-m', message); return git('rev-parse', 'HEAD') }
  return { path, git, repo, commit }
}

function ready(result: GitCommitDetailsResult) {
  expect(result.kind).toBe('ready')
  if (result.kind !== 'ready') throw new Error('The actual repository has no commit details')
  return result
}
function descriptor(result: ReturnType<typeof ready>, path: string): GitCommitDiffDescriptor {
  const file = result.entries.find(entry => entry.path === path)
  expect(file).toBeDefined()
  return { kind: 'commit', snapshot: result.snapshot, file: { path, origPath: file!.origPath } }
}

describe('neutral immutable commit reading through actual private Git', () => {
  it('reads the selected commit without enumerating thousands of unrelated references', async () => {
    const f = await fixture()
    await writeFile(join(f.path, 'selected.txt'), 'selected body\n')
    const oid = await f.commit('Selected subject\n\nComplete selected message')
    await f.git('tag', '-a', 'selected', oid, '-m', 'Selected annotated tag')
    await f.git('commit', '--allow-empty', '-m', 'Unrelated head')
    const other = await f.git('rev-parse', 'HEAD')
    const updates = Array.from({ length: 2001 }, (_, i) => `create refs/tags/unrelated-${i} ${other}`).join('\n') + '\n'
    const updated = await runner.run('git', ['-C', f.path, 'update-ref', '--stdin'], { input: updates })
    expect(updated.exitCode).toBe(0)
    const calls: string[][] = []
    const observed: GitCommandRunner = { run(command, args, options) {
      calls.push([...args])
      return runner.run(command, args, options)
    } }
    const repo = new GitRepository({ hostId: 'private-host', path: f.path }, observed, readLocalWorktreeFile)
    const selected = ready(await repo.commitDetails({ oid }))
    expect(selected.commit.message).toBe('Selected subject\n\nComplete selected message\n')
    expect(selected.commit.refs.map(ref => ref.name)).toEqual(['refs/tags/selected'])
    expect(selected.entries.map(entry => entry.path)).toEqual(['selected.txt'])
    expect(selected.warnings).toEqual([])
    expect(calls.find(args => args.includes('for-each-ref'))).toContain(`--points-at=${oid}`)
    expect((await repo.commitDiff(descriptor(selected, 'selected.txt'))).new).toMatchObject({ text: 'selected body\n' })
  }, 20_000)

  it('keeps fixed content readable with explicit unknown decorations and retries the same commit', async () => {
    const f = await fixture()
    await writeFile(join(f.path, 'selected.txt'), 'selected body\n')
    const oid = await f.commit('Full selected message')
    let unavailable = true
    const observed: GitCommandRunner = { run(command, args, options) {
      return unavailable && args.includes('for-each-ref')
        ? Promise.resolve({ exitCode: 1, stdout: '', stderr: 'offline https://secret@host.invalid/repo' })
        : runner.run(command, args, options)
    } }
    const repo = new GitRepository({ hostId: 'private-host', path: f.path }, observed, readLocalWorktreeFile)
    const selected = ready(await repo.commitDetails({ oid }))
    expect(selected.commit.message).toBe('Full selected message\n')
    expect(selected.entries.map(entry => entry.path)).toEqual(['selected.txt'])
    expect(selected.warnings.join('\n')).toContain('Commit references unavailable. Reload this fixed commit to retry:')
    expect(selected.warnings.join('\n')).not.toContain('secret')
    expect((await repo.commitDiff(descriptor(selected, 'selected.txt'))).new).toMatchObject({ text: 'selected body\n' })
    unavailable = false
    const recovered = ready(await repo.commitDetails({ oid }))
    expect(recovered.snapshot).toEqual(selected.snapshot)
    expect(recovered.commit.refs.map(ref => ref.name).sort()).toEqual(['HEAD', 'refs/heads/main'])
    expect(recovered.warnings).toEqual([])
  })

  it('reads full root message, observed refs and literal paths, and keeps fixed blobs after HEAD/worktree move', async () => {
    const f = await fixture()
    const path = '中文 [literal] "line\nbreak.txt'
    await writeFile(join(f.path, path), 'original\n')
    const oid = await f.commit('Root subject\n\nFull body café first line\n  indented second line\n\nFinal paragraph')
    await f.git('tag', '-a', 'v1', '-m', 'Annotated')
    await f.git('config', 'i18n.logOutputEncoding', 'ISO-8859-1')
    const details = ready(await f.repo.commitDetails({ oid }))
    expect(details.commit.oid).toBe(oid)
    expect(details.commit.message).toBe('Root subject\n\nFull body café first line\n  indented second line\n\nFinal paragraph\n')
    expect(details.commit.subject).toBe('Root subject')
    expect(details.commit.author).toBe('Private Author')
    expect(details.commit.committer).toBe('Private Author')
    expect(details.commit.authoredAt).toEqual(expect.any(Number))
    expect(details.commit.committedAt).toEqual(expect.any(Number))
    expect(details.commit.parents).toEqual([])
    expect(details.snapshot).toEqual({ hostId: 'private-host', repoPath: await f.git('rev-parse', '--show-toplevel'), commitOid: oid, parentOid: null })
    expect(details.commit.refs.map(ref => ref.name).sort()).toEqual(['HEAD', 'refs/heads/main', 'refs/tags/v1'])
    expect(details.entries).toEqual([{ path, origPath: null, change: 'added' }])
    const fixed = descriptor(details, path)
    await writeFile(join(f.path, path), 'later commit\n'); await f.commit('Later')
    await writeFile(join(f.path, path), 'dirty decoy\n')
    const before = await f.git('status', '--porcelain=v1', '-z')
    const diff = await f.repo.commitDiff(fixed)
    expect(diff.old).toEqual({ present: false })
    expect(diff.new).toEqual({ present: true, binary: false, text: 'original\n' })
    expect(diff.change).toBe('added')
    expect(await f.git('status', '--porcelain=v1', '-z')).toBe(before)
    expect(await readFile(join(f.path, path), 'utf8')).toBe('dirty decoy\n')
  })

  it('uses rename original paths, deleted absence and actual binary blobs', async () => {
    const f = await fixture()
    await writeFile(join(f.path, 'old.txt'), 'rename content\n'); await writeFile(join(f.path, 'gone.txt'), 'deleted\n')
    const base = await f.commit('Base')
    await f.git('mv', 'old.txt', 'new.txt'); await rm(join(f.path, 'gone.txt')); await writeFile(join(f.path, 'binary.bin'), Buffer.from([1, 0, 2]))
    const oid = await f.commit('Rename and delete')
    const details = ready(await f.repo.commitDetails({ oid }))
    expect(details.snapshot.parentOid).toBe(base)
    expect(details.entries).toEqual([
      { path: 'binary.bin', origPath: null, change: 'added' },
      { path: 'gone.txt', origPath: null, change: 'deleted' },
      { path: 'new.txt', origPath: 'old.txt', change: 'renamed' }
    ])
    const rename = await f.repo.commitDiff(descriptor(details, 'new.txt'))
    expect(rename.old).toEqual({ present: true, binary: false, text: 'rename content\n' })
    expect(rename.new).toEqual(rename.old)
    const deleted = await f.repo.commitDiff(descriptor(details, 'gone.txt'))
    expect(deleted.old).toEqual({ present: true, binary: false, text: 'deleted\n' }); expect(deleted.new).toEqual({ present: false })
    const binary = await f.repo.commitDiff(descriptor(details, 'binary.bin'))
    expect(binary.binary).toBe(true); expect(binary.new).toEqual({ present: true, binary: true })
  })

  it('keeps every merge parent and explicitly compares the chosen direct parent', async () => {
    const f = await fixture()
    await writeFile(join(f.path, 'base.txt'), 'base\n'); const root = await f.commit('Base')
    await f.git('switch', '-c', 'side'); await writeFile(join(f.path, 'side.txt'), 'side\n'); const side = await f.commit('Side')
    await f.git('switch', 'main'); await writeFile(join(f.path, 'main.txt'), 'main\n'); const main = await f.commit('Main')
    await f.git('merge', '--no-ff', 'side', '-m', 'Merge\n\nFull merge body'); const oid = await f.git('rev-parse', 'HEAD')
    const first = ready(await f.repo.commitDetails({ oid }))
    expect(first.commit.parents).toEqual([main, side]); expect(first.snapshot.parentOid).toBe(main)
    expect(first.entries.map(entry => entry.path)).toEqual(['side.txt'])
    const second = ready(await f.repo.commitDetails({ oid, parentOid: side }))
    expect(second.commit.parents).toEqual([main, side]); expect(second.snapshot.parentOid).toBe(side)
    expect(second.entries.map(entry => entry.path)).toEqual(['main.txt'])
    expect((await f.repo.commitDiff(descriptor(second, 'main.txt'))).old).toEqual({ present: false })
    await expect(f.repo.commitDetails({ oid, parentOid: root })).rejects.toThrow('not a direct parent')
    await expect(f.repo.commitDiff({ ...descriptor(first, 'side.txt'), snapshot: { ...first.snapshot, parentOid: null } })).rejects.toThrow('not a direct parent')
  })

  it('rejects noncommit/revision expressions, missing objects, wrong repository/host and escaping paths without fake empty results', async () => {
    const f = await fixture(); await writeFile(join(f.path, 'one.txt'), 'one\n'); const oid = await f.commit('One')
    const details = ready(await f.repo.commitDetails({ oid })); const fixed = descriptor(details, 'one.txt')
    for (const invalid of ['HEAD', oid.slice(0, 8), '--all', `${oid}^`]) await expect(f.repo.commitDetails({ oid: invalid })).rejects.toThrow('complete commit object ID')
    await expect(f.repo.commitDetails({ oid: await f.git('rev-parse', `${oid}:one.txt`) })).rejects.toThrow('not a commit')
    await expect(f.repo.commitDetails({ oid: 'a'.repeat(40) })).rejects.toThrow()
    await expect(f.repo.commitDiff({ ...fixed, snapshot: { ...fixed.snapshot, hostId: 'other-host' } })).rejects.toThrow('no longer refers')
    const other = await fixture(); await expect(other.repo.commitDiff(fixed)).rejects.toThrow('no longer refers')
    for (const path of ['../one.txt', fixturePath("one.txt"), 'a\0b', 'a/../one.txt']) await expect(f.repo.commitDiff({ ...fixed, file: { path, origPath: null } })).rejects.toThrow('repository-relative')
    const plain = await mkdtemp(join(tmpdir(), 'agentmux-git-plain-')); roots.push(plain)
    expect(await new GitRepository({ hostId: 'plain', path: plain }, runner, readLocalWorktreeFile).commitDetails({ oid })).toEqual({ kind: 'not-a-git-repository', hostId: 'plain', workspacePath: plain })
  })

  it('supports SHA-256 root commits and a successful empty commit independently of HEAD', async () => {
    const f = await fixture(true); await writeFile(join(f.path, 'one.txt'), 'one\n'); const oid = await f.commit('SHA256 root')
    expect(oid).toHaveLength(64)
    const details = ready(await f.repo.commitDetails({ oid }))
    expect(details.snapshot.parentOid).toBeNull(); expect(details.entries.map(entry => entry.path)).toEqual(['one.txt'])
    expect((await f.repo.commitDiff(descriptor(details, 'one.txt'))).old).toEqual({ present: false })
    await f.git('commit', '--allow-empty', '-m', 'Empty')
    expect(ready(await f.repo.commitDetails({ oid: await f.git('rev-parse', 'HEAD') })).entries).toEqual([])
  })

  it('does not turn a shallow missing parent into a root or let replacement refs alter pinned commits', async () => {
    const f = await fixture(); await writeFile(join(f.path, 'one.txt'), 'original\n'); const root = await f.commit('Original')
    const original = ready(await f.repo.commitDetails({ oid: root })); const fixed = descriptor(original, 'one.txt')
    await writeFile(join(f.path, 'one.txt'), 'later\n'); const later = await f.commit('Later')
    await f.git('replace', root, later)
    expect(ready(await f.repo.commitDetails({ oid: root })).commit.parents).toEqual([])
    expect((await f.repo.commitDiff(fixed)).new).toEqual({ present: true, binary: false, text: 'original\n' })
    await f.git('replace', '-d', root)
    const shallow = await mkdtemp(join(tmpdir(), 'agentmux-git-shallow-')); roots.push(shallow)
    await f.git('clone', '--depth=1', pathToFileURL(f.path).href, shallow)
    const repo = new GitRepository({ hostId: 'shallow', path: shallow }, runner, readLocalWorktreeFile)
    await expect(repo.commitDetails({ oid: later })).rejects.toThrow('bad object')
  })

  it('bounds large text and file lists while retaining ordinary multi-file reads', async () => {
    const f = await fixture()
    await writeFile(join(f.path, 'large.txt'), 'x'.repeat(2 * 1024 * 1024 + 100))
    await Promise.all(Array.from({ length: 80 }, (_, i) => writeFile(join(f.path, `normal-${i}.txt`), `normal ${i}\n`)))
    const oid = await f.commit('Large file and normal files'); const details = ready(await f.repo.commitDetails({ oid }))
    expect(details.entries).toHaveLength(81)
    expect((await f.repo.commitDiff(descriptor(details, 'large.txt'))).new).toEqual({ present: true, binary: true })
    expect((await f.repo.commitDiff(descriptor(details, 'normal-79.txt'))).new).toEqual({ present: true, binary: false, text: 'normal 79\n' })
    await Promise.all(Array.from({ length: 1001 }, (_, i) => writeFile(join(f.path, `overflow-${i}.txt`), `${i}\n`)))
    const overflow = await f.commit('Overflow list')
    await expect(f.repo.commitDetails({ oid: overflow })).rejects.toThrow('1000')
  }, 20_000)

  it('has a nonempty capability owner with no Core, Desktop, Electron or React imports', async () => {
    const directory = new URL('../src/', import.meta.url)
    const files = (await readdir(directory)).filter(file => file.endsWith('.ts'))
    expect(files.length).toBeGreaterThan(2)
    const imports = (await Promise.all(files.map(file => readFile(new URL(file, directory), 'utf8')))).flatMap(source => [...source.matchAll(/(?:from\s+|import\s*\()['"]([^'"]+)['"]/gu)].map(match => match[1]!))
    expect(imports.length).toBeGreaterThan(0)
    expect(imports.filter(name => name.includes('@agentmux/core') || name.includes('apps/desktop') || /^(electron|react)(\/|$)/u.test(name))).toEqual([])
  })

  it('reads exact same-host bytes through a text runner and retains absence, permission and output failures', async () => {
    const f = await fixture()
    const path = join(f.path, 'quote\' $(touch SENTINEL)\n.bin')
    const bytes = Buffer.from([0xff, 0x00, 0x61, 0x80])
    await writeFile(path, bytes)
    const read = createRunnerWorktreeReader(runner)
    expect(await read(path)).toEqual({ present: true, oversized: false, bytes })
    expect((await readdir(f.path)).includes('SENTINEL')).toBe(false)
    expect(await read(join(f.path, 'missing.txt'))).toEqual({ present: false })
    expect(await read(f.path)).toEqual({ present: false })
    await expect(createRunnerWorktreeReader({ run: async () => ({ exitCode: 46, stdout: '', stderr: 'denied' }) })(path)).rejects.toThrow('execution host')
    expect(await createRunnerWorktreeReader({ run: async () => { throw Object.assign(new Error('bounded'), { code: 'COMMAND_OUTPUT_LIMIT' }) } })(path)).toEqual({ present: true, oversized: true })
    await expect(createRunnerWorktreeReader({ run: async () => ({ exitCode: 0, stdout: '%invalid', stderr: '' }) })(path)).rejects.toThrow('invalid file bytes')
  })
})
