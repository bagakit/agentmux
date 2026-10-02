import { fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
import { afterEach, describe, expect, it, vi } from 'vitest'
import { execFile } from 'node:child_process'
import { chmod, mkdtemp, mkdir, readFile, realpath, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { ExecutionHost } from '@agentmux/core'
import type { WorkspaceRecord } from '../src/shared/contracts'
import { WorkspaceFiles } from '../src/main/workspace-files'

const execute = promisify(execFile), roots: string[] = [], owners: WorkspaceFiles[] = []
async function fixture() {
  const temporary = await mkdtemp(join(tmpdir(), 'agentmux-file-time-'))
  roots.push(temporary)
  const directory = join(temporary, 'workspace'); await mkdir(directory)
  return { temporary, directory }
}
function workspace(path: string, hostId: string): WorkspaceRecord {
  return { id: 'file-time-workspace', name: 'Files', kind: 'folder', hostId, path }
}
function owner(host: ExecutionHost) { const files = new WorkspaceFiles(() => host); owners.push(files); return files }
afterEach(async () => {
  await Promise.all(owners.splice(0).map(files => files.dispose()))
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('original WorkspaceFiles regular-file modification facts', () => {
  it('returns actual local regular-file mtime including epoch zero while preserving symlink and alphabetical listing facts', async () => {
    const { directory } = await fixture()
    for (const [name, seconds] of [['a-old.txt', 10], ['z-new.txt', 20], ['zero.txt', 0]] as const) {
      const path = join(directory, name); await writeFile(path, name); await utimes(path, seconds, seconds)
    }
    await mkdir(join(directory, 'folder')); await symlink('z-new.txt', join(directory, 'linked.txt'))
    const run = vi.fn<ExecutionHost['run']>()
    const files = owner({ id: 'local', kind: 'local', label: 'Local', run, dispose: async () => {} })
    const entries = await files.readDirectory(workspace(directory, 'local'), '')
    expect(entries.map(entry => entry.name)).toEqual(['folder', 'a-old.txt', 'linked.txt', 'z-new.txt', 'zero.txt'])
    for (const name of ['a-old.txt', 'z-new.txt', 'zero.txt']) {
      expect(entries.find(entry => entry.name === name)?.mtimeMs).toBe((await stat(join(directory, name))).mtimeMs)
    }
    expect(entries.find(entry => entry.name === 'zero.txt')?.mtimeMs).toBe(0)
    expect(entries.find(entry => entry.name === 'z-new.txt')!.mtimeMs).toBeGreaterThan(entries.find(entry => entry.name === 'a-old.txt')!.mtimeMs!)
    expect(entries.find(entry => entry.name === 'linked.txt')).toEqual({ name: 'linked.txt', path: 'linked.txt', isDirectory: false, isSymlink: true, linkTarget: 'z-new.txt' })
    expect(entries.find(entry => entry.name === 'folder')).toEqual({ name: 'folder', path: 'folder', isDirectory: true, isSymlink: false })
    expect(run).not.toHaveBeenCalled()
  })

  it.each(['gnu', 'bsd'] as const)('executes the original single SSH listing batch with %s stat responses and preserves NUL names and unknown metadata', async protocol => {
    const { temporary, directory } = await fixture(), binaries = join(temporary, 'bin'), audit = join(temporary, 'stat-calls')
    await mkdir(binaries)
    const names = ['a-old.txt', 'z-new\nnote.txt', 'zero.txt', 'invalid.txt', 'unsupported.txt']
    for (const name of names) await writeFile(join(directory, name), name)
    await mkdir(join(directory, 'folder')); await symlink('a-old.txt', join(directory, 'linked.txt'))
    // The transport runs Main's actual canonical-directory/find/sh producer. Only the remote stat
    // protocol is controlled; no Main implementation or parser is substituted.
    const executable = join(binaries, 'stat')
    await writeFile(executable, `#!/bin/sh
printf '%s\\n' "$1" >> "$SOURCE_FILE_TIME_AUDIT"
case "$SOURCE_FILE_TIME_PROTOCOL:$1" in gnu:-c|bsd:-f) ;; *) exit 1 ;; esac
for path do :; done
case "\${path##*/}" in
  a-old.txt) printf '10\\n' ;;
  z-new*) printf '20\\n' ;;
  zero.txt) printf '0\\n' ;;
  invalid.txt) printf 'not-a-timestamp\\n' ;;
  *) exit 1 ;;
esac
`); await chmod(executable, 0o755)
    const run = vi.fn<ExecutionHost['run']>(async (command, args, options) => {
      if (command === 'git') return { stdout: '', stderr: '', exitCode: 1 }
      expect(command).toBe('sh')
      expect(args[2]).toBe('agentmux-directory')
      expect(args.at(-1)).toBe(directory)
      const result = await execute(command, args, { encoding: 'utf8', timeout: 30_000, maxBuffer: 2 * 1024 * 1024,
        env: { ...process.env, PATH: binaries + ':' + process.env.PATH, SOURCE_FILE_TIME_PROTOCOL: protocol, SOURCE_FILE_TIME_AUDIT: audit } })
      expect(options).toMatchObject({ timeoutMs: 30_000, maxOutputBytes: 2 * 1024 * 1024 })
      const framed = result.stdout.split('\0')
      expect(framed.shift()).toBe(await realpath(directory))
      expect(framed).toHaveLength(7 * 3 + 1)
      expect(framed.at(-1)).toBe('')
      return { ...result, exitCode: 0 }
    })
    const files = owner({ id: 'remote', kind: 'ssh', label: 'Remote', run, dispose: async () => {} })
    const entries = await files.readDirectory(workspace(directory, 'remote'), '')
    expect(entries).toHaveLength(7)
    expect(new Set(entries.map(entry => entry.name))).toEqual(new Set([...names, 'folder', 'linked.txt']))
    for (const [name, mtimeMs] of [['a-old.txt', 10_000], ['z-new\nnote.txt', 20_000], ['zero.txt', 0]] as const) {
      expect(entries.find(entry => entry.name === name)).toEqual({ name, path: name, isDirectory: false, isSymlink: false, mtimeMs })
    }
    for (const name of ['invalid.txt', 'unsupported.txt', 'folder', 'linked.txt']) {
      expect(entries.find(entry => entry.name === name)).toBeDefined()
      expect(entries.find(entry => entry.name === name)).not.toHaveProperty('mtimeMs')
    }
    expect(entries.find(entry => entry.name === 'linked.txt')?.isSymlink).toBe(true)
    expect(run.mock.calls.map(([command]) => command)).toEqual(['sh', 'git'])
    const calls = (await readFile(audit, 'utf8')).trim().split('\n')
    expect(calls.filter(flag => flag === '-c')).toHaveLength(names.length)
    expect(calls.filter(flag => flag === '-f')).toHaveLength(protocol === 'bsd' ? names.length : 1)
  }, 10_000)

  it('keeps every SSH entry when modification metadata is missing, invalid or not a regular file', async () => {
    const run = vi.fn<ExecutionHost['run']>(async (command, args) => {
      if (command === 'sh') {
        expect(args[2]).toBe('agentmux-directory')
        return { stdout: [_hygiene_fixturePath("srv/file-time"), 'missing.txt', 'f', '', 'invalid.txt', 'f', 'Infinity', 'linked.txt', 'lf', '99', 'folder', 'd', '10', ''].join('\0'), stderr: '', exitCode: 0 }
      }
      expect(command).toBe('git'); return { stdout: '', stderr: '', exitCode: 1 }
    })
    const files = owner({ id: 'remote', kind: 'ssh', label: 'Remote', run, dispose: async () => {} })
    const entries = await files.readDirectory(workspace(_hygiene_fixturePath("srv/file-time"), 'remote'), '')
    expect(entries).toEqual([
      { name: 'folder', path: 'folder', isDirectory: true, isSymlink: false },
      { name: 'invalid.txt', path: 'invalid.txt', isDirectory: false, isSymlink: false },
      { name: 'linked.txt', path: 'linked.txt', isDirectory: false, isSymlink: true },
      { name: 'missing.txt', path: 'missing.txt', isDirectory: false, isSymlink: false }
    ])
    expect(run.mock.calls.map(([command]) => command)).toEqual(['sh', 'git'])
  })
})
