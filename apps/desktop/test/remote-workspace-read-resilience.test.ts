import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentMuxError } from '../../../packages/core/src/errors'
import { WorkspaceFiles } from '../src/main/workspace-files'
import { createExecutionHost } from '../src/main/host-factory'
import { remoteDirectoryFixture } from './helpers/remote-directory-fixture'

let f: Awaited<ReturnType<typeof remoteDirectoryFixture>>
beforeEach(async () => {
  f = await remoteDirectoryFixture()
  vi.stubEnv('PATH', f.bin + ':' + process.env.PATH)
  vi.stubEnv('AGENTMUX_TEST_DIRECTORY_SSH_TRACE', f.trace)
})
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await f.dispose() })

describe('remote directory observation through actual system-SSH stdio', () => {
  it('reads every ancestor and exact entries in one SSH delivery with no shell interpolation', async () => {
    const directory = "deep/[brackets]/quoted ' level\n"
    await mkdir(join(f.path, directory), { recursive: true })
    const names = ['plain.md', "a ' quote.md", 'two\nlines.md', '$(touch must-not-exist).md']
    for (const name of names) await writeFile(join(f.path, directory, name), name)
    const entries = await f.files.readDirectory(f.workspace, directory)
    expect(entries.map(entry => entry.name).sort(), 'All original NUL-framed names must remain exact').toEqual([...names].sort())
    expect(entries.map(entry => entry.path).sort()).toEqual(names.map(name => directory + '/' + name).sort())
    const calls = await f.calls()
    expect(calls.filter(call => call.directory), 'Deep paths must use one SSH delivery').toHaveLength(1)
    expect(calls).toHaveLength(2) // One optional Git decoration read, independent of directory depth.
    for (const name of names) expect(await readFile(join(f.path, directory, name), 'utf8')).toBe(name)
  })

  it('keeps explicit linked reads, rejects ancestor cycles and lexical escapes without writes', async () => {
    const outside = join(f.root, 'outside'); await mkdir(outside)
    await writeFile(join(outside, 'original.md'), 'outside original')
    await symlink(outside, join(f.path, 'linked'))
    await symlink(f.path, join(outside, 'cycle'))
    const entries = await f.files.readDirectory(f.workspace, 'linked')
    expect(entries).toContainEqual({ name: 'original.md', path: 'linked/original.md', isDirectory: false, isSymlink: false })
    await expect(f.files.readDirectory(f.workspace, 'linked/cycle')).rejects.toThrow('Directory link cycle')
    const before = (await f.calls()).length
    await expect(f.files.readDirectory(f.workspace, '../outside')).rejects.toThrow('escapes')
    expect((await f.calls()).length).toBe(before)
    expect(await readFile(join(outside, 'original.md'), 'utf8')).toBe('outside original')
  })

  it('shares in-flight reads only for the same original execution Host, root and directory', async () => {
    vi.stubEnv('AGENTMUX_TEST_DIRECTORY_SSH_EXEC_DELAY', '100')
    await writeFile(join(f.path, 'original.md'), 'original')
    const first = f.files.readDirectory(f.workspace, ''), second = f.files.readDirectory({ ...f.workspace }, '')
    const [a, b] = await Promise.all([first, second])
    expect(a, 'Concurrent matching observations must consume the same result').toBe(b)
    expect((await f.calls()).filter(call => call.directory), 'A matching pending read must share the SSH work').toHaveLength(1)
    const replacementPath = join(f.root, 'replacement'); await mkdir(replacementPath)
    await writeFile(join(replacementPath, 'replacement.md'), 'replacement')
    const old = f.files.readDirectory(f.workspace, '')
    const next = f.files.readDirectory({ ...f.workspace, path: replacementPath }, '')
    expect((await old)[0]?.name).toBe('original.md'); expect((await next)[0]?.name).toBe('replacement.md')
    const newHost = createExecutionHost({ id: f.host.id, kind: 'ssh', label: 'Replacement Host', hostname: 'fixture.invalid' })
    let currentHost = f.host
    const files = new WorkspaceFiles(() => currentHost)
    const prior = files.readDirectory(f.workspace, ''); currentHost = newHost
    const replaced = files.readDirectory(f.workspace, '')
    expect((await prior)[0]?.name).toBe('original.md'); expect((await replaced)[0]?.name).toBe('original.md')
    expect((await f.calls()).filter(call => call.directory)).toHaveLength(5)
    await files.dispose(); await newHost.dispose()
  })

  it('allows delayed connection and command delivery within their distinct bounded budgets', async () => {
    vi.stubEnv('AGENTMUX_TEST_DIRECTORY_SSH_CONNECT_DELAY', '12000')
    vi.stubEnv('AGENTMUX_TEST_DIRECTORY_SSH_EXEC_DELAY', '4000')
    await writeFile(join(f.path, 'delayed.md'), 'delayed original')
    const started = Date.now()
    await expect(f.files.readDirectory(f.workspace, ''), 'A slow but bounded original directory must remain readable').resolves.toContainEqual(
      { name: 'delayed.md', path: 'delayed.md', isDirectory: false, isSymlink: false })
    expect(Date.now() - started).toBeGreaterThanOrEqual(16000)
    const calls = await f.calls()
    expect(calls.filter(call => call.directory)).toHaveLength(1)
    expect(calls[0]).toMatchObject({ connectTimeout: 20 })
  }, 26000)

  it('retains truthful command and resource errors and retries only on an explicit new read', async () => {
    const run = vi.spyOn(f.host, 'run')
    for (const code of ['COMMAND_TIMEOUT', 'COMMAND_ABORTED', 'COMMAND_OUTPUT_LIMIT']) {
      run.mockRejectedValueOnce(new AgentMuxError('Private read observation failed', code))
      await expect(f.files.readDirectory(f.workspace, 'missing')).rejects.toMatchObject({ code,
        message: expect.stringContaining(join(f.path, 'missing')) })
      expect(run).toHaveBeenCalledTimes(['COMMAND_TIMEOUT', 'COMMAND_ABORTED', 'COMMAND_OUTPUT_LIMIT'].indexOf(code) + 1)
    }
    run.mockRestore()
    await expect(f.files.readDirectory(f.workspace, 'missing')).rejects.toThrow('Private remote')
    await writeFile(join(f.path, 'after.md'), 'after')
    expect((await f.files.readDirectory(f.workspace, ''))[0]?.name).toBe('after.md')
  })

  it('rejects real stdio output beyond the byte budget without an automatic second command', async () => {
    vi.stubEnv('AGENTMUX_TEST_DIRECTORY_SSH_OUTPUT_LIMIT', '1')
    await expect(f.files.readDirectory(f.workspace, '')).rejects.toMatchObject({ code: 'COMMAND_OUTPUT_LIMIT' })
    expect((await f.calls()).filter(call => call.directory)).toHaveLength(1)
  })

  it('reports a real empty directory only after its complete owner response', async () => {
    await expect(f.files.readDirectory(f.workspace, '')).resolves.toEqual([])
    expect((await f.calls()).filter(call => call.directory)).toHaveLength(1)
  })
})
