// @vitest-environment happy-dom
import { expect, it, vi } from 'vitest'
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

it('opens a clicked semantic reference in its Agent Workspace while another Workspace is current', async () => {
  const path = 'src/card.ts'
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
  const read = vi.spyOn(api.files, 'read').mockImplementation(async (_workspaceId, readPath) => ({
    status: 'read', document: { path: readPath, content: 'export const card = true\n', revision: 'r1' }
  }))

  await dom.render(<AgentSessionComposer sessionId="agent-1" />)
  const tokens = dom.container.querySelectorAll<HTMLButtonElement>('button[data-tool-reference="component"]')
  expect(tokens).toHaveLength(1)
  expect(tokens[0]?.title).toBe(`Open reference: @${path}`)
  await dom.click('button[data-tool-reference="component"]')
  await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1))
  expect(read.mock.calls).toEqual([['workspace', path]])
  await vi.waitFor(() => expect(useAppStore.getState().documents[documentKey('workspace', path)])
    .toEqual({ path, content: 'export const card = true\n', revision: 'r1' }))

  const state = useAppStore.getState(), tabId = fileTabId('workspace', path)
  expect(state.layouts.workspace?.groups.find((group) => group.id === 'target-group')?.activeTabId).toBe(tabId)
  expect(state.tabs[tabId]?.workspaceId).toBe('workspace')
  expect(Object.values(state.tabs[tabId]!.regions)).toEqual([expect.objectContaining({ kind: 'file', workspaceId: 'workspace', path })])
  expect(api.files.observe).toHaveBeenCalledTimes(1)
  expect(api.files.observe).toHaveBeenCalledWith('workspace', path)
  expect(state.layouts.other).toBe(currentLayout)
  expect(state.activeWorkspaceId).toBe('other')
  expect(state.mainSurface).toBe('agents')
  expect(state.sessions[0]).toBe(sessionBefore)
  expect(dom.draft()).toBe(draft)
  expect(state.error).toBeNull()
})
