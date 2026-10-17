// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWorkspaceLayout } from '@agentmux/layout'
import { LocalExecutionHost } from '@agentmux/core'
import { parseGitParams, parseGitResult } from '../../../packages/core/src/public-rpc-git'
import { parseAgentMuxCliInvocation } from '../../../packages/core/src/agentmux-cli-commands'
import { agentMuxCommandHelp } from '../../../packages/core/src/agentmux-cli-help'
import { agentMuxModuleSkill } from '../../../packages/core/src/agentmux-cli-module-skills'
import { AgentMuxRpcService } from '../../../packages/core/src/public-rpc-service'
import { WorktreeService, parseGitWorktreePorcelain } from '../src/main/worktree-service'
import { GitPublicControl } from '../src/main/git-public-control'
import { GitService } from '../src/main/git-service'
import type { AppConfig, WorkspaceRecord } from '../src/shared/contracts'
import type { GitWorktreesResult } from '../src/shared/git-contracts'
import { GIT_NONINTERACTIVE_ENV } from '@agentmux/git'
import { WorkspaceZonesPanel } from '../src/renderer/src/components/WorkspaceZonesPanel'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { directoryIdentity, workspaceZoneId } from '../src/shared/space-addresses'
import { composerConfig, composerDOM } from './helpers/composer-dom-fixture'

const dom = composerDOM()
let root: string, repo: string, lane: string, host: LocalExecutionHost, config: AppConfig, workspace: WorkspaceRecord
let native: WorktreeService, owner: GitPublicControl
const runOptions = { env: GIT_NONINTERACTIVE_ENV, timeoutMs: 20_000, maxOutputBytes: 2 * 1024 * 1024 }
const target = () => ({ workspaceId: workspace.id, expectedResource: { hostId: workspace.hostId, workspacePath: workspace.path } })
async function git(...args: string[]) {
  const result = await host.run('git', ['-C', repo, ...args], runOptions)
  expect(result.exitCode, result.stderr).toBe(0)
  return result.stdout.trim()
}
const ready = (value: GitWorktreesResult) => { expect(value.kind).toBe('ready'); if (value.kind !== 'ready') throw new Error('Real Git fixture unavailable'); return value }
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'amx-zone-worktrees-')))
  repo = join(root, 'repo'); lane = join(root, 'linked newline\n目录'); await mkdir(repo)
  host = new LocalExecutionHost()
  await git('init', '-b', 'main'); await git('config', 'user.name', 'Private Worktree'); await git('config', 'user.email', 'private@example.invalid')
  await writeFile(join(repo, 'file.txt'), 'keep source\n'); await git('add', '.'); await git('commit', '-m', 'Initial')
  await git('worktree', 'add', '-b', 'original-lane', lane)
  workspace = { id: 'root', hostId: 'local', path: repo, name: 'Project alias', kind: 'folder', repoPath: join(root, 'wrong-registration-root'), branch: 'obsolete-registration' }
  config = { ...composerConfig, workspaces: [workspace] }
  native = new WorktreeService(() => host, { save: vi.fn(async value => value) })
  owner = new GitPublicControl({ config: () => config, git: new GitService(() => host), worktrees: native })
})
afterEach(async () => { await host.dispose(); await rm(root, { recursive: true, force: true }) })

it('uses native complete paths, branch changes, detached and bare protocol without trusting registration or writing config', async () => {
  const before = JSON.stringify(config), calls = vi.spyOn(host, 'run')
  const first = ready(await owner.call('git.worktrees', target()))
  expect(first.worktrees).toEqual([{ path: repo, branch: 'main', kind: 'main', detached: false, aliases: [] },
    { path: lane, branch: 'original-lane', kind: 'linked', detached: false, aliases: [] }])
  expect(calls.mock.calls.filter(call => call[0] === 'git').map(call => call[1])).toEqual([['-C', repo, 'rev-parse', '--show-toplevel'], ['-C', repo, 'worktree', 'list', '--porcelain', '-z']])
  await host.run('git', ['-C', lane, 'switch', '-c', 'self'], runOptions)
  await expect(owner.call('git.worktrees', target())).resolves.toMatchObject({ worktrees: [{ branch: 'main' }, { branch: 'self' }] })
  await host.run('git', ['-C', lane, 'switch', '-c', 'current-lane'], runOptions)
  expect(ready(await owner.call('git.worktrees', target())).worktrees[1]?.branch).toBe('current-lane')
  await host.run('git', ['-C', lane, 'checkout', '--detach'], runOptions)
  expect(ready(await owner.call('git.worktrees', target())).worktrees[1]).toMatchObject({ path: lane, branch: null, detached: true })
  expect(parseGitWorktreePorcelain(`worktree ${join(root, 'bare')}\0bare\0\0worktree ${lane}\0HEAD ${'a'.repeat(40)}\0detached\0\0`))
    .toEqual([{ path: join(root, 'bare'), branch: null, kind: 'bare', detached: false, aliases: [] }, { path: lane, branch: null, kind: 'linked', detached: true, aliases: [] }])
  expect(JSON.stringify(config)).toBe(before)
})

it('keeps definite non-Git distinct from unavailable and rejects an incorrect or rebound exact resource', async () => {
  const plain = join(root, 'plain'); await mkdir(plain)
  config = { ...config, workspaces: [{ ...workspace, path: plain }] }; workspace = config.workspaces[0]!
  expect(await owner.call('git.worktrees', target())).toMatchObject({ kind: 'not-a-git-repository', workspacePath: plain })
  config = { ...config, workspaces: [{ ...workspace, path: join(root, 'missing') }] }; workspace = config.workspaces[0]!
  expect(await owner.call('git.worktrees', target())).toMatchObject({ kind: 'unavailable', reason: expect.any(String) })
  const observe = vi.spyOn(native, 'observe')
  await expect(owner.call('git.worktrees', { ...target(), expectedResource: { hostId: 'foreign', workspacePath: workspace.path } })).rejects.toMatchObject({ code: 'GIT_RESOURCE_MISMATCH' })
  expect(observe).not.toHaveBeenCalled()
  observe.mockImplementationOnce(async () => { const answer = { kind: 'unavailable' as const, ...target().expectedResource, checkedAt: 1, reason: 'private offline' }
    config = { ...config, workspaces: [{ ...workspace, path: repo }] }; return answer })
  await expect(owner.call('git.worktrees', target())).rejects.toMatchObject({ code: 'GIT_RESOURCE_MISMATCH' })
})

it('retains successful canonical Git content when optional Host alias observation is unavailable', async () => {
  const run = host.run.bind(host)
  vi.spyOn(host, 'run').mockImplementation((command, args, options) => command === 'node'
    ? Promise.resolve({ command, args, exitCode: 1, stdout: '', stderr: 'Controlled alias observer unavailable', durationMs: 1 })
    : run(command, args, options))
  const result = ready(await owner.call('git.worktrees', target()))
  expect(result.worktrees.map(value => value.path)).toEqual([repo, lane])
  expect(result.worktrees[1]?.branch).toBe('original-lane')
  expect(result.warnings.join('\n')).toContain('Canonical Git worktrees remain readable')
  expect(result.worktrees.map(value => value.aliases)).toEqual([[], []])
})

it('exposes the same observation through public RPC, strict codec and discoverable actual CLI parser', async () => {
  const service = new AgentMuxRpcService({ git: owner })
  const result = await service.call('git.worktrees', target())
  expect(ready(result).worktrees).toHaveLength(2)
  expect(parseGitResult('git.worktrees', result, target())).toBe(result)
  const args = ['git', 'worktrees', '--workspace', workspace.id, '--host', workspace.hostId, '--workspace-path', repo]
  expect(await parseAgentMuxCliInvocation(args)).toMatchObject({ command: { method: 'git.worktrees' }, params: target() })
  expect(agentMuxCommandHelp('git.worktrees')).toContain('No Zone creation')
  expect(agentMuxModuleSkill('git')).toContain('Registration names are not current branches')
  const drive = ["C:","repo"].join('\\'), unc = ["","","server","share","worktree"].join('\\')
  const windowsTarget = { ...target(), expectedResource: { hostId: 'windows', workspacePath: drive } }
  expect(parseGitParams('git.worktrees', windowsTarget)).toEqual(windowsTarget)
  const windows = { ...ready(result), hostId: 'windows', workspacePath: drive, repoPath: drive,
    worktrees: [{ path: drive, branch: 'self', kind: 'main', detached: false, aliases: [] }, { path: unc, branch: null, kind: 'linked', detached: true, aliases: [] }] }
  expect(parseGitResult('git.worktrees', windows, windowsTarget)).toBe(windows)
  for (const bad of [{ ...target(), expectedResource: { hostId: 'local' } }, { ...target(), extra: true }])
    expect(() => parseGitParams('git.worktrees', bad)).toThrow()
  const snapshot = ready(result)
  for (const bad of [{ ...snapshot, hostId: 'foreign' }, { ...snapshot, workspacePath: lane }, { ...snapshot, worktrees: [] },
    { ...snapshot, worktrees: [...snapshot.worktrees, snapshot.worktrees[0]] },
    { ...snapshot, worktrees: [{ ...snapshot.worktrees[0], branch: null, detached: false }] }])
    expect(() => parseGitResult('git.worktrees', bad, target())).toThrow()
})

it('shares one Space read across exact Zone rows, refreshes native branch/detached and retains honest stale content without changing identity', async () => {
  const rootAlias = join(root, 'root-alias'), laneAlias = join(root, 'lane-alias')
  await symlink(repo, rootAlias); await symlink(lane, laneAlias); await mkdir(join(repo, 'nested'))
  workspace = { ...workspace, path: rootAlias, repoPath: rootAlias }
  const linked: WorkspaceRecord = { id: 'lane', hostId: 'local', path: laneAlias, repoPath: rootAlias, name: 'Saved lane alias', kind: 'worktree', branch: 'obsolete-lane' }
  config = { ...config, workspaces: [workspace, linked] }
  const spaceId = directoryIdentity('local', rootAlias), laneZone = workspaceZoneId(spaceId, linked.id), rootZone = workspaceZoneId(spaceId, workspace.id)
  useAppStore.setState({ config, activeWorkspaceId: workspace.id, mainSurface: 'workbench',
    layouts: { [workspace.id]: createWorkspaceLayout('root-group'), [linked.id]: createWorkspaceLayout('lane-group') }, tabs: {},
    spaceZoneBindings: { duplicate: { spaceId, workspaceId: linked.id }, nested: { spaceId, workspaceId: workspace.id, directoryPath: `${rootAlias}/nested` },
      foreign: { spaceId, workspaceId: linked.id, directoryPath: lane, resource: { kind: 'worktree', hostId: 'foreign', directoryPath: lane, branch: 'unconfirmed-registration' } },
      unknown: { spaceId, workspaceId: linked.id, directoryPath: lane, resource: { kind: 'unknown', hostId: 'local', directoryPath: lane, branch: null, issue: 'Unknown original resource' } },
      home: { spaceId, workspaceId: linked.id, directoryPath: lane, resource: { kind: 'home', hostId: 'local', directoryPath: lane, branch: null } } },
    workbenchSpaceSelection: null, spatialRequests: {}, topicCategories: [], projectGroups: [] })
  const read = vi.spyOn(api.git, 'worktrees').mockImplementation(input => owner.call('git.worktrees', input))
  await dom.render(<WorkspaceZonesPanel workspace={workspace} onManageWorktrees={() => {}} />)
  await act(async () => { await read.mock.results[0]!.value })
  const nativeSnapshot = ready(await read.mock.results[0]!.value)
  expect(nativeSnapshot.worktrees.find(value => value.path === repo)?.aliases).toEqual([rootAlias])
  expect(nativeSnapshot.worktrees.find(value => value.path === lane)?.aliases).toEqual([laneAlias])
  const row = (id: string) => [...dom.container.querySelectorAll<HTMLElement>('[data-zone-id]')].find(node => node.dataset.zoneId === id)!
  expect(row(laneZone).textContent).toContain('original-lane')
  expect(row(rootZone).textContent).toContain('main')
  expect(row(laneZone).textContent).not.toContain('obsolete-lane')
  expect(row('nested').querySelector('.workspace-zone-entry__name')?.textContent).toBe('nested')
  expect(row('nested').querySelector('.workspace-zone-entry__branch')).toBeNull()
  expect(row('nested').dataset.zoneKind).toBe('directory')
  expect(row('foreign').textContent).not.toContain('original-lane')
  expect(row('foreign').dataset.zoneGitState).toBe('unknown')
  expect(row('foreign').dataset.zoneKind).toBe('worktree')
  expect(row('unknown').dataset.zoneKind).toBe('unknown')
  expect(row('unknown').textContent).not.toContain('original-lane')
  expect(row('home').dataset.zoneKind).toBe('home')
  expect(read).toHaveBeenCalledTimes(1)
  const before = useAppStore.getState(), ids = [...dom.container.querySelectorAll<HTMLElement>('[data-zone-id]')].map(node => node.dataset.zoneId)
  const refresh = async () => { await dom.click('[aria-label="Refresh Zone Git metadata"]'); await act(async () => { await read.mock.results.at(-1)!.value }) }
  await host.run('git', ['-C', lane, 'switch', '-c', 'changed-lane'], runOptions); await refresh()
  expect(row(laneZone).textContent).toContain('changed-lane')
  await host.run('git', ['-C', lane, 'checkout', '--detach'], runOptions); await refresh()
  expect(row(laneZone).textContent).toContain('Detached HEAD')
  read.mockResolvedValueOnce({ kind: 'unavailable', hostId: 'local', workspacePath: rootAlias, checkedAt: Date.now(), reason: 'Controlled unavailable observation' })
  await refresh()
  expect(row(laneZone).textContent).toContain('Detached HEAD')
  expect(row(laneZone).textContent).toContain('Last observed')
  expect(row(laneZone).dataset.zoneGitState).toBe('stale')
  expect(dom.container.querySelector('[role="status"]')?.textContent).toContain('Controlled unavailable observation')
  expect(row(laneZone).hasAttribute('disabled')).toBe(false)
  expect([...dom.container.querySelectorAll<HTMLElement>('[data-zone-id]')].map(node => node.dataset.zoneId)).toEqual(ids)
  expect(useAppStore.getState().config).toBe(before.config)
  expect(useAppStore.getState().tabs).toBe(before.tabs)
  expect(useAppStore.getState().layouts).toBe(before.layouts)
  expect(useAppStore.getState().sessions).toBe(before.sessions)
})

it('discards a delayed old target after path rebind and keeps healthy non-Git Folder navigation available', async () => {
  workspace = { ...workspace, repoPath: repo }
  useAppStore.setState({ config: { ...config, workspaces: [workspace] }, activeWorkspaceId: workspace.id,
    mainSurface: 'workbench', layouts: { [workspace.id]: createWorkspaceLayout('root-group') }, tabs: {},
    spaceZoneBindings: {}, workbenchSpaceSelection: null, spatialRequests: {}, topicCategories: [], projectGroups: [] })
  const read = vi.spyOn(api.git, 'worktrees').mockImplementation(input => owner.call('git.worktrees', input))
  await dom.render(<WorkspaceZonesPanel workspace={workspace} onManageWorktrees={() => {}} />)
  const old = await read.mock.results[0]!.value
  await act(async () => { await read.mock.results[0]!.value })
  let finish!: (value: GitWorktreesResult) => void
  read.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  await dom.click('[aria-label="Refresh Zone Git metadata"]')
  const plain = join(root, 'plain'); await mkdir(plain)
  const rebound = { ...workspace, path: plain, repoPath: plain, kind: 'worktree' as const, branch: 'stale-registration' }
  const nonGit = { kind: 'not-a-git-repository' as const, hostId: rebound.hostId, workspacePath: plain, checkedAt: Date.now() }
  read.mockResolvedValueOnce(nonGit)
  await act(async () => useAppStore.setState({ config: { ...config, workspaces: [rebound] } }))
  await dom.render(<WorkspaceZonesPanel workspace={rebound} onManageWorktrees={() => {}} />)
  await act(async () => finish(old))
  const rows = [...dom.container.querySelectorAll<HTMLButtonElement>('[data-zone-id]')]
  expect(rows).toHaveLength(1)
  expect(rows[0]!.dataset.zoneKind).toBe('directory')
  expect(rows[0]!.dataset.zoneGitState).toBe('current')
  expect(rows[0]!.textContent).not.toContain('Git unknown')
  expect(rows[0]!.querySelector('.workspace-zone-entry__branch')).toBeNull()
  expect(rows[0]!.disabled).toBe(false)
  expect(read.mock.calls.at(-1)?.[0]).toEqual({ workspaceId: rebound.id, expectedResource: { hostId: rebound.hostId, workspacePath: plain } })
})
