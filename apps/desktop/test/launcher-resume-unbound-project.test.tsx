const { fixturePath: _reshape_fixturePath, fixtureEpoch: _reshape_fixtureEpoch } = await vi.hoisted(async () => await import("../../../test/fixture-values.mjs"))
// @vitest-environment happy-dom
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createClientUiRoot } from './helpers/client-ui-render'
import type { AgentSessionRecoveryCandidate, AppConfig, NativeAgentSessionsInput, NativeAgentSessionsResult } from '../src/shared/contracts'
import { NewTabSurface } from '../src/renderer/src/components/NewTabSurface'
import { LauncherResumePicker } from '../src/renderer/src/components/LauncherResumePicker'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: () => null }))
const config: AppConfig = {
  version: 9, hosts: [{ id: 'local', kind: 'local', label: 'This Mac' }],
  executors: { codex: { label: 'Codex', providerId: 'codex', command: 'codex', args: [], env: {}, injectAgentMuxGuide: true } },
  workspaces: [{ id: 'project', name: 'Project', hostId: 'local', path: _reshape_fixturePath("repo"), kind: 'folder' },
    { id: 'other', name: 'Other', hostId: 'local', path: _reshape_fixturePath("other"), kind: 'folder' }],
  appearance: { terminalTheme: 'graphite' },
  browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } }
}
const managed: AgentSessionRecoveryCandidate = { agentSessionId: 'managed-original', hostId: 'local', workspacePath: _reshape_fixturePath("repo"),
  providerId: 'codex', executorId: 'codex', label: 'Managed original', createdAt: _reshape_fixtureEpoch(0, 0, 1), updatedAt: _reshape_fixtureEpoch(0, 0, 2),
  run: { runId: 'retained-run' }, capabilities: { providerResume: true } as AgentSessionRecoveryCandidate['capabilities'] }
function catalogue(input: NativeAgentSessionsInput): NativeAgentSessionsResult {
  return { ...input, providerId: 'codex', availability: 'available', capabilities: managed.capabilities,
    sessions: [_reshape_fixturePath("repo"), _reshape_fixturePath("other")].map((workspacePath, index) => ({ title: index ? 'Other saved conversation' : 'External saved conversation',
      source: { nativeHandle: { kind: 'provider', providerId: 'codex', sessionId: `external-${index}`, transcriptPath: _reshape_fixturePath(`native/rollout-${index}.jsonl`) },
        workspacePath, revision: 'a'.repeat(64) }, updatedAt: 3000 - index })),
    issues: [{ code: 'AGENT_NATIVE_SESSION_METADATA_INVALID', message: 'Codex conversation metadata has no exact native identity and execution directory.' },
      { code: 'AGENT_NATIVE_SESSION_AMBIGUOUS', message: 'A different native conversation belongs to several Core Sessions.' }] }
}
const initial = useAppStore.getState()
let container: HTMLDivElement, root: Root
function buttons() { return [...document.querySelectorAll<HTMLButtonElement>('button')] }
function button(label: string | RegExp) {
  const found = buttons().find(item => typeof label === 'string' ? item.textContent?.trim() === label : label.test(item.textContent ?? ''))
  if (!found) throw new Error(`Missing button: ${label}`)
  return found
}
const rows = () => [...document.querySelectorAll<HTMLElement>('[role="option"]')]
async function click(element: HTMLElement) { await act(async () => element.click()) }
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div'); document.body.append(container); root = createClientUiRoot(container)
  useAppStore.setState({ config, activeWorkspaceId: null, sessions: [], recoveryCandidates: [managed], timelines: {}, agentNames: {},
    tabs: {}, layouts: {}, runtimeConnected: true, startupComplete: true, loading: false, warmTerminals: {} })
  vi.spyOn(api.sessions, 'nativeSessions').mockImplementation(async input => catalogue(input))
  vi.spyOn(api.sessions, 'nativeHistoryPage').mockImplementation(async input => ({ ...input,
    nativeSource: input.source, source: { providerId: 'codex', nativeSessionId: input.source.nativeHandle.sessionId },
    items: [{ id: 'original-record', kind: 'assistant-message', contentParts: [{ kind: 'text', text: 'Original saved reply' }] }], nextCursor: null }))
  vi.spyOn(api.sessions, 'historyPage').mockImplementation(async input => ({ agentSessionId: input.agentSessionId, source: { providerId: 'codex' }, items: [], nextCursor: null }))
  vi.spyOn(api.sessions, 'launchAgent').mockRejectedValue(new Error('Browsing must not start a Run'))
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); useAppStore.setState(initial, true); vi.restoreAllMocks() })
describe('Resume from a Launcher without a Project', () => {
  it('shows managed and external history with notices through the real NewTabSurface, including on reopening', async () => {
    await act(async () => root.render(<NewTabSurface tabGroupId="empty-group" />))
    await click(button('Resume'))
    expect(rows()).toHaveLength(3)
    expect(button(/^All projects/).getAttribute('aria-pressed')).toBe('true')
    expect(buttons().some(item => item.textContent?.startsWith('This project'))).toBe(false)
    expect(document.querySelector('.launcher-resume__footer')?.textContent).toContain('3 Sessions · all projects')
    expect(document.querySelector('.launcher-resume__catalog-notice')?.textContent).toContain('metadata has no exact native identity')
    await click(rows().find(row => row.textContent?.includes('External saved conversation'))!)
    expect(document.querySelector('.launcher-resume__detail')?.textContent).toContain('Original saved reply')
    expect(api.sessions.nativeHistoryPage).toHaveBeenCalledWith(expect.objectContaining({ source: catalogue({ hostId: 'local', executorId: 'codex' }).sessions[0]!.source }))
    await click(document.querySelector<HTMLButtonElement>('[aria-label="Close resume picker"]')!)
    await click(button('Resume'))
    expect(rows()).toHaveLength(3)
    expect(button(/^All projects/).getAttribute('aria-pressed')).toBe('true')
    expect(api.sessions.launchAgent).not.toHaveBeenCalled()
  })
  it('uses this Project from the real Launcher and shows external saved conversations without switching to All', async () => {
    useAppStore.setState({ activeWorkspaceId: 'project' })
    await act(async () => root.render(<NewTabSurface tabGroupId="project-group" />))
    await click(button('Resume'))
    expect(button(/^This project/).getAttribute('aria-pressed')).toBe('true')
    expect(rows()).toHaveLength(2)
    expect(rows().some(row => row.textContent?.includes('Other saved conversation'))).toBe(false)
    await click(rows().find(row => row.textContent?.includes('External saved conversation'))!)
    expect(document.querySelector('.launcher-resume__detail')?.textContent).toContain('Original saved reply')
    expect(document.querySelector('.launcher-resume__detail')?.textContent).toContain(_reshape_fixturePath("repo"))
    expect(api.sessions.launchAgent).not.toHaveBeenCalled()
  })
  it('keeps the current Project scope and explicit all-projects choice when a Workspace exists', async () => {
    await act(async () => root.render(<LauncherResumePicker workspace={config.workspaces[0]} />))
    await click(button('Resume'))
    expect(rows()).toHaveLength(2)
    expect(button(/^This project/).getAttribute('aria-pressed')).toBe('true')
    await click(button(/^All projects/)); expect(rows()).toHaveLength(3)
    await click(button(/^This project/)); expect(rows()).toHaveLength(2)
  })
  it('does not retain an empty Project filter when the Launcher loses its Workspace', async () => {
    await act(async () => root.render(<LauncherResumePicker workspace={config.workspaces[0]} />))
    await click(button('Resume')); expect(rows()).toHaveLength(2)
    await act(async () => root.render(<LauncherResumePicker />))
    expect(rows()).toHaveLength(3)
    expect(button(/^All projects/).getAttribute('aria-pressed')).toBe('true')
    expect(buttons().some(item => item.textContent?.startsWith('This project'))).toBe(false)
    expect(api.sessions.launchAgent).not.toHaveBeenCalled()
  })
})
