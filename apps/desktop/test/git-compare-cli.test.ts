import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import * as core from '@agentmux/core'
import { parseGitParams, parseGitResult } from '../../../packages/core/src/public-rpc-git.js'
import { rpcOwnerFixture } from '../../../packages/core/test/helpers/public-rpc-owner.js'
import { objectCliEnvironment, runCompiledObjectCli } from '../../../packages/core/test/helpers/object-cli-rpc.js'
import { startAgentMuxHost } from '../../host/src/host.js'
import { GitPublicControl } from '../src/main/git-public-control.js'
import { GitService } from '../src/main/git-service.js'
import type { AppConfig } from '../src/shared/contracts.js'

const cleanup: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllEnvs() })
async function fixture() {
  const original = await rpcOwnerFixture(['original-agent'], core); cleanup.push(original.close)
  const native = original.inner.kernel; await original.client.dispose()
  const execution = new core.LocalExecutionHost(), repo = join(original.root, 'repo'), plain = join(original.root, 'plain')
  await mkdir(repo); await mkdir(plain)
  const git = async (...args: string[]) => {
    const result = await execution.run('git', ['-c', 'core.hooksPath=/dev/null', '-C', repo, ...args], { timeoutMs: 10000, maxOutputBytes: 1024 * 1024 })
    if (result.exitCode !== 0) throw new Error(result.stderr)
    return result.stdout.trim()
  }
  await git('init', '-b', 'base'); await git('config', 'user.name', 'Private'); await git('config', 'user.email', 'private@example.invalid')
  await writeFile(join(repo, 'old.txt'), 'Original rename body\nline two\nline three\n'); await writeFile(join(repo, 'common.txt'), 'seed\n')
  await git('add', '--all'); await git('commit', '--no-verify', '-m', 'Seed'); const seed = await git('rev-parse', 'HEAD')
  await git('branch', 'target'); await writeFile(join(repo, 'common.txt'), 'base advanced\n')
  await git('add', '--all'); await git('commit', '--no-verify', '-m', 'Base'); const base = await git('rev-parse', 'HEAD')
  await git('checkout', 'target'); await rename(join(repo, 'old.txt'), join(repo, 'new\nname 中文.txt')); await writeFile(join(repo, 'common.txt'), 'target advanced\n')
  await git('add', '--all'); await git('commit', '--no-verify', '-m', 'Target'); const target = await git('rev-parse', 'HEAD')
  await git('checkout', 'base'); await writeFile(join(repo, 'dirty.txt'), 'Keep user work\n')
  let config = { version: 9, hosts: [{ id: 'local', kind: 'local', label: 'Private' }], executors: {},
    workspaces: [{ id: 'repo', hostId: 'local', path: repo, name: 'Private', kind: 'folder' }, { id: 'plain', hostId: 'local', path: plain, name: 'Plain', kind: 'folder' }],
    appearance: { terminalTheme: 'graphite' }, browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } } } as AppConfig
  const service = new GitService(() => execution), owner = new GitPublicControl({ config: () => config, git: service })
  const desktop = new core.AgentMuxControlServer({ socketPath: join(original.root, 'desktop.sock'), coreClients: () => [], git: owner })
  await desktop.start(); cleanup.push(() => desktop.stop())
  const connect = vi.spyOn(core.AgentMuxClient.prototype, 'connect').mockImplementationOnce(async function () {
    const inner = this as unknown as typeof original.inner
    await inner.registry.load('local'); inner.connected = true
    for (const name of ['isConnected', 'status', 'identity', 'input', 'observeOutput', 'attach', 'detach', 'stop']) inner.kernel[name] = native[name]
  })
  let host: Awaited<ReturnType<typeof startAgentMuxHost>>
  try {
    host = await startAgentMuxHost({ store: original.store, socketPath: join(original.root, 'control.sock'),
      desktopSocketPath: join(original.root, 'desktop.sock'), mobileBuildDirectory: join(original.root, 'absent-mobile') })
    cleanup.push(() => host.dispose())
    await vi.waitFor(() => expect((host.client as unknown as typeof original.inner).connected).toBe(true))
  } finally { connect.mockRestore() }
  const cli = (args: string[]) => runCompiledObjectCli(['git', ...args], objectCliEnvironment(original.root))
  const flags = ['--workspace', 'repo', '--host', 'local', '--workspace-path', repo]
  const compare = (mode: string, extras: string[] = []) => cli(['compare', ...flags, '--base', 'base', '--target', 'target', '--mode', mode, ...extras])
  return { original, repo, plain, git, cli, flags, compare, owner, service, seed, base, target, config: () => config, setConfig: (value: AppConfig) => { config = value } }
}

it('compiled CLI follows actual Host → Desktop original Git producer → immutable descriptor and diff without changing work', async () => {
  const f = await fixture(), before = await f.git('status', '--porcelain=v1'), sessions = await readFile(f.original.store.path)
  const compared = await f.compare('merge-base')
  expect(compared.code, compared.stderr).toBe(0)
  const result = JSON.parse(compared.stdout).result
  expect(result).toMatchObject({ kind: 'ready', snapshot: { hostId: 'local', mode: 'merge-base', baseBranch: 'base', targetBranch: 'target', baseOid: f.base, targetOid: f.target, comparisonBaseOid: f.seed } })
  const renamed = result.entries.find((entry: { change: string }) => entry.change === 'renamed')
  expect(renamed).toMatchObject({ path: 'new\nname 中文.txt', origPath: 'old.txt' })
  const descriptor = join(f.original.root, 'descriptor.json')
  await writeFile(descriptor, JSON.stringify({ snapshot: result.snapshot, file: { path: renamed.path, origPath: renamed.origPath } }))
  await f.git('branch', '-f', 'target', 'base')
  const diff = await f.cli(['diff', ...f.flags, '--input', descriptor])
  expect(diff.code, diff.stderr).toBe(0)
  expect(JSON.parse(diff.stdout).result).toMatchObject({ path: renamed.path, old: { present: true, text: 'Original rename body\nline two\nline three\n' }, new: { present: true, text: 'Original rename body\nline two\nline three\n' } })
  const two = await f.compare('two-point')
  expect(two.code, two.stderr).toBe(0)
  expect(JSON.parse(two.stdout).result.snapshot).toMatchObject({ comparisonBaseOid: f.base, baseOid: f.base, targetOid: f.base })
  expect(await f.git('status', '--porcelain=v1')).toBe(before)
  expect(await readFile(join(f.repo, 'dirty.txt'), 'utf8')).toBe('Keep user work\n')
  expect(await readFile(f.original.store.path)).toEqual(sessions)
})

it('actual public compare rejects wrong resources and native rev expressions, and rechecks a resource changed during its read', async () => {
  const f = await fixture()
  const wrong = await f.cli(['compare', '--workspace', 'repo', '--host', 'local', '--workspace-path', f.plain, '--base', 'base', '--target', 'target', '--mode', 'merge-base'])
  expect(wrong.code, wrong.stdout).not.toBe(0)
  expect(JSON.parse(wrong.stderr).error.code).toBe('GIT_RESOURCE_MISMATCH')
  for (const base of ['base~1', '--all', 'missing']) {
    const bad = await f.cli(['compare', ...f.flags, '--base', base, '--target', 'target', '--mode', 'merge-base'])
    expect(bad.code, bad.stdout).not.toBe(0)
  }
  const ordinary = await f.cli(['compare', '--workspace', 'plain', '--host', 'local', '--workspace-path', f.plain, '--base', 'base', '--target', 'target', '--mode', 'two-point'])
  expect(ordinary.code, ordinary.stderr).toBe(0)
  expect(JSON.parse(ordinary.stdout).result).toEqual({ kind: 'not-a-git-repository', hostId: 'local', workspacePath: f.plain })
  const compare = f.service.compareBranches.bind(f.service)
  vi.spyOn(f.service, 'compareBranches').mockImplementation(async (...args) => {
    const result = await compare(...args)
    f.setConfig({ ...f.config(), workspaces: f.config().workspaces.map(w => w.id === 'repo' ? { ...w, path: f.plain } : w) })
    return result
  })
  const late = await f.compare('two-point')
  expect(late.code, late.stdout).not.toBe(0)
  expect(JSON.parse(late.stderr).error.code).toBe('GIT_RESOURCE_MISMATCH')
})

it('strict public compare result binds mode, exact branches, original Host and both rename coordinates', () => {
  const input = parseGitParams('git.compare', { workspaceId: 'original', expectedResource: { hostId: 'local', workspacePath: '/private' }, input: { baseBranch: 'self', targetBranch: 'target', mode: 'two-point' } })
  const oid = 'a'.repeat(40)
  const result = { kind: 'ready', snapshot: { hostId: 'local', repoPath: '/private', baseBranch: 'self', targetBranch: 'target', mode: 'two-point', baseOid: oid, targetOid: oid, comparisonBaseOid: oid }, entries: [{ path: 'new.txt', origPath: 'old.txt', change: 'renamed' }], warnings: [] }
  expect(parseGitResult('git.compare', result, input)).toEqual(result)
  for (const changed of [{ ...result, snapshot: { ...result.snapshot, hostId: 'other' } }, { ...result, snapshot: { ...result.snapshot, targetBranch: 'other' } }, { ...result, snapshot: { ...result.snapshot, comparisonBaseOid: 'b'.repeat(40) } }, { ...result, entries: [{ ...result.entries[0], origPath: '../outside' }] }])
    expect(() => parseGitResult('git.compare', changed, input)).toThrow()
})
