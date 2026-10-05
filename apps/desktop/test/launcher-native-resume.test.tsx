import { fixtureEpoch as _reshape_fixtureEpoch } from "../../../test/fixture-values.mjs"
import { fixturePath as _tail_fixturePath } from '../../../test/fixture-values.mjs'
// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createWorkspaceLayout } from '@agentmux/layout'
import { LauncherResumePicker as ActualLauncherResumePicker } from '../src/renderer/src/components/LauncherResumePicker.js'
import { DesktopClientUiProvider } from '../src/renderer/src/components/DesktopClientUiProvider.js'
import { useAppStore, recoveryCandidateSession } from '../src/renderer/src/store.js'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs.js'
import { api } from '../src/renderer/src/lib/api.js'
import type { AppConfig, AgentSessionRecoveryCandidate, NativeAgentHistoryInput, NativeAgentHistoryResult, NativeAgentSessionsInput, NativeAgentSessionsResult } from '../src/shared/contracts.js'
function LauncherResumePicker(props: React.ComponentProps<typeof ActualLauncherResumePicker>) { return <DesktopClientUiProvider><ActualLauncherResumePicker {...props} /></DesktopClientUiProvider> }
const initial = useAppStore.getState()
const config: AppConfig = { version: 9, hosts: [{ id: 'local', kind: 'local', label: 'This Mac' }],
 executors: { codex: { providerId: 'codex', label: 'Codex', command: 'codex', args: [], env: {}, injectAgentMuxGuide: true } },
 workspaces: [{ id: 'project', name: 'Project', path: _tail_fixturePath("repo"), hostId: 'local', kind: 'folder' }],
 appearance: { terminalTheme: 'graphite' }, browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } } }
const workspace = config.workspaces[0]!
const candidate = (id: string, native = 'native-original'): AgentSessionRecoveryCandidate => ({ agentSessionId: id, hostId: 'local', providerId: 'codex', executorId: 'codex', workspacePath: _tail_fixturePath("repo"), nativeSessionId: native, run: { runId: 'run-' + id }, label: id, createdAt: _reshape_fixtureEpoch(0, 0, 100), updatedAt: _reshape_fixtureEpoch(0, 0, 1000), capabilities: { providerResume: true } as AgentSessionRecoveryCandidate['capabilities'] })
const running = (id: string, native = 'native-original') => ({ ...recoveryCandidateSession(candidate(id, native), { kind: 'pending', detail: 'Unconfirmed' }), processState: 'running' as const, status: { state: 'working' as const, source: 'native-hook' as const, observedAt: _reshape_fixtureEpoch(0, 0, 1000) } })
function catalog(input: NativeAgentSessionsInput, revision = 'original-lifetime'): NativeAgentSessionsResult {
 return { ...input, providerId: 'codex', capabilities: candidate('cap').capabilities, availability: 'available', sessions: [{ source: { nativeHandle: { kind: 'provider', providerId: 'codex', sessionId: 'native-original', transcriptPath: _tail_fixturePath("history/original.jsonl") }, workspacePath: _tail_fixturePath("repo"), revision }, title: 'Saved original', createdAt: _reshape_fixtureEpoch(0, 0, 100), updatedAt: _reshape_fixtureEpoch(0, 0, 2000) }], issues: [] }
}
function seed(extra = {}) {
 const launcher = createWorkbenchTab('launcher', { regionId: 'launcher-region', kind: 'launcher', workspaceId: 'project' })
 useAppStore.setState({ config, sessions: [], recoveryCandidates: [], timelines: {}, agentNames: {}, tabs: { launcher },
  layouts: { project: createWorkspaceLayout('group', ['launcher']) }, activeWorkspaceId: 'project', mainSurface: 'workbench',
  agentComposerDrafts: { 'launcher-region': 'UNSENT' }, ...extra })
}
let root: Root, container: HTMLDivElement
beforeEach(() => { vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); container = document.createElement('div'); document.body.append(container); root = createRoot(container); seed() })
afterEach(async () => { await act(async () => root.unmount()); container.remove(); useAppStore.setState(initial, true); vi.restoreAllMocks() })
function button(label: string | RegExp): HTMLButtonElement {
 const match = [...document.querySelectorAll<HTMLButtonElement>('button')].find(item => typeof label === 'string' ? item.textContent?.trim() === label : label.test(item.textContent || ''))
 if (!match) throw new Error('Button missing: ' + label); return match
}
async function click(target: HTMLElement) { await act(async () => target.click()) }
async function open() { await act(async () => root.render(<LauncherResumePicker workspace={workspace} />)); await click(button('Resume')) }

function nativePage(input: NativeAgentHistoryInput, text = 'The original saved answer'): NativeAgentHistoryResult {
 return { hostId: input.hostId, executorId: input.executorId, nativeSource: input.source,
  source: { providerId: input.source.nativeHandle.providerId, nativeSessionId: input.source.nativeHandle.sessionId },
  items: [{ id: 'saved-question', kind: 'user-message', contentParts: [{ kind: 'text', text: 'What did we decide previously?' }] },
   { id: 'saved-answer', kind: 'assistant-message', contentParts: [{ kind: 'text', text }] }], nextCursor: null }
}

it('publishes completed external Codex conversations while another source waits, and reads before creating a Run', async () => {
 const pending = new Promise<NativeAgentSessionsResult>(() => {})
 useAppStore.setState({ config: { ...config, executors: { ...config.executors,
  claude: { ...config.executors.codex!, providerId: 'claude', label: 'Claude', command: 'claude' } } } })
 vi.spyOn(api.sessions, 'nativeSessions').mockImplementation(input => input.executorId === 'codex' ? Promise.resolve(catalog(input)) : pending)
 const read = vi.spyOn(api.sessions, 'nativeHistoryPage').mockImplementation(async input => nativePage(input))
 const launch = vi.spyOn(api.sessions, 'launchAgent')
 const resume = vi.fn(async () => undefined); useAppStore.setState({ resumeNativeSession: resume })
 await open()
 expect(document.querySelectorAll('[role="option"]')).toHaveLength(1)
 expect(document.body.textContent).toContain('Saved original')
 expect(document.body.textContent).toContain('The original saved answer')
 expect(document.body.textContent).toContain('What did we decide previously?')
 expect(document.body.textContent).toContain('1/2 sources checked')
 expect(document.body.textContent).toContain('Claude')
 expect(button('Resume Session').disabled).toBe(false)
 expect(read).toHaveBeenCalledWith(expect.objectContaining({ source: catalog({ hostId: 'local', executorId: 'codex' }).sessions[0]!.source, limit: 100 }))
 expect(launch).not.toHaveBeenCalled()
 expect(useAppStore.getState().sessions).toHaveLength(0)
 await click(button('Resume Session'))
 expect(resume.mock.calls[0]![0]).toEqual(expect.objectContaining({ hostId: 'local', executorId: 'codex',
  workspacePath: workspace.path, nativeResumeSource: catalog({ hostId: 'local', executorId: 'codex' }).sessions[0]!.source }))
 expect(resume.mock.calls[0]![0]).not.toHaveProperty('initialPrompt')
})

it('does not restart source reads when equivalent configuration objects or labels are refreshed', async () => {
 const list = vi.spyOn(api.sessions, 'nativeSessions').mockImplementation(async input => catalog(input))
 vi.spyOn(api.sessions, 'nativeHistoryPage').mockImplementation(async input => nativePage(input))
 await open()
 expect(list).toHaveBeenCalledTimes(1)
 await act(async () => useAppStore.setState({ config: { ...structuredClone(config),
  hosts: [{ ...config.hosts[0]!, label: 'Renamed Mac' }],
  executors: { codex: { ...structuredClone(config.executors.codex!), label: 'Renamed Codex' } } } }))
 expect(list).toHaveBeenCalledTimes(1)
 expect(document.body.textContent).toContain('Renamed Codex')
})

it('keeps the original selected conversation when another source completes later with newer entries', async () => {
 let complete!: (value: NativeAgentSessionsResult) => void
 const pending = new Promise<NativeAgentSessionsResult>(resolve => { complete = resolve })
 useAppStore.setState({ config: { ...config, executors: { ...config.executors,
  another: { ...config.executors.codex!, label: 'Another Executor' } } } })
 vi.spyOn(api.sessions, 'nativeSessions').mockImplementation(input => input.executorId === 'codex' ? Promise.resolve(catalog(input)) : pending)
 const read = vi.spyOn(api.sessions, 'nativeHistoryPage').mockImplementation(async input => nativePage(input))
 await open()
 const later = catalog({ hostId: 'local', executorId: 'another' }); later.sessions[0]!.source.nativeHandle.sessionId = 'later-native'
 later.sessions[0]!.title = 'Newer conversation'; later.sessions[0]!.updatedAt = 5000
 await act(async () => complete(later))
 expect(document.querySelectorAll('[role="option"]')).toHaveLength(2)
 expect(document.querySelector('[role="option"][aria-selected="true"]')?.textContent).toContain('Saved original')
 expect(read).toHaveBeenCalledTimes(1)
 expect(document.querySelector('[aria-label="Selected Session details"]')?.textContent).not.toContain('later-native')
})

it('ignores a stale native detail response after a different conversation has been selected', async () => {
 let complete!: (value: NativeAgentHistoryResult) => void
 const pending = new Promise<NativeAgentHistoryResult>(resolve => { complete = resolve })
 const entries = catalog({ hostId: 'local', executorId: 'codex' })
 const second = structuredClone(entries.sessions[0]!); second.source.nativeHandle.sessionId = 'second-native'; second.title = 'Second conversation'; second.updatedAt = 1000
 entries.sessions.push(second)
 vi.spyOn(api.sessions, 'nativeSessions').mockResolvedValue(entries)
 vi.spyOn(api.sessions, 'nativeHistoryPage').mockImplementation(input => input.source.nativeHandle.sessionId === 'native-original' ? pending : Promise.resolve(nativePage(input, 'SECOND answer')))
 await open()
 await click([...document.querySelectorAll<HTMLElement>('[role="option"]')].find(element => element.textContent?.includes('Second conversation'))!)
 expect(document.querySelector('[aria-label="Selected Session details"]')?.textContent).toContain('SECOND answer')
 await act(async () => complete(nativePage({ hostId: 'local', executorId: 'codex', source: entries.sessions[0]!.source }, 'STALE answer')))
 expect(document.querySelector('[aria-label="Selected Session details"]')?.textContent).toContain('SECOND answer')
 expect(document.querySelector('[aria-label="Selected Session details"]')?.textContent).not.toContain('STALE answer')
})

it('rejects an active managed native source changed after discovery, before state write or recovery', async () => {
 const native = catalog({ hostId: 'local', executorId: 'codex' }).sessions[0]!
 native.managed = { agentSessionId: 'managed-original', executorId: 'codex', run: { runId: 'listed-run' }, state: 'active' }
 const switched = running('managed-original', 'DIFFERENT-native')
 vi.spyOn(api.sessions, 'refresh').mockResolvedValue(switched)
 const recover = vi.fn(async () => switched)
 useAppStore.setState({ recoverSession: recover })
 let refused = false
 await useAppStore.getState().resumeNativeSession({ hostId: 'local', executorId: 'codex', workspacePath: _tail_fixturePath("repo"), agentSessionId: 'unused', createOperationId: 'resume-original', nativeResumeSource: native.source }, native, candidate('cap').capabilities).catch(() => { refused = true })
 expect(refused, 'changed native source must be refused').toBe(true)
 expect(recover).not.toHaveBeenCalled()
 expect(useAppStore.getState().sessions).toHaveLength(0)
})

it('does not manufacture original native identity when a Core receipt has a different native handle', async () => {
 const native = catalog({ hostId: 'local', executorId: 'codex' }).sessions[0]!
 vi.spyOn(api.sessions, 'launchAgent').mockResolvedValue({ created: { kind: 'agent', agentSessionId: 'adopted', hostId: 'local', providerId: 'codex', executorId: 'codex', workspacePath: _tail_fixturePath("repo"), run: { runId: 'real-run' }, retiredRuns: [], createdAt: _reshape_fixtureEpoch(0, 0, 100), updatedAt: _reshape_fixtureEpoch(0, 0, 2000), nativeHandle: { kind: 'provider', providerId: 'codex', sessionId: 'DIFFERENT-native' } }, projectionFailures: [{ step: 'session', message: 'display read unavailable' }] })
 let refused = false
 await useAppStore.getState().resumeNativeSession({ hostId: 'local', executorId: 'codex', workspacePath: _tail_fixturePath("repo"), agentSessionId: 'adopted', createOperationId: 'resume-original', nativeResumeSource: native.source }, native, candidate('cap').capabilities).catch(() => { refused = true })
 expect(refused, 'actual Core native witness must match selected source').toBe(true)
})

it('keeps the complete original native resume body after unknown ACK and same-ID refreshed source', async () => {
 let revision = 'original-lifetime'
 vi.spyOn(api.sessions, 'nativeSessions').mockImplementation(async input => catalog(input, revision))
 const resume = vi.fn().mockRejectedValue(new Error('ACK unknown'))
 seed({ resumeNativeSession: resume }); await open()
 await click(button('Resume Session'))
 const original = structuredClone(resume.mock.calls[0]![0])
 revision = 'REPLACED-lifetime'
 await click(button(/All projects/))
 await click(document.querySelector<HTMLButtonElement>('button[aria-label="Refresh discovery"]')!)
 await click(button('Resume Session'))
 expect(resume.mock.calls[1]![0]).toEqual(original)
})

it('invalidates old reveal permanently on close, even when reopened onto the same native key', async () => {
 vi.spyOn(api.sessions, 'nativeSessions').mockImplementation(async input => catalog(input))
 let finish!: () => void
 const resume = vi.fn(() => new Promise<undefined>(resolve => { finish = () => resolve(undefined) }))
 seed({ resumeNativeSession: resume }); await open(); await click(button('Resume Session'))
 const reveal = resume.mock.calls[0]![3] as unknown as () => boolean
 await click(document.querySelector<HTMLButtonElement>('button[aria-label="Close resume picker"]')!)
 expect(reveal()).toBe(false)
 await click(button('Resume'))
 const oldIsRevealed = reveal()
 await act(async () => finish())
 expect(oldIsRevealed, 'a new open cannot restore an old request navigation lease').toBe(false)
})


it('retains a previously listed native candidate when a fulfilled partial catalog cannot read that source', async () => {
 let partial = false
 vi.spyOn(api.sessions, 'nativeSessions').mockImplementation(async input => partial
  ? { ...catalog(input), sessions: [], issues: [{ code: 'SOURCE_UNAVAILABLE', message: 'Original transcript is temporarily unreadable' }] }
  : catalog(input))
 await open()
 expect(document.querySelectorAll('[role=option]')).toHaveLength(1)
 partial = true
 await click(button(/All projects/))
 await click(document.querySelector<HTMLButtonElement>('button[aria-label="Refresh discovery"]')!)
 expect(document.querySelectorAll('[role=option]'), 'partial observation failure cannot erase known candidate').toHaveLength(1)
 expect(document.querySelector('[role=dialog]')?.textContent).toContain('Original transcript is temporarily unreadable')
})

it('observes the already-reopened canonical Session after a lost retirement resume ACK', async () => {
 const native = catalog({ hostId: 'local', executorId: 'codex' }).sessions[0]!
 native.managed = { agentSessionId: 'retired-original', executorId: 'codex', run: { runId: 'retired-run' }, state: 'retired', retiredAt: _reshape_fixtureEpoch(0, 0, 500) }
 const restored = running('retired-original')
 vi.spyOn(api.sessions, 'reopen').mockRejectedValue(new Error('Original reopen ACK is unknown'))
 vi.spyOn(api.sessions, 'reconcileReopen').mockResolvedValue(restored)
 vi.spyOn(api.sessions, 'creation').mockResolvedValue({ kind: 'agent', agentSessionId: restored.id, hostId: 'local', providerId: 'codex', executorId: 'codex', workspacePath: _tail_fixturePath("repo"), run: restored.control.run, retiredRuns: [], createdAt: _reshape_fixtureEpoch(0, 0, 100), updatedAt: _reshape_fixtureEpoch(0, 0, 2000), nativeHandle: native.source.nativeHandle })
 vi.spyOn(api.sessions, 'refresh').mockResolvedValue(restored)
 const result = await useAppStore.getState().resumeNativeSession({ hostId: 'local', executorId: 'codex', workspacePath: _tail_fixturePath("repo"), agentSessionId: 'unused-new-id', createOperationId: 'original-retired-resume', nativeResumeSource: native.source }, native, candidate('cap').capabilities).catch(() => undefined)
 expect(result?.id, 'canonical original reopened identity is recoverable without new launch').toBe('retired-original')
})

it('explains a native recovery that did not confirm a current Session while keeping the picker actionable', async () => {
 vi.spyOn(api.sessions, 'nativeSessions').mockImplementation(async input => catalog(input))
 seed({ resumeNativeSession: vi.fn(async () => undefined) }); await open()
 await click(button('Resume Session'))
 expect(document.querySelector('.launcher-resume__feedback')?.textContent).toMatch(/did not confirm a current Session|did not complete|unknown/i)
 expect(button('Resume Session').disabled).toBe(false)
})


it('invalidates an old native reveal when a search changes selection away and back', async () => {
 vi.spyOn(api.sessions, 'nativeSessions').mockImplementation(async input => catalog(input))
 let finish!: () => void
 const resume = vi.fn(() => new Promise<undefined>(resolve => { finish = () => resolve(undefined) }))
 seed({ resumeNativeSession: resume }); await open(); await click(button('Resume Session'))
 const reveal = resume.mock.calls[0]![3] as unknown as () => boolean
 const input = document.querySelector<HTMLInputElement>('input[aria-label="Search saved Sessions"]')!
 async function search(value: string) { await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })) }) }
 await search('No-match'); expect(reveal()).toBe(false)
 await search('')
 const oldIsRevealed = reveal(); await act(async () => finish())
 expect(oldIsRevealed, 'search-derived selection cannot renew an old navigation lease').toBe(false)
})

it('checks the original creation after unknown ACK even when the Executor configuration changed', async () => {
 const native = catalog({ hostId: 'local', executorId: 'codex' }).sessions[0]!
 const restored = running('adopted')
 const original = { kind: 'agent' as const, agentSessionId: restored.id, hostId: 'local', providerId: 'codex' as const, executorId: 'codex',
  workspacePath: _tail_fixturePath("repo"), run: restored.control.run, retiredRuns: [], createdAt: _reshape_fixtureEpoch(0, 0, 100), updatedAt: _reshape_fixtureEpoch(0, 0, 2000), nativeHandle: native.source.nativeHandle,
  creation: { createOperationId: 'original-operation', initialPrompt: 'not-requested' as const } }
 vi.spyOn(api.sessions, 'creation').mockResolvedValue(original)
 vi.spyOn(api.sessions, 'refresh').mockResolvedValue(restored)
 const launch = vi.spyOn(api.sessions, 'launchAgent').mockRejectedValue(new Error('A changed Executor must not replay the original launch'))
 useAppStore.setState({ config: { ...config, executors: { codex: { ...config.executors.codex!, args: ['--new-setting'], env: { CODEX_HOME: _tail_fixturePath("changed-history") } } } } })
 await expect(useAppStore.getState().resumeNativeSession({ hostId: 'local', executorId: 'codex', workspacePath: _tail_fixturePath("repo"),
  agentSessionId: 'adopted', createOperationId: 'original-operation', nativeResumeSource: native.source }, native, candidate('cap').capabilities, () => true, true)).resolves.toMatchObject({ id: 'adopted' })
 expect(launch).not.toHaveBeenCalled()
 expect(api.sessions.creation).toHaveBeenCalledWith('local', 'adopted')
})

it('rejects a native source changed in the same Run while retaining the old binding and healthy Agent', async () => {
 const native = catalog({ hostId: 'local', executorId: 'codex' }).sessions[0]!
 native.managed = { agentSessionId: 'managed-original', executorId: 'codex', run: { runId: 'listed-run' }, state: 'active' }
 const current = { ...running('managed-original'), observedNativeHandle: { kind: 'provider' as const, providerId: 'codex' as const, sessionId: 'different-current-conversation' } }
 vi.spyOn(api.sessions, 'refresh').mockResolvedValue(current)
 const recover = vi.fn(async () => current)
 useAppStore.setState({ recoverSession: recover })
 await expect(useAppStore.getState().resumeNativeSession({ hostId: 'local', executorId: 'codex', workspacePath: _tail_fixturePath("repo"),
  agentSessionId: 'unused', createOperationId: 'source-specific-resume', nativeResumeSource: native.source }, native, candidate('cap').capabilities)).rejects.toThrow('another conversation identity')
 expect(recover).not.toHaveBeenCalled()
 expect(useAppStore.getState().sessions).toHaveLength(0)
})

it('reads older messages from the exact selected source and keeps visible messages after a page failure', async () => {
 vi.spyOn(api.sessions, 'nativeSessions').mockImplementation(async input => catalog(input))
 let fail = true
 const read = vi.spyOn(api.sessions, 'nativeHistoryPage').mockImplementation(async input => {
  if (!input.cursor) return { ...nativePage(input), nextCursor: 'native-page-before-current' }
  if (fail) throw new Error('Original source is temporarily unreadable')
  return { ...nativePage(input, 'Older original answer'), items: [{ id: 'older-answer', kind: 'assistant-message', contentParts: [{ kind: 'text', text: 'Older original answer' }] }] }
 })
 await open()
 await click(button('Read older messages'))
 expect(document.body.textContent).toContain('The original saved answer')
 expect(document.body.textContent).toContain('Original source is temporarily unreadable')
 expect(button('Resume Session').disabled).toBe(false)
 fail = false
 await click(button('Read older messages'))
 const detail = document.querySelector('[aria-label="Selected Session details"]')!
 expect(detail.textContent).toContain('Older original answer')
 expect(detail.textContent).toContain('The original saved answer')
 expect(read).toHaveBeenLastCalledWith(expect.objectContaining({ hostId: 'local', executorId: 'codex',
  source: catalog({ hostId: 'local', executorId: 'codex' }).sessions[0]!.source, cursor: 'native-page-before-current', limit: 100 }))
})

it('refuses details for another saved identity while preserving the exact Resume choice', async () => {
 vi.spyOn(api.sessions, 'nativeSessions').mockImplementation(async input => catalog(input))
 vi.spyOn(api.sessions, 'nativeHistoryPage').mockImplementation(async input => ({ ...nativePage(input, 'UNRELATED answer'),
  source: { providerId: 'codex', nativeSessionId: 'unrelated-native' } }))
 await open()
 expect(document.body.textContent).not.toContain('UNRELATED answer')
 expect(document.body.textContent).toContain('another saved source')
 expect(button('Resume Session').disabled).toBe(false)
})

it('discards old details after refreshing the same conversation to a new source lifetime', async () => {
 let revision = 'original-lifetime', complete!: (value: NativeAgentHistoryResult) => void
 const pending = new Promise<NativeAgentHistoryResult>(resolve => { complete = resolve })
 vi.spyOn(api.sessions, 'nativeSessions').mockImplementation(async input => catalog(input, revision))
 vi.spyOn(api.sessions, 'nativeHistoryPage').mockImplementation(input => input.source.revision === 'original-lifetime' ? pending : Promise.resolve(nativePage(input, 'CURRENT saved answer')))
 await open()
 revision = 'replaced-lifetime'
 await click(document.querySelector<HTMLButtonElement>('button[aria-label="Refresh discovery"]')!)
 expect(document.body.textContent).toContain('CURRENT saved answer')
 await act(async () => complete(nativePage({ hostId: 'local', executorId: 'codex', source: catalog({ hostId: 'local', executorId: 'codex' }).sessions[0]!.source }, 'OLD saved answer')))
 expect(document.body.textContent).toContain('CURRENT saved answer')
 expect(document.body.textContent).not.toContain('OLD saved answer')
})

it('pauses discovery observations without hiding completed choices and ignores the cancelled observer result', async () => {
 let complete!: (value: NativeAgentSessionsResult) => void
 const pending = new Promise<NativeAgentSessionsResult>(resolve => { complete = resolve })
 useAppStore.setState({ config: { ...config, executors: { ...config.executors, another: { ...config.executors.codex!, label: 'Another Executor' } } } })
 vi.spyOn(api.sessions, 'nativeSessions').mockImplementation(input => input.executorId === 'codex' ? Promise.resolve(catalog(input)) : pending)
 vi.spyOn(api.sessions, 'nativeHistoryPage').mockImplementation(async input => nativePage(input))
 await open(); await click(button('Pause updates'))
 expect(document.body.textContent).toContain('Discovery updates paused')
 expect(document.querySelectorAll('[role="option"]')).toHaveLength(1)
 expect(button('Resume Session').disabled).toBe(false)
 const later = catalog({ hostId: 'local', executorId: 'another' }); later.sessions[0]!.source.nativeHandle.sessionId = 'cancelled-source'
 await act(async () => complete(later))
 expect(document.querySelectorAll('[role="option"]')).toHaveLength(1)
 expect(document.body.textContent).not.toContain('cancelled-source')
})
