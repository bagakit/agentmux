import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile, readlink, realpath, stat, writeFile, mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentMuxSpatialStateStore, LocalExecutionHost, type AgentMuxClientEvent } from '@agentmux/core'
import { agentPromptCondition } from '@agentmux/core/prompt-condition'
import { createWorkspaceLayout } from '@agentmux/layout'
import { headlessFixture, until } from '../../../packages/core/test/helpers/headless-runtime-fixture'
import { ConfigOwner } from '../src/main/config-owner'
import { WorktreeService } from '../src/main/worktree-service'
import { WorktreeCloseoutOwner } from '../src/main/worktree-closeout'
import { worktreeExecutionReferences } from '../src/main/worktree-execution-references'
import { desktopSpatialGraph, desktopWorkbenchFromSpatial } from '../src/renderer/src/lib/desktop-spatial-state'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import type { AppConfig, WorkspaceRecord } from '../src/shared/contracts'

const execute = promisify(execFile)
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
let scope: Awaited<ReturnType<typeof headlessFixture>> | undefined
let client: Awaited<ReturnType<NonNullable<typeof scope>['client']>> | undefined
const pids = new Set<number>()
const receiptPath = process.env.AGENTMUX_WORKTREE_CLOSEOUT_NATIVE_RECEIPT

afterEach(async () => {
  const root = scope?.root
  try {
    if (client) {
      for (const session of await client.readAgentSessions()) await client.stopAgent(session.agentSessionId, session.run)
      for (const run of await client.listRuns()) if (run.kind === 'terminal') await client.stopTerminal({ runId: run.runId })
    }
  } finally { await scope?.cleanup() }
  const remaining = [...pids].filter(pid => { try { process.kill(pid, 0); return true } catch { return false } })
  expect(remaining).toEqual([])
  if (root) await expect(stat(root)).rejects.toMatchObject({ code: 'ENOENT' })
  if (receiptPath) await writeFile(receiptPath.replace(/\.json$/u, '-cleanup.json'), JSON.stringify({
    privatePids: [...pids], remaining, privateRootRemoved: true, sharedRuntimeControls: 0
  }, null, 2) + '\n')
  vi.restoreAllMocks()
})

it('moves only the workface while real Core retains the original Agent and Terminal cwd and reconnects their exact Native processes', async () => {
  // Existing protocol fixture; production Core owner, RPC, Session store and official
  // ctxmux daemon/PTY. Neither a vendor model nor a user Runtime is started/stopped.
  scope = await headlessFixture()
  pids.add(scope.owner.processId)
  const root = await realpath(scope.root), repo = join(root, 'repo'), lane = join(root, 'lane')
  await mkdir(repo)
  const git = async (...args: string[]) => (await execute('git', ['-C', repo, ...args])).stdout
  await git('init', '-b', 'main')
  await git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-m', 'Initialize fixture')
  await git('worktree', 'add', '-b', 'feature', lane)
  client = await scope.client()
  const originalClient = client
  const events: AgentMuxClientEvent[] = []
  client.onEvent(event => events.push(event))
  const fakeCli = resolve('packages/core/test/fixtures/fake-codex-cli.mjs')
  const agent = await client.createAgent({ providerId: 'codex', executorId: 'private-codex',
    agentSessionId: 'private-closeout-agent', createOperationId: 'private-closeout-create-agent', workspacePath: lane,
    commandOverride: fakeCli, args: [], injectAgentMuxGuide: false,
    env: { AGENTMUX_FAKE_READY_MODE: 'before', AGENTMUX_FAKE_NATIVE_RECORD: '1' } })
  await client.reattachAgent(agent.agentSessionId, 0, 'terminal')
  await until(() => client!.agentSession(agent.agentSessionId), value => Boolean(value.nativeHandle) && value.semanticStatus?.state === 'done', 'original private Agent identity')
  const terminal = await client.createTerminal({ createOperationId: 'private-closeout-create-terminal', workspacePath: lane,
    command: process.execPath, args: ['-e', 'process.stdin.setRawMode(true);process.stdout.write("private-terminal-ready");process.stdin.on("data",b=>process.stdout.write(b));setInterval(()=>{},1000)'] })
  await client.attachTerminal(terminal.runId, 0, 'raw')
  const beforeAgent = await client.statusAgent(agent.agentSessionId)
  const beforeTerminal = await until(() => client!.listRuns(), runs => runs.some(run => run.runId === terminal.runId && run.latestOutputBytes > 0), 'original private terminal ready')
  const terminalRun = beforeTerminal.find(run => run.runId === terminal.runId)!
  for (const pid of [beforeAgent.run.pid, terminalRun.pid]) { expect(pid).toBeGreaterThan(1); pids.add(pid!) }
  const cwd = async (pid: number) => process.platform === 'linux' ? await readlink(join('/proc', String(pid), 'cwd'))
    : (await execute('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'])).stdout.split('\n').find(line => line.startsWith('n'))!.slice(1)
  expect(await cwd(beforeAgent.run.pid!)).toBe(lane)
  expect(await cwd(terminalRun.pid!)).toBe(lane)
  const target: WorkspaceRecord = { id: 'default', hostId: 'local', name: 'Project', path: repo, kind: 'folder' }
  const source: WorkspaceRecord = { id: 'lane', hostId: 'local', name: 'Feature', path: lane, repoPath: repo, branch: 'feature', kind: 'worktree' }
  let config = { version: 9, hosts: [{ id: 'local', kind: 'local', label: 'Local' }], executors: {}, workspaces: [target, source],
    appearance: { terminalTheme: 'graphite' }, browser: { toolbar: {} } } as AppConfig
  const configOwner = new ConfigOwner({ read: () => config, save: async next => next, publish: saved => { config = saved } })
  const agentTab = createWorkbenchTab('agent-tab', { regionId: 'agent-region', kind: 'agent', workspaceId: source.id, phase: 'attached', sessionId: agent.agentSessionId })
  const terminalTab = createWorkbenchTab('terminal-tab', { regionId: 'terminal-region', kind: 'terminal', workspaceId: source.id, phase: 'attached', sessionId: terminal.runId })
  const spatial = new AgentMuxSpatialStateStore(join(root, 'spatial.json'))
  await spatial.commit({ expectedRevision: 0, graph: desktopSpatialGraph({ config, sessions: [],
    tabs: { [agentTab.id]: agentTab, [terminalTab.id]: terminalTab }, layouts: { [source.id]: createWorkspaceLayout('original-group', [agentTab.id, terminalTab.id]) }, spaceZoneBindings: {}, spatialRequests: {} }, []) })
  const authoritativeReads = vi.spyOn(client, 'readAgentSessions')
  const projectionReads = vi.spyOn(client, 'runtimeProjection')
  const referencesBefore = await worktreeExecutionReferences(source, client)
  expect(referencesBefore).toEqual(expect.arrayContaining([agent.agentSessionId, terminal.runId]))
  const worktrees = new WorktreeService(() => new LocalExecutionHost(), { save: (next, expected) => configOwner.edit(expected, next) })
  const removal = vi.spyOn(worktrees, 'removeWorktree')
  const owner = new WorktreeCloseoutOwner({ config: configOwner, spatial, worktrees,
    prepare: async () => {}, executionReferences: workspace => worktreeExecutionReferences(workspace, originalClient) })
  const params = { workspaceId: source.id, expectedResource: { hostId: source.hostId, workspacePath: lane }, operationId: 'private-closeout-original' }
  const closeout = await owner.publicClose(params)
  expect(closeout).toMatchObject({ workface: 'moved', cleanup: 'pending', movedTabIds: ['agent-tab', 'terminal-tab'] })
  expect(authoritativeReads).toHaveBeenCalledTimes(2)
  expect(projectionReads).toHaveBeenCalledTimes(2)
  expect(removal).not.toHaveBeenCalled()
  expect(await git('worktree', 'list', '--porcelain')).toContain(lane)
  expect(await stat(lane)).toBeDefined()
  const durable = await new AgentMuxSpatialStateStore(spatial.path).read()
  expect(durable!.graph.tabs.map(tab => tab.workspaceId)).toEqual([target.id, target.id])
  expect(desktopWorkbenchFromSpatial(durable!.graph).tabs[agentTab.id]!.regions['agent-region']).toMatchObject({ sessionId: agent.agentSessionId, workspaceId: source.id })
  await client.dispose()
  client = await scope.client()
  client.onEvent(event => events.push(event))
  const reconnectedAgent = await client.statusAgent(agent.agentSessionId)
  expect(reconnectedAgent.session).toMatchObject({ agentSessionId: agent.agentSessionId, workspacePath: lane, run: agent.run })
  expect(reconnectedAgent.run).toMatchObject({ runId: agent.run.runId, pid: beforeAgent.run.pid, state: 'running' })
  await client.reattachAgent(agent.agentSessionId, 0, 'terminal')
  await client.attachTerminal(terminal.runId, 0, 'raw')
  const prompt = 'private-closeout-same-agent-input'
  await client.submitAgentPrompt({ ...agentPromptCondition(client.agentSession(agent.agentSessionId)), agentSessionId: agent.agentSessionId,
    operationId: 'private-closeout-input-after-reconnect', prompt })
  await until(() => events.filter(event => event.type === 'terminal-output').map(event => event.data).join(''), text => text.includes(`codex-submit:${prompt}:accepted`), 'original Agent actual input accepted after workface closeout and reconnect')
  const currentTerminal = (await client.listRuns()).find(run => run.runId === terminal.runId)!
  await client.writeTerminal({ runId: terminal.runId }, { ownerInstanceId: client.runtimeIdentity().instanceId,
    expectedByte: currentTerminal.acceptedInputBytes!, operationId: 'private-closeout-terminal-input', data: 'private-closeout-terminal-input' })
  await until(() => events.filter(event => event.type === 'terminal-output').map(event => event.data).join(''), text => text.includes('private-closeout-terminal-input'), 'same private Terminal input after reconnect')
  const afterAgent = await client.statusAgent(agent.agentSessionId)
  const afterTerminal = (await client.listRuns()).find(run => run.runId === terminal.runId)!
  expect(afterAgent.run).toMatchObject({ runId: beforeAgent.run.runId, pid: beforeAgent.run.pid, state: 'running' })
  expect(afterTerminal).toMatchObject({ runId: terminalRun.runId, pid: terminalRun.pid, state: 'running' })
  expect(afterAgent.run.acceptedInputBytes!).toBeGreaterThan(beforeAgent.run.acceptedInputBytes!)
  expect(afterTerminal.acceptedInputBytes!).toBeGreaterThan(terminalRun.acceptedInputBytes!)
  expect(await cwd(beforeAgent.run.pid!)).toBe(lane)
  expect(await cwd(terminalRun.pid!)).toBe(lane)
  expect(await spatial.read()).toEqual(durable)
  if (receiptPath) {
    const sourceFiles = ['apps/desktop/src/main/worktree-closeout.ts', 'apps/desktop/src/main/worktree-execution-references.ts',
      'apps/desktop/test/worktree-closeout-native.integration.test.ts', 'packages/core/test/fixtures/fake-codex-cli.mjs']
    await writeFile(receiptPath, JSON.stringify({ schema: 'agentmux.worktree-closeout-native.v1', passed: true,
      source: await Promise.all(sourceFiles.map(async path => ({ path, sha256: sha(await readFile(path)) }))),
      owner: scope.owner, closeout, referencesBefore, authoritativeReadCalls: authoritativeReads.mock.calls.length,
      projectionReadCalls: projectionReads.mock.calls.length, gitRemovalCalls: removal.mock.calls.length,
      agent: { sid: agent.agentSessionId, before: beforeAgent.run, after: afterAgent.run, cwd: lane, prompt },
      terminal: { before: terminalRun, after: afterTerminal, cwd: lane },
      spatialSHA256: sha(await readFile(spatial.path)), reconnected: true,
      boundaries: { fixtureProvider: true, officialCtxmux: true, originalProcesses: true, presentationOnly: true,
        vendorModel: false, electronRestart: false, ownerRestart: false, sharedRuntimeControls: 0 }
    }, null, 2) + '\n')
  }
}, 120_000)
