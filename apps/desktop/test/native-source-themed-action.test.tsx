import { fixturePath as _reshape_fixturePath, fixtureEpoch as _reshape_fixtureEpoch } from "../../../test/fixture-values.mjs"
// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { GRAPHITE_THEME, mountThemeRuntime, previewTheme } from '@agentmux/client-ui/theme'
import { semanticIconHref } from '@agentmux/client-ui/icons'
import type { SessionSnapshot } from '../src/shared/contracts'
import { AgentRegionHeader } from '../src/renderer/src/components/AgentRegionHeader'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { composerDOM } from './helpers/composer-dom-fixture'
const dom = composerDOM(), initial = useAppStore.getState(); let cleanup: () => void
const old = { kind: 'provider' as const, providerId: 'codex' as const, sessionId: 'original-native', transcriptPath: _reshape_fixturePath("private/tmp/original-native.jsonl") }
const candidate = { ...old, sessionId: 'candidate-native', transcriptPath: _reshape_fixturePath("private/tmp/candidate-native.jsonl") }
const control = { kind: 'agent' as const, hostId: 'local', agentSessionId: 'same-session', run: { runId: 'same-run' } }
const session = { id: control.agentSessionId, kind: 'agent', providerId: 'codex', executorId: 'private', hostId: 'local', workspacePath: _reshape_fixturePath("private/tmp/theme-icon-proof"), label: 'Private Agent', createdAt: _reshape_fixtureEpoch(0, 0, 1), updatedAt: _reshape_fixtureEpoch(0, 0, 50), control, processState: 'running', status: { state: 'running', source: 'run-process', observedAt: _reshape_fixtureEpoch(0, 0, 1) }, nativeHandle: old, observedNativeHandle: candidate, nativeSourceObservation: { state: 'changed', run: control.run, observedAt: _reshape_fixtureEpoch(0, 0, 100), reason: 'Authoritative current candidate differs.' } } as Extract<SessionSnapshot, { kind: 'agent' }>
beforeEach(() => { cleanup = mountThemeRuntime(window); useAppStore.setState({ sessions: [session] }) })
afterEach(() => { cleanup(); useAppStore.setState(initial, true); vi.restoreAllMocks() })
const action = (label: string) => {
  const result = [...document.querySelectorAll<HTMLElement>('[role=menuitem],button')].find(node => node.textContent?.trim() === label)
  expect(result, `Nonempty native action ${label}`).toBeDefined(); return result!
}
it('the original Region menu themes Review independently and keeps cancellation and exact confirmation of the current native candidate', async () => {
  const confirm = vi.spyOn(api.sessions, 'confirmNativeSession').mockResolvedValue({ session: {} as never, persisted: true, current: true } as never)
  await dom.render(<AgentRegionHeader name="Private Agent" executorLabel="Private" sessionId={session.id} sessionKind="agent" executionHost={{ label: 'This Mac', id: 'local', cwd: session.workspacePath, configured: true }} regionId="original-region" readOnly={false} onHistory={undefined} nativeSession={session}/>)
  await act(async () => dom.container.querySelector('.agent-region-header__more')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })))
  const review = action('Review source change…')
  expect(review.querySelector('use')?.getAttribute('href')).toBe(semanticIconHref('action.review-source'))
  const custom = structuredClone(GRAPHITE_THEME); custom.id = 'custom.native-review'; custom.name = 'Native review'; custom.icons = { 'action.review-source': { kind: 'paths', paths: [{ d: 'M4 4H20V20H4Z' }] } }
  await act(async () => { expect(previewTheme(custom).applied).toBe(true) })
  expect(action('Review source change…')).toBe(review)
  expect(document.getElementById(semanticIconHref('action.review-source').slice(1))?.querySelector('path')?.getAttribute('d')).toBe('M4 4H20V20H4Z')
  expect(confirm).not.toHaveBeenCalled(); expect(useAppStore.getState().sessions[0]?.nativeHandle).toEqual(old)
  await act(async () => review.click())
  expect(document.querySelector('[data-native-source-review]')?.textContent).toContain(old.sessionId)
  expect(document.querySelector('[data-native-source-review]')?.textContent).toContain(candidate.sessionId)
  await act(async () => action('Cancel source change').click())
  expect(confirm).not.toHaveBeenCalled(); expect(useAppStore.getState().sessions[0]?.nativeHandle).toEqual(old)
  await act(async () => action('Review source change…').click())
  await act(async () => action('Confirm this native source').click())
  expect(confirm).toHaveBeenCalledOnce()
  expect(confirm.mock.calls[0]?.[0]).toEqual(control)
  expect(confirm.mock.calls[0]?.[1]).toMatchObject({ agentSessionId: session.id, expectedRun: control.run, expectedNativeHandle: old, candidateNativeHandle: candidate, expectedObservationAt: _reshape_fixtureEpoch(0, 0, 100), operationId: expect.any(String) })
})
