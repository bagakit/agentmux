// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createWorkspaceLayout } from '@agentmux/layout'
import { GoalEvidence } from '../src/renderer/src/components/GoalEvidence'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { documentKey } from '../src/renderer/src/lib/workbench-tabs'
import type { AppConfig } from '../src/shared/contracts'
import { goalEvidenceSource } from './helpers/goal-evidence-source'

const initial = useAppStore.getState()
let source: Awaited<ReturnType<typeof goalEvidenceSource>>, root: Root, element: HTMLDivElement
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  source = await goalEvidenceSource(); element = document.createElement('div'); document.body.append(element); root = createRoot(element)
  const config = { ...initial.config, workspaces: source.workspaces, hosts: [], executors: {}, appearance: {} } as AppConfig
  useAppStore.setState({ ...initial, config, activeWorkspaceId: 'main', tabs: {}, documents: {}, documentIssues: {}, dirtyDocuments: {},
    layouts: Object.fromEntries(source.workspaces.map(workspace => [workspace.id, createWorkspaceLayout(workspace.id)])) })
  vi.spyOn(api.files, 'readPublic').mockImplementation(params => source.owner.read(params))
  vi.spyOn(api.files, 'read').mockImplementation((id, path) => source.files.read(source.workspaces.find(workspace => workspace.id === id)!, path))
  vi.spyOn(api.files, 'observe').mockResolvedValue(undefined); vi.spyOn(api.files, 'unobserve').mockResolvedValue(undefined)
  vi.spyOn(api.ui, 'writeClipboardText').mockResolvedValue(undefined)
})
afterEach(async () => { await act(async () => root.unmount()); element.remove(); useAppStore.setState(initial); vi.restoreAllMocks(); await source.dispose() })
async function mount(evidence = [source.evidence]) { await act(async () => root.render(<GoalEvidence evidence={evidence} criterion="Original result" />)) }
async function click(label: string) {
  const button = [...element.querySelectorAll('button')].find(value => value.textContent === label || value.getAttribute('aria-label') === label)
  expect(button).toBeDefined(); await act(async () => { button!.click() })
  await vi.waitFor(async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)) }); expect(element.querySelector('button:disabled')).toBeNull() })
}
it('opens the exact worktree through Files and the real editor store while another same-name file is active', async () => {
  await mount(); await click('result.log:2')
  expect(api.files.readPublic).toHaveBeenCalledExactlyOnceWith(source.target)
  expect(api.files.read).toHaveBeenCalledExactlyOnceWith('worktree', 'result.log')
  expect(useAppStore.getState().documents[documentKey('worktree', 'result.log')]?.content).toBe('ORIGINAL worktree evidence')
  expect(useAppStore.getState().documents[documentKey('main', 'result.log')]).toBeUndefined()
  expect(useAppStore.getState().documentRevealTargets[documentKey('worktree', 'result.log')]).toEqual({ line: 2 })
  await click('Copy evidence location result.log:2')
  expect(api.ui.writeClipboardText).toHaveBeenCalledWith(JSON.stringify(source.evidence))
})
it('keeps author text copyable without guessing its missing file source', async () => {
  const original = 'result.log:2'
  await act(async () => root.render(<GoalEvidence evidence={[original]} criterion="Original result" />))
  expect(element.textContent).toContain('File source not recorded')
  expect(element.querySelector('.goals-evidence__open')).toBeNull()
  await click('Copy evidence location result.log:2')
  expect(api.ui.writeClipboardText).toHaveBeenCalledWith(original)
  expect(api.files.readPublic).not.toHaveBeenCalled(); expect(api.files.read).not.toHaveBeenCalled()
})
it('shows a changed revision before opening current bytes', async () => {
  await writeFile(join(source.workspaces[1]!.path, 'result.log'), 'Changed after report')
  await mount(); await click('result.log:2')
  expect(element.textContent).toContain('changed since the report'); expect(api.files.read).not.toHaveBeenCalled()
  await click('View current file')
  expect(useAppStore.getState().documents[documentKey('worktree', 'result.log')]?.content).toBe('Changed after report')
  expect(element.textContent).toContain('differs from the reported revision')
})
it('detects changed editor bytes even when the initial evidence read matched the reported revision', async () => {
  const read = source.owner.read.bind(source.owner)
  vi.mocked(api.files.readPublic).mockImplementation(async params => { const result = await read(params); await writeFile(join(source.workspaces[1]!.path, 'result.log'), 'Changed during opening'); return result })
  await mount(); await click('result.log:2')
  expect(useAppStore.getState().documents[documentKey('worktree', 'result.log')]?.content).toBe('Changed during opening')
  expect(element.textContent).toContain('differs from the reported revision')
})
it('does not open a reused Workspace ID belonging to another Host', async () => {
  source.workspaces[1]!.hostId = 'another-host'
  await mount(); await click('result.log:2')
  expect(element.textContent).toContain('resource changed')
  expect(api.files.read).not.toHaveBeenCalled()
  expect(useAppStore.getState().activeWorkspaceId).toBe('main')
})

it('does not select a rebound Workspace when its mapping changes after the evidence read', async () => {
  const selectWorkspace = vi.fn(async () => undefined), read = source.owner.read.bind(source.owner)
  useAppStore.setState({ selectWorkspace, layouts: { main: createWorkspaceLayout('main') } })
  vi.mocked(api.files.readPublic).mockImplementation(async params => {
    const result = await read(params), config = useAppStore.getState().config!
    useAppStore.setState({ config: { ...config, workspaces: config.workspaces.map(workspace => workspace.id === 'worktree' ? { ...workspace, hostId: 'another-host' } : workspace) } })
    return result
  })
  await mount(); await click('result.log:2')
  expect(element.textContent).toContain('original Host or Workspace is unavailable or changed')
  expect(selectWorkspace).not.toHaveBeenCalled(); expect(api.files.read).not.toHaveBeenCalled()
  expect(useAppStore.getState().activeWorkspaceId).toBe('main')
})
