// @vitest-environment happy-dom
import { act } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
import { AgentSessionComposer } from '../src/renderer/src/components/AgentSessionComposer'
import { SessionMailbox } from '../src/renderer/src/components/SessionMailbox'
import { api } from '../src/renderer/src/lib/api'
import { originalSourceInputOwnerKey } from '../src/renderer/src/lib/original-space-navigation'
import { useAppStore } from '../src/renderer/src/store'
import { composerConfig, composerDOM, composerSession } from './helpers/composer-dom-fixture'
import type { SpaceMountMemberTarget } from '../src/shared/space-mount'

const dom = composerDOM(), sid = 'same-source-and-observer-sid'
const original = composerSession(sid)
const target: SpaceMountMemberTarget = { hostId: 'original-carrier', target: {
  reference: { runtimeId: 'source-runtime', spaceId: 'original-space' }, regionId: 'original-region',
  runtimeId: 'execution-runtime', agentSessionId: sid, expectedRun: original.control.run,
  expectedAdmission: { kind: 'creation', operationId: 'original-creation' }
} }
const owner = originalSourceInputOwnerKey(target.target.runtimeId, sid)
const panel = () => dom.container.querySelector<HTMLElement>('.composer-mailbox')!
async function openMailbox(folder: string) {
  const event = new Event('toggle'); Object.defineProperty(event, 'newState', { value: 'open' })
  await act(async () => panel().dispatchEvent(event))
  await dom.click(`[role="tab"][id$="-${folder}-tab"]`)
}
beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn()
  vi.spyOn(api.continuousProgress, 'pauseForInput').mockResolvedValue(undefined)
  vi.spyOn(api.sessions, 'notifyInputOccupation').mockResolvedValue(undefined)
  useAppStore.setState({ config: { ...composerConfig, messageToolInitialLayout: 'two-line' }, sessions: [original], timelines: {},
    noticeReadReceipts: {}, agentComposerDrafts: { [owner]: 'Original private draft' }, agentComposerHistory: { [owner]: ['Original local history'] },
    agentSteerQueues: { [owner]: [{ operationId: 'retained-original-input', text: 'Keep this original queue item',
      promptCondition: null, enqueuedAt: 1, runId: original.control.run.runId, status: 'deferred', awaitingExplicitSend: true, origin: 'manual' }] } })
})

it('keeps Source editing and queue tools without querying observer-local mail, history or automation', async () => {
  const mailbox = vi.spyOn(api.sessions, 'inputMailbox')
  const messages = vi.spyOn(api.sessions, 'listMessages')
  const history = vi.spyOn(api.sessions, 'readHistory')
  const automation = vi.spyOn(api.continuousProgress, 'list').mockResolvedValue([])
  const skills = vi.spyOn(api.ui, 'listAgentSkills').mockResolvedValue([])
  await dom.render(<AgentSessionComposer sessionId={owner} source={{ target, session: original }} />)
  expect(dom.container.querySelector('[aria-label="Message Agent"]')?.getAttribute('contenteditable')).toBe('true')
  await openMailbox('user')
  expect(panel().textContent).toContain('Keep this original queue item')
  await openMailbox('system')
  expect(panel().textContent).toContain('Some message tools are unavailable on this connection')
  const automationEntry = dom.container.querySelector<HTMLButtonElement>('[aria-label="Automation"]')
  if (automationEntry) await act(async () => automationEntry.click())
  expect(automationEntry).toBeNull()
  const skill = dom.container.querySelector<HTMLElement>('[aria-label="Choose a skill"]')!
  await act(async () => skill.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse', buttons: 0 })))
  await vi.waitFor(() => expect(document.body.textContent).toContain('Original Agent Skills are unavailable'))
  expect(mailbox).not.toHaveBeenCalled(); expect(messages).not.toHaveBeenCalled(); expect(history).not.toHaveBeenCalled()
  expect(automation).not.toHaveBeenCalled(); expect(skills).not.toHaveBeenCalled()
  expect(dom.draft(owner)).toBe('Original private draft')
  expect(useAppStore.getState().agentSteerQueues[owner]?.[0]?.operationId).toBe('retained-original-input')
})

it('references the confirmed local resource project while image transfer keeps the original target unavailable', async () => {
  const choose = vi.spyOn(api.ui, 'chooseFiles').mockResolvedValue([`${composerConfig.workspaces[0]!.path}/selected.ts`])
  const upload = vi.spyOn(api.ui, 'retainInputImage')
  const save = vi.spyOn(api.ui, 'savePastedImage')
  await dom.render(<AgentSessionComposer sessionId={owner} source={{ target, session: original }} resourceWorkspaceId="workspace" />)
  await dom.click('[aria-label="Reference files for the Agent to read"]')
  await vi.waitFor(() => expect(dom.draft(owner)).toContain('selected.ts'))
  expect(choose).toHaveBeenCalledExactlyOnceWith({ defaultPath: composerConfig.workspaces[0]!.path }, undefined)
  const editor = dom.container.querySelector<HTMLElement>('[aria-label="Message Agent"]')!
  const paste = new Event('paste', { bubbles: true, cancelable: true })
  Object.defineProperty(paste, 'clipboardData', { value: { types: ['Files'], files: [new File(['image-bytes'], 'image.png', { type: 'image/png' })],
    items: [{ kind: 'file', type: 'image/png', getAsFile: () => new File(['image-bytes'], 'image.png', { type: 'image/png' }) }], getData: () => '' } })
  await act(async () => editor.dispatchEvent(paste))
  await vi.waitFor(() => expect(document.body.textContent).toContain('This resource has not been transferred'))
  expect(upload).not.toHaveBeenCalled(); expect(save).not.toHaveBeenCalled()
  expect(dom.draft(owner)).toContain('Original private draft')
  expect(dom.draft(owner)).toContain('selected.ts')
})

it('does not infer an unconfirmed Source file route from an observer workspace with the same raw cwd', async () => {
  const choose = vi.spyOn(api.ui, 'chooseFiles')
  await dom.render(<AgentSessionComposer sessionId={owner} source={{ target, session: original }} />)
  await dom.click('[aria-label="Reference files for the Agent to read"]')
  await vi.waitFor(() => expect(document.body.textContent).toContain('original project file Workspace is unconfirmed'))
  expect(choose).not.toHaveBeenCalled()
  expect(dom.draft(owner)).toBe('Original private draft')
})

it('an explicit unavailable Mailbox route cannot fall back to an observer timeline lookalike', async () => {
  const messages = vi.spyOn(api.sessions, 'listMessages')
  const mailbox = vi.spyOn(api.sessions, 'inputMailbox')
  await dom.render(<SessionMailbox control={null} timeline={{ agentSessionId: sid, revision: 1, items: [] }}
    system={{ scope: owner, available: true, notices: [], unread: [], acknowledge: vi.fn() }} queued={[]} />)
  await openMailbox('user')
  expect(messages).not.toHaveBeenCalled(); expect(mailbox).not.toHaveBeenCalled()
})

it('an unknown Source never borrows a configured Session matching its canonical queue key', async () => {
  useAppStore.setState({sessions:[composerSession(owner)]})
  await dom.render(<AgentSessionComposer sessionId={owner} source={{target}} />)
  expect(dom.container.querySelector<HTMLButtonElement>('.composer-send')!.disabled).toBe(true)
  expect(dom.container.querySelector('[aria-label="Message Agent"]')!.getAttribute('contenteditable')).toBe('true')
  expect(dom.draft(owner)).toBe('Original private draft')
})
