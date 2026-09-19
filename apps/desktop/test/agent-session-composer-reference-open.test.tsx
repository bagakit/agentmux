// @vitest-environment happy-dom
import { expect, it, vi } from 'vitest'
import { act } from 'react'
import { createWorkspaceLayout } from '@agentmux/layout'
import { AgentSessionComposer } from '../src/renderer/src/components/AgentSessionComposer'
import { api } from '../src/renderer/src/lib/api'
import { encodeSemanticReference } from '../src/renderer/src/lib/composer-semantic-reference'
import { documentKey, fileTabId } from '../src/renderer/src/lib/workbench-tabs'
import { useAppStore } from '../src/renderer/src/store'
import { composerConfig, composerDOM } from './helpers/composer-dom-fixture'

// Store, AgentSessionComposer, AgentComposer, Tiptap token and placement reducer are real.
// Only the typed desktop filesystem boundary supplies controlled document bytes.
const dom = composerDOM()

function prepareReference(path: string) {
  const draft = `Review ${encodeSemanticReference({ token: '', label: 'Card', kind: 'component', reference: `@${path}` })}`
  const targetLayout = createWorkspaceLayout('target-group')
  const currentLayout = createWorkspaceLayout('other-group')
  useAppStore.setState({
    config: { ...composerConfig, workspaces: [...composerConfig.workspaces,
      { id: 'other', name: 'Other', path: '/other', hostId: 'local', kind: 'folder' }] },
    activeWorkspaceId: 'other', mainSurface: 'agents',
    layouts: { workspace: targetLayout, other: currentLayout }, tabs: {}, documents: {},
    agentComposerDrafts: { 'agent-1': draft }, lastActiveFileByWorkspace: {}, error: null
  })
  const sessionBefore = useAppStore.getState().sessions[0]
  expect(sessionBefore).toMatchObject({ id: 'agent-1', workspacePath: '/repo', processState: 'running' })
  vi.spyOn(api.files, 'observe').mockResolvedValue()
  vi.spyOn(api.files, 'unobserve').mockResolvedValue()
  return { draft, currentLayout, sessionBefore }
}

async function clickReference(path: string) {
  await dom.render(<AgentSessionComposer sessionId="agent-1" />)
  const tokens = dom.container.querySelectorAll<HTMLButtonElement>('button[data-tool-reference="component"]')
  expect(tokens).toHaveLength(1)
  expect(tokens[0]?.title).toBe(`Open reference: @${path}`)
  await dom.click('button[data-tool-reference="component"]')
}

function expectFilePlaced(path: string) {
  const state = useAppStore.getState(), tabId = fileTabId('workspace', path)
  expect(state.documents[documentKey('workspace', path)])
    .toEqual({ path, content: 'export const card = true\n', revision: 'r1' })
  expect(state.tabs[tabId]?.workspaceId).toBe('workspace')
  expect(Object.values(state.tabs[tabId]!.regions)).toEqual([expect.objectContaining({ kind: 'file', workspaceId: 'workspace', path })])
  return { state, tabId }
}

it('reveals a clicked reference in its Agent Workspace while another Workspace is current', async () => {
  const path = 'src/card.ts'
  const { draft, currentLayout, sessionBefore } = prepareReference(path)
  const read = vi.spyOn(api.files, 'read').mockImplementation(async (_workspaceId, readPath) => ({
    status: 'read', document: { path: readPath, content: 'export const card = true\n', revision: 'r1' }
  }))

  await clickReference(path)
  await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1))
  expect(read.mock.calls).toEqual([['workspace', path]])
  await vi.waitFor(() => expect(useAppStore.getState().documents[documentKey('workspace', path)])
    .toEqual({ path, content: 'export const card = true\n', revision: 'r1' }))

  const { state, tabId } = expectFilePlaced(path)
  expect(state.layouts.workspace?.groups.find((group) => group.id === 'target-group')?.activeTabId).toBe(tabId)
  expect(api.files.observe).toHaveBeenCalledTimes(1)
  expect(api.files.observe).toHaveBeenCalledWith('workspace', path)
  expect(state.layouts.other).toBe(currentLayout)
  expect(state.activeWorkspaceId).toBe('workspace')
  expect(state.mainSurface).toBe('workbench')
  expect(state.sessions[0]).toBe(sessionBefore)
  expect(dom.draft()).toBe(draft)
  expect(state.error).toBeNull()
})

it('reveals a cached reference without another filesystem read', async () => {
  const path = 'src/cached.ts'
  const { draft, sessionBefore } = prepareReference(path)
  useAppStore.setState({ documents: { [documentKey('workspace', path)]: {
    path, content: 'export const card = true\n', revision: 'r1'
  } } })
  const read = vi.spyOn(api.files, 'read')
  await clickReference(path)
  const { state, tabId } = expectFilePlaced(path)
  expect(state.layouts.workspace?.groups.find((group) => group.id === 'target-group')?.activeTabId).toBe(tabId)
  expect(state.activeWorkspaceId).toBe('workspace')
  expect(state.mainSurface).toBe('workbench')
  expect(read).not.toHaveBeenCalled()
  expect(api.files.observe).not.toHaveBeenCalled()
  expect(state.sessions[0]).toBe(sessionBefore)
  expect(dom.draft()).toBe(draft)
})

it.each(['Goals', 'another Workspace'] as const)('keeps later %s navigation while a clicked reference is pending', async (destination) => {
  const path = `src/pending-${destination}.ts`
  const { draft, sessionBefore } = prepareReference(path)
  let complete!: (value: Awaited<ReturnType<typeof api.files.read>>) => void
  const read = vi.spyOn(api.files, 'read').mockReturnValue(new Promise((resolve) => { complete = resolve }))
  await clickReference(path)
  await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1))
  expect(read.mock.calls).toEqual([['workspace', path]])
  expect(useAppStore.getState().activeWorkspaceId).toBe('workspace')
  expect(useAppStore.getState().mainSurface).toBe('workbench')
  await act(async () => {
    if (destination === 'Goals') useAppStore.getState().setMainSurface('board')
    else await useAppStore.getState().selectWorkspace('other')
  })
  const selected = useAppStore.getState()
  await act(async () => complete({ status: 'read', document: { path, content: 'export const card = true\n', revision: 'r1' } }))
  await vi.waitFor(() => expectFilePlaced(path))
  const state = useAppStore.getState()
  expect(state.activeWorkspaceId).toBe(selected.activeWorkspaceId)
  expect(state.mainSurface).toBe(destination === 'Goals' ? 'board' : 'workbench')
  expect(state.layouts.workspace?.groups.find((group) => group.id === 'target-group')?.activeTabId).toBeNull()
  expect(state.sessions[0]).toBe(sessionBefore)
  expect(dom.draft()).toBe(draft)
  expect(state.error).toBeNull()
})

it('keeps the original error, draft and healthy Session when a reference read fails', async () => {
  const path = 'src/missing.ts'
  const { draft, sessionBefore } = prepareReference(path)
  const read = vi.spyOn(api.files, 'read').mockRejectedValue(new Error('Reference read failed'))
  await clickReference(path)
  await vi.waitFor(() => expect(useAppStore.getState().error).toContain('Reference read failed'))
  const state = useAppStore.getState()
  expect(read.mock.calls).toEqual([['workspace', path]])
  expect(state.activeWorkspaceId).toBe('workspace')
  expect(state.mainSurface).toBe('workbench')
  expect(state.documents[documentKey('workspace', path)]).toBeUndefined()
  expect(state.tabs[fileTabId('workspace', path)]).toBeUndefined()
  expect(state.sessions[0]).toBe(sessionBefore)
  expect(dom.draft()).toBe(draft)
})
