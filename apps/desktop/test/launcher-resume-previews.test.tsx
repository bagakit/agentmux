const { fixturePath: _reshape_fixturePath, fixtureEpoch: _reshape_fixtureEpoch } = await vi.hoisted(async () => await import("../../../test/fixture-values.mjs"))
// @vitest-environment happy-dom
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createClientUiRoot } from './helpers/client-ui-render'
import { NewTabSurface } from '../src/renderer/src/components/NewTabSurface'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import type { AppConfig, NativeAgentHistoryInput, NativeAgentHistoryResult } from '../src/shared/contracts'
vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: () => null }))
const config = { version: 9, hosts: [{ id: 'local', kind: 'local', label: 'This Mac' }],
 executors: { codex: { label: 'Codex', providerId: 'codex', command: 'codex', args: [], env: {} } },
 workspaces: [{ id: 'project', name: 'Project', hostId: 'local', path: _reshape_fixturePath("repo"), kind: 'folder' }],
 appearance: { terminalTheme: 'graphite' }, browser: { toolbar: {} } } as AppConfig
const sources = Array.from({ length: 30 }, (_, n) => ({ nativeHandle: { kind: 'provider' as const, providerId: 'codex' as const,
 sessionId: `original-${n}`, transcriptPath: _reshape_fixturePath(`native/${n}.jsonl`) }, workspacePath: _reshape_fixturePath("repo"), revision: 'a'.repeat(64) }))
const calls: { input: NativeAgentHistoryInput; resolve: (page: NativeAgentHistoryResult) => void; reject: (cause: Error) => void }[] = []
const initial = useAppStore.getState()
let container: HTMLDivElement, root: Root, observer: TestObserver
class TestObserver {
 callback: IntersectionObserverCallback
 constructor(callback: IntersectionObserverCallback) { this.callback = callback; observer = this }
 observe() {} unobserve() {} disconnect() {}
 notify(visible: number[]) {
  this.callback([...document.querySelectorAll<HTMLElement>('[role="option"]')].map((target, n) =>
   ({ target, isIntersecting: visible.includes(n) })) as IntersectionObserverEntry[], this as unknown as IntersectionObserver)
 }
}
function page(call: (typeof calls)[number], text: string, extra = {}): NativeAgentHistoryResult {
 return { hostId: call.input.hostId, executorId: call.input.executorId, nativeSource: call.input.source,
 source: { providerId: 'codex', nativeSessionId: call.input.source.nativeHandle.sessionId },
 items: [{ id: 'reply', kind: 'assistant-message', contentParts: [{ kind: 'text', text }] }], nextCursor: null, ...extra }
}
const row = (n: number) => document.querySelector<HTMLElement>(`[data-resume-key="native:local:codex:original-${n}"]`)!
async function open() {
 await act(async () => root.render(<NewTabSurface tabGroupId="group" />))
 await act(async () => document.querySelector<HTMLButtonElement>('.launcher-resume-trigger')!.click())
 expect(document.querySelectorAll('[role="option"]')).toHaveLength(30)
}
beforeEach(() => {
 calls.length = 0; vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); vi.stubGlobal('IntersectionObserver', TestObserver)
 container = document.createElement('div'); document.body.append(container); root = createClientUiRoot(container)
 useAppStore.setState({ config, activeWorkspaceId: 'project', sessions: [], recoveryCandidates: [], timelines: {}, agentNames: {},
 tabs: {}, layouts: {}, runtimeConnected: true, startupComplete: true, loading: false, warmTerminal: null })
 vi.spyOn(api.sessions, 'nativeSessions').mockImplementation(async input => ({ ...input, providerId: 'codex', availability: 'available',
 capabilities: { providerResume: true } as any, issues: [], sessions: sources.map((source, n) => ({ source, updatedAt: 3000 - n,
 ...(n === 2 ? {} : { title: 'Repeated real title' }) })) }))
 vi.spyOn(api.sessions, 'nativeHistoryPage').mockImplementation(input => new Promise((resolve, reject) => calls.push({ input, resolve, reject })))
 vi.spyOn(api.sessions, 'launchAgent').mockRejectedValue(new Error('Browsing cannot start a Run'))
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); useAppStore.setState(initial, true); vi.restoreAllMocks(); vi.unstubAllGlobals() })
it('reads only visible rows with two previews in flight, and preserves real titles and exact reply excerpts', async () => {
 await open(); expect(calls.map(c => c.input.source.nativeHandle.sessionId)).toEqual(['original-0'])
 await act(async () => observer.notify([0, 1, 2, 3]))
 expect(calls.map(c => c.input.source.nativeHandle.sessionId)).toEqual(['original-0', 'original-1', 'original-2'])
 await act(async () => observer.notify([0, 1, 2])) // remove queued 3 before a slot is available
 await act(async () => calls[1]!.resolve(page(calls[1]!, 'Original one reply')))
 expect(row(1).textContent).toContain('Reply · Original one reply'); expect(row(1).textContent).toContain('Repeated real title')
 expect(calls).toHaveLength(3); expect(row(2).textContent).toContain('Untitled conversation'); expect(row(20).textContent).toContain('Preview not read yet')
 await act(async () => calls[2]!.resolve(page(calls[2]!, 'Original two reply')))
 expect(row(2).textContent).toContain('Reply · Original two reply')
 await act(async () => observer.notify([20]))
 expect(calls.at(-1)!.input.source).toEqual(sources[20]); expect(calls).toHaveLength(4)
 expect(api.sessions.launchAgent).not.toHaveBeenCalled()
 expect(document.querySelector('.launcher-resume__scope button')!.getAttribute('aria-pressed')).toBe('true')
})
it('rejects another exact source and keeps selected full history independent from late previews', async () => {
 await open(); await act(async () => observer.notify([1, 2]))
 await act(async () => calls[1]!.resolve(page(calls[1]!, 'Wrong private reply', { nativeSource: sources[20] })))
 expect(row(1).textContent).toContain('Preview could not be read'); expect(document.body.textContent).not.toContain('Wrong private reply')
 await act(async () => row(2).click())
 const detail = calls.findLast(c => c.input.source.nativeHandle.sessionId === 'original-2')!
 await act(async () => detail.resolve(page(detail, 'Full selected reply', { items: [
 { id: 'input', kind: 'user-message', contentParts: [{ kind: 'text', text: 'Full original input' }] },
 { id: 'reply', kind: 'assistant-message', contentParts: [{ kind: 'text', text: 'Full selected reply' }] }] })))
 await act(async () => calls[2]!.resolve(page(calls[2]!, 'Bounded preview reply')))
 expect(document.querySelectorAll('.launcher-resume__message')).toHaveLength(2)
 expect(document.querySelector('.launcher-resume__detail')!.textContent).toContain('Full selected reply')
 expect(document.querySelector('.launcher-resume__detail')!.textContent).not.toContain('Bounded preview reply')
 expect(row(2).getAttribute('aria-selected')).toBe('true')
})
it('ignores closed reads and retains the global two-request budget across reopen', async () => {
 await open(); await act(async () => observer.notify([1, 2, 3]))
 await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="Close resume picker"]')!.click())
 await act(async () => calls[1]!.resolve(page(calls[1]!, 'Closed preview')))
 expect(calls).toHaveLength(3)
 await act(async () => document.querySelector<HTMLButtonElement>('.launcher-resume-trigger')!.click())
 await act(async () => observer.notify([1, 2, 3]))
 expect(calls).toHaveLength(5) // new detail + only one available preview slot
 await act(async () => calls[2]!.resolve(page(calls[2]!, 'Stale old preview')))
 await act(async () => observer.notify([1, 2, 3]))
 expect(calls).toHaveLength(6); expect(document.body.textContent).not.toContain('Stale old preview')
 expect(document.body.textContent).not.toContain('Closed preview')
})
it('releases a settled loading entry when adoption temporarily removes the native candidate', async () => {
 await open(); await act(async () => observer.notify([1, 2]))
 const pending = calls[1]!
 await act(async () => useAppStore.setState({ recoveryCandidates: [{ agentSessionId: 'adopted-1', hostId: 'local',
  workspacePath: _reshape_fixturePath("repo"), providerId: 'codex', executorId: 'codex', nativeSessionId: 'original-1', label: 'Adopted original',
  createdAt: _reshape_fixtureEpoch(0, 0, 1), updatedAt: _reshape_fixtureEpoch(0, 0, 4000), run: { runId: 'retained-adopted-run' }, capabilities: { providerResume: true } as any }] }))
 expect(row(1)).toBeNull()
 await act(async () => pending.resolve(page(pending, 'Completed while candidate absent')))
 await act(async () => useAppStore.setState({ recoveryCandidates: [] }))
 await act(async () => observer.notify([1]))
 expect(calls.filter(c => c.input.source.nativeHandle.sessionId === 'original-1')).toHaveLength(2)
 const reread = calls.at(-1)!
 await act(async () => reread.resolve(page(reread, 'Returned candidate original reply')))
 expect(row(1).textContent).toContain('Reply · Returned candidate original reply')
})
it('uses managed Core history and refuses a reply for another managed Session without disabling Resume', async () => {
 const managed = (id: string, n: number) => ({ agentSessionId: id, hostId: 'local', workspacePath: _reshape_fixturePath("repo"), providerId: 'codex' as const,
  executorId: 'codex', label: id, nativeSessionId: `provider-${id}`, createdAt: _reshape_fixtureEpoch(0, 0, 1), updatedAt: 5000 - n,
  run: { runId: `retained-${id}` }, capabilities: { providerResume: true } as any })
 useAppStore.setState({ recoveryCandidates: [managed('selected', 0), managed('original', 1), managed('other', 2)] })
 vi.mocked(api.sessions.nativeSessions).mockResolvedValue({ hostId: 'local', executorId: 'codex', providerId: 'codex',
  availability: 'available', capabilities: { providerResume: true } as any, sessions: [], issues: [] })
 vi.spyOn(api.sessions, 'historyPage').mockImplementation(async input => ({ agentSessionId: input.agentSessionId === 'other' ? 'wrong' : input.agentSessionId,
  source: { providerId: 'codex', nativeSessionId: `provider-${input.agentSessionId}` }, nextCursor: null,
  items: [{ id: 'request', kind: 'user-message', contentParts: [{ kind: 'text', text: 'Actual managed request' }] }] }))
 await act(async () => root.render(<NewTabSurface tabGroupId="group" />))
 await act(async () => document.querySelector<HTMLButtonElement>('.launcher-resume-trigger')!.click())
 await act(async () => observer.notify([0, 1, 2]))
 const original = document.querySelector<HTMLElement>('[data-resume-key="original"]')!, other = document.querySelector<HTMLElement>('[data-resume-key="other"]')!
 expect(original.textContent).toContain('Input · Actual managed request'); expect(other.textContent).toContain('Preview could not be read')
 expect(api.sessions.historyPage).toHaveBeenCalledWith({ hostId: 'local', agentSessionId: 'original' }, { limit: 100 })
 expect(document.querySelector<HTMLButtonElement>('.launcher-resume__footer .primary-button')!.disabled).toBe(false)
 expect(api.sessions.launchAgent).not.toHaveBeenCalled()
})
