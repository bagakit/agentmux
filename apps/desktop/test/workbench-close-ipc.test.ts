// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { URL as NodeURL } from 'node:url'
import ts from 'typescript'
import { afterEach, expect, it, vi } from 'vitest'
import { createWorkspaceLayout } from '@agentmux/layout'
import { AgentMuxError, SPACE_CLOSE_METHODS, parseSpaceCloseParams, parseSpaceCloseResult, spaceCloseDecisions } from '@agentmux/core'
import type { AgentMuxPreloadApi } from '../src/shared/contracts'
import { ipcResult } from '../src/shared/ipc-result'
import { WorkbenchCloseOwner } from '../src/main/workbench-close-owner'

const wire = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: (_name: string, api: AgentMuxPreloadApi) => Object.assign(window, { agentmux: api }) },
  ipcRenderer: { invoke: wire.invoke, on: vi.fn(), off: vi.fn(), send: vi.fn(), removeListener: vi.fn() },
  webFrame: { getZoomFactor: () => 1 }
}))
import '../src/preload/index'
import { api } from '../src/renderer/src/lib/api'
import { captureWorkbenchClose } from '../src/renderer/src/lib/workbench-close-owner'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'

const roots: string[] = []
afterEach(async () => { wire.invoke.mockReset(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

/** Consume the actual Main registration, rather than recreating its envelope in a mock. */
function handler(owner: WorkbenchCloseOwner, assertCurrent: () => void) {
  const source = ts.createSourceFile('ipc.ts', readFileSync(new NodeURL('../src/main/ipc.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true)
  const handlers: string[] = []
  function visit(node: ts.Node) {
    if (ts.isCallExpression(node) && node.expression.getText(source) === 'handleWithEvent' &&
        node.arguments[0] && ts.isStringLiteral(node.arguments[0]) && node.arguments[0].text === 'workbenchClose:call') handlers.push(node.arguments[1]!.getText(source))
    ts.forEachChild(node, visit)
  }
  visit(source); expect(handlers).toHaveLength(1)
  const compiled = ts.transpileModule(`(${handlers[0]})`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
  return new Function('ipcResult', 'SPACE_CLOSE_METHODS', 'AgentMuxError', 'parseSpaceCloseParams', 'workbenchClose', 'assertAppDocumentSender', 'contents', 'args',
    `return ${compiled}`)(ipcResult, SPACE_CLOSE_METHODS, AgentMuxError, parseSpaceCloseParams, owner, assertCurrent, {}, { appDocumentSources: () => [] }) as
      (event: object, method: string, input: unknown) => Promise<unknown>
}

it.each(['launcher', 'unconfirmed-agent'] as const)('consumes %s close through Main, actual preload and production Renderer API', async kind => {
  const root = await mkdtemp(join(tmpdir(), 'close-ipc-')); roots.push(root)
  const surface = kind === 'launcher' ? { kind: 'launcher' as const, regionId: 'R', workspaceId: 'W' }
    : { kind: 'agent' as const, phase: 'launching' as const, regionId: 'R', workspaceId: 'W', sessionId: 'original-unconfirmed-session' }
  const tab = createWorkbenchTab('T', surface)
  const state = { tabs: { T: tab }, layouts: { W: createWorkspaceLayout('G', ['T']) }, sessions: [], documents: {}, dirtyDocuments: {},
    documentGenerations: {}, documentObservationGenerations: {}, savingDocuments: {}, closingWorkbenchViews: {}, config: null }
  const save = { layoutApplied: true, clientStateWritten: true, storageFlushRequested: true, diskDurability: 'confirmed' as const, reason: null }
  const commit = vi.fn(async () => ({ clientProjection: { applied: true, removedRegions: ['R'], retainedRegions: [], save }, spatialContribution: { save } }))
  const effect = vi.fn(async () => { throw new Error('This exact view has no authorized resource effect') })
  const owner = new WorkbenchCloseOwner({ path: join(root, 'user.json') }, {
    authority: () => ({ ownerId: 'private-owner', endpoint: 'unix:/private-close', documentGeneration: 'original-document' }),
    capture: async input => captureWorkbenchClose(state, input),
    prepareTerminal: async () => { throw new Error('No terminal in this plan') }, reserve: async () => {}, validate: async () => {},
    effect, inspect: async () => null, commit, release: async () => {}
  })
  const assertCurrent = vi.fn(), execute = handler(owner, assertCurrent)
  wire.invoke.mockImplementation(async (channel, method, input) => {
    expect(channel).toBe('workbenchClose:call')
    return structuredClone(await execute({}, method, structuredClone(input)))
  })
  const request = { operationId: `original-${kind}`, target: { kind: 'tab-occurrence' as const, displayWorkspaceId: 'W', groupId: 'G', tabId: 'T' }, keepAgentSessions: false }
  // This is the same public codec consumed by Store.prepareWorkbenchClose.
  const prepared = parseSpaceCloseResult('space.close.prepare', await api.workbenchClose.call('space.close.prepare', request), request).operation!
  expect(prepared).toMatchObject({ operationId: request.operationId, outcome: 'prepared', diskDurability: 'confirmed', approvedBy: null })
  expect(prepared.plan.projection.surfaces[0]).toMatchObject({ owner: { regionId: 'R', kind: kind === 'launcher' ? 'launcher' : 'agent' }, binding: null })
  expect(commit).not.toHaveBeenCalled(); expect(effect).not.toHaveBeenCalled()
  const apply = { operationId: prepared.operationId, expectedPlanDigest: prepared.planDigest, decisions: spaceCloseDecisions(prepared.plan) }
  if (kind === 'unconfirmed-agent') expect(apply.decisions).toEqual([{ action: 'close-view-only', regionId: 'R', expectedWitness: prepared.plan.projection.surfaces[0]!.witness }])
  const applied = parseSpaceCloseResult('space.close.apply', await api.workbenchClose.call('space.close.apply', apply), apply).operation!
  expect(applied).toMatchObject({ operationId: request.operationId, outcome: 'applied', clientProjection: { removedRegions: ['R'] } })
  expect(commit).toHaveBeenCalledTimes(1); expect(effect).not.toHaveBeenCalled()
  const inspect = { operationId: request.operationId }
  expect(parseSpaceCloseResult('space.close.inspect', await api.workbenchClose.call('space.close.inspect', inspect), inspect).operation).toEqual(applied)
  expect(commit).toHaveBeenCalledTimes(1)
  assertCurrent.mockImplementation(() => { throw Object.assign(new Error('Original document changed'), { code: 'CONTROL_DOCUMENT_CHANGED', detail: 'Keep original view' }) })
  await expect(api.workbenchClose.call('space.close.prepare', { ...request, operationId: 'refused-document' })).rejects.toMatchObject({
    code: 'CONTROL_DOCUMENT_CHANGED', message: 'Original document changed', detail: 'Keep original view'
  })
  expect(commit).toHaveBeenCalledTimes(1); expect(effect).not.toHaveBeenCalled()
})
