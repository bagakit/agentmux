// @vitest-environment happy-dom
import { act } from 'react'
import type { Editor } from '@tiptap/core'
import { beforeEach, expect, it, vi } from 'vitest'
import { fixturePath } from '../../../test/fixture-values.mjs'
import { fileUploadRevision } from '@agentmux/core/files'
import { expandSemanticReferences } from '@agentmux/client-ui/composer-semantic-reference'
import { AgentSessionComposer } from '../src/renderer/src/components/AgentSessionComposer'
import { NewTabSurface } from '../src/renderer/src/components/NewTabSurface'
import { useAppStore } from '../src/renderer/src/store'
import { useLauncherState } from '../src/renderer/src/lib/launcher-state'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { api } from '../src/renderer/src/lib/api'
import { sessionResourceContext } from '../src/renderer/src/lib/session-resource-context'
import { composerDOM, composerConfig, composerSession } from './helpers/composer-dom-fixture'

vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: () => null }))
const dom = composerDOM()
const resourcePath = fixturePath('resource-project'), runtimePath = fixturePath('agent-runtime')
const editor = () => dom.container.querySelector<HTMLElement & { editor: Editor }>('[role="textbox"]')!.editor
async function text(value: string) {
  await act(async () => { editor().commands.setContent({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: value }] }] }); editor().commands.setTextSelection(value.length + 1) })
}
async function wait(check: () => void) { await vi.waitFor(async () => { await act(async () => {}); check() }) }
function seed(resourceHost: 'local' | 'remote', runtimeHost: 'local' | 'remote') {
  const runtime = { ...composerConfig.workspaces[0]!, hostId: runtimeHost, path: runtimePath }
  const resource = { ...runtime, id: 'resource', name: 'Project files', hostId: resourceHost, path: resourcePath }
  const session = { ...composerSession(), hostId: runtimeHost, workspacePath: runtime.path,
    control: { ...composerSession().control, hostId: runtimeHost },
    toolExecution: { bindingId: 'original-binding', resourceHostId: resourceHost, resourceRuntimeId: 'original-resource-runtime', workspacePath: resource.path } }
  useAppStore.setState({ config: { ...composerConfig,
    hosts: [...composerConfig.hosts, { id: 'remote', kind: 'ssh', label: 'Remote host', hostname: 'resource-proof' }], workspaces: [runtime, resource] }, sessions: [session],
    agentComposerDrafts: { 'agent-1': 'Keep my draft' }, lastActiveFileByWorkspace: { workspace: 'wrong-runtime.txt', resource: 'correct-project.txt' } })
  return { session, resource, runtime }
}
beforeEach(() => {
  vi.spyOn(api.continuousProgress, 'list').mockResolvedValue([])
  vi.spyOn(api.continuousProgress, 'pauseForInput').mockResolvedValue()
  vi.spyOn(api.files, 'readDirectory').mockResolvedValue([{ path: 'correct-project.txt', name: 'correct-project.txt', isDirectory: false, isSymlink: false }])
  vi.spyOn(api.ui, 'listAgentSkills').mockResolvedValue([{ name: 'review', path: runtimePath + '/SKILL.md', source: 'project', description: 'Runtime skill' }])
  vi.spyOn(api.ui, 'listWorkspaceSkills').mockResolvedValue([{ name: 'review', path: runtimePath + '/SKILL.md', source: 'project', description: 'Runtime skill' }])
  vi.spyOn(useAppStore.getState(), 'prewarmTerminal').mockResolvedValue()
  vi.spyOn(useAppStore.getState(), 'releaseWarmTerminal').mockResolvedValue()
  vi.spyOn(useAppStore.getState(), 'detectExecutors').mockResolvedValue()
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value() {} })
})

it.each([['local', 'remote'], ['remote', 'local'], ['local', 'local']] as const)('mounted Composer reads project files on %s while Skills stay with the original %s Session', async (resourceHost, runtimeHost) => {
  const { session } = seed(resourceHost, runtimeHost)
  await dom.render(<AgentSessionComposer sessionId="agent-1" />)
  await text('@correct')
  await wait(() => expect(document.querySelector('.composer__suggestions')?.textContent).toContain('correct-project.txt'))
  expect(api.files.readDirectory).toHaveBeenCalledExactlyOnceWith('resource', '')
  await text('$rev')
  await wait(() => expect(document.querySelector('.composer__suggestions')?.textContent).toContain('Runtime skill'))
  expect(api.ui.listAgentSkills).toHaveBeenCalledExactlyOnceWith(session.id)
  expect(api.ui.listWorkspaceSkills).not.toHaveBeenCalled()
  expect(useAppStore.getState().sessions[0]).toBe(session)
})

it('local project picker remains local with a remote Agent and inserts project-relative references', async () => {
  const { session } = seed('local', 'remote')
  const choose = vi.spyOn(api.ui, 'chooseFiles').mockResolvedValue([resourcePath + '/chosen.txt'])
  await dom.render(<AgentSessionComposer sessionId="agent-1" />)
  await dom.click('.composer-tool--mode')
  await dom.click('[aria-label="Reference files for the Agent to read"]')
  expect(choose.mock.calls).toEqual([[{ defaultPath: resourcePath }, undefined]])
  expect(expandSemanticReferences(dom.draft()!)).toContain('@chosen.txt')
  expect(dom.draft()).not.toContain(runtimePath)
  expect(useAppStore.getState().sessions[0]).toBe(session)
})

it('remote project picker uses its file API with a local Agent and never opens the local chooser', async () => {
  const { session } = seed('remote', 'local')
  const choose = vi.spyOn(api.ui, 'chooseFiles')
  await dom.render(<AgentSessionComposer sessionId="agent-1" />)
  await dom.click('.composer-tool--mode')
  await dom.click('[aria-label="Reference files for the Agent to read"]')
  await wait(() => expect(document.querySelector('[data-reference-path="correct-project.txt"]')).not.toBeNull())
  await act(async () => document.querySelector<HTMLButtonElement>('[data-reference-path="correct-project.txt"]')!.click())
  expect(api.files.readDirectory).toHaveBeenCalledExactlyOnceWith('resource', '')
  expect(choose).not.toHaveBeenCalled()
  expect(expandSemanticReferences(dom.draft()!)).toContain('@correct-project.txt')
  expect(useAppStore.getState().sessions[0]).toBe(session)
})

it('unregistered bound resource keeps its address and healthy input without borrowing the runtime project', async () => {
  const { session, runtime } = seed('local', 'remote')
  useAppStore.setState(state => ({ config: { ...state.config!, workspaces: [runtime] } }))
  const choose = vi.spyOn(api.ui, 'chooseFiles')
  await dom.render(<AgentSessionComposer sessionId="agent-1" />)
  await text('@')
  await wait(() => expect(document.body.textContent).toContain('original project file Workspace is unconfirmed'))
  expect(api.files.readDirectory).not.toHaveBeenCalled()
  await dom.click('.composer-tool--mode')
  await dom.click('[aria-label="Reference files for the Agent to read"]')
  expect(choose).not.toHaveBeenCalled()
  expect(dom.draft()).toBe('@')
  expect(editor().isEditable).toBe(true)
  expect(useAppStore.getState().sessions[0]).toBe(session)
})

it('image selection still uploads to the original local Session when its project lives remotely', async () => {
  const { session } = seed('remote', 'local'), bytes = new Uint8Array([1, 2, 3])
  const upload = { hostId: session.hostId, agentSessionId: session.id, expectedRun: session.control.run, operationId: 'original-image', name: 'paste.png', mimeType: 'image/png', byteLength: bytes.length, revision: fileUploadRevision(bytes) }
  vi.spyOn(api.ui, 'savePastedImage').mockResolvedValue(runtimePath + '/paste.png')
  const retain = vi.spyOn(api.ui, 'retainInputImage').mockResolvedValue({ upload, observation: 'confirmed' })
  await dom.render(<AgentSessionComposer sessionId="agent-1" />)
  const file = new File([bytes], 'paste.png', { type: 'image/png' }), event = new Event('paste', { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'clipboardData', { value: { items: [{ kind: 'file', type: file.type, getAsFile: () => file }], getData: () => '' } })
  await act(async () => editor().view.dom.dispatchEvent(event))
  await wait(() => expect(retain).toHaveBeenCalledOnce())
  expect(retain.mock.calls[0]![0]).toMatchObject({ session: session.control, bytes, mimeType: 'image/png' })
  expect(dom.draft()).toContain('agentmux-image:')
  expect(dom.draft()).toContain('Keep my draft')
})

it('Launcher files use project A while prestart Skills use independently selected runtime B', async () => {
  const { runtime, resource } = seed('local', 'remote')
  const launch = vi.spyOn(useAppStore.getState(), 'launchAgent').mockResolvedValue()
  useLauncherState.setState({ sections: { resource: { agents: 'expanded', terminal: 'hidden' } } })
  useAppStore.setState({ activeWorkspaceId: resource.id,
    tabs: { launcher: createWorkbenchTab('launcher', { kind: 'launcher', regionId: 'region', workspaceId: resource.id, agentWorkspaceId: runtime.id,
      agentExecutor: { hostId: runtime.hostId, executorId: 'codex', executorRevision: 'runtime-revision' } }) },
    hostExecutorInventories: { remote: { state: 'ready', input: useAppStore.getState().config!.hosts.find(host => host.id === runtime.hostId)!, observedAt: 1,
      result: { routeHostId: runtime.hostId, runtimeId: 'original-runtime', executors: [{ executorId: 'codex', providerId: 'codex', label: 'Codex', command: 'codex', source: 'registered', configRevision: 'runtime-revision', availability: 'available' }] } } } })
  await dom.render(<NewTabSurface tabGroupId="group" tabId="launcher" regionId="region" />)
  await text('@correct')
  await wait(() => expect(api.files.readDirectory).toHaveBeenCalledWith(resource.id, ''))
  await text('$rev')
  await wait(() => expect(api.ui.listWorkspaceSkills).toHaveBeenCalledWith(runtime.id, 'codex'))
  expect(launch).not.toHaveBeenCalled()
})

it('duplicate exact registrations require the original selected owner instead of an arbitrary first match', () => {
  const { session, resource } = seed('local', 'remote')
  const config = { ...useAppStore.getState().config!, workspaces: [resource, { ...resource, id: 'second' }] }
  expect(sessionResourceContext(config, session)).toMatchObject({ address: { hostId: 'local', path: resourcePath }, issue: expect.any(String) })
  expect(sessionResourceContext(config, session).workspace).toBeUndefined()
  expect(sessionResourceContext(config, session, undefined, 'second').workspace?.id).toBe('second')
})

it('a mixed local file paste keeps the image on its original input channel and reports only the untransferred remote-project file', async () => {
  const { session } = seed('remote', 'local'), bytes = new Uint8Array([1, 2, 3])
  const upload = { hostId: session.hostId, agentSessionId: session.id, expectedRun: session.control.run, operationId: 'mixed-image', name: 'paste.png', mimeType: 'image/png', byteLength: bytes.length, revision: fileUploadRevision(bytes) }
  vi.spyOn(api.ui, 'savePastedImage').mockResolvedValue(runtimePath + '/mixed.png')
  const retain = vi.spyOn(api.ui, 'retainInputImage').mockResolvedValue({ upload, observation: 'confirmed' })
  const localPath = vi.spyOn(api.ui, 'pathForFile')
  await dom.render(<AgentSessionComposer sessionId="agent-1" />)
  const event = new Event('paste', { bubbles: true, cancelable: true })
  const files = [new File([bytes], 'image.png', { type: 'image/png' }), new File(['local bytes'], 'local.txt', { type: 'text/plain' })]
  Object.defineProperty(event, 'clipboardData', { value: { items: files.map(file => ({ kind: 'file', type: file.type, getAsFile: () => file })), getData: () => '' } })
  await act(async () => editor().view.dom.dispatchEvent(event))
  await wait(() => expect(dom.draft()).toContain('agentmux-image:'))
  await wait(() => expect(document.body.textContent).toContain('local.txt: This local file has not been transferred to the project machine'))
  expect(retain).toHaveBeenCalledOnce()
  expect(retain.mock.calls[0]![0].session).toBe(session.control)
  expect(localPath).not.toHaveBeenCalled()
  expect(dom.draft()).not.toContain('@local.txt')
  expect(dom.draft()).toContain('Keep my draft')
})
