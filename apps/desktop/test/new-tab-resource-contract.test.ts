import { warmCandidates } from './helpers/reusable-shell-candidates'
import { fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: () => null }))
import { DESKTOP_ACTIONS, DESKTOP_ACTION_ATTRIBUTE, DESKTOP_SESSION_ATTRIBUTE } from '../src/shared/desktop-actions'
import { NewTabSurface } from '../src/renderer/src/components/NewTabSurface'
import { useAppStore, warmTerminalKey } from '../src/renderer/src/store'
import { useLauncherState } from '../src/renderer/src/lib/launcher-state'
import { composerDOM, composerSession } from './helpers/composer-dom-fixture'

const dom = composerDOM()
const launcherBefore = useLauncherState.getState()
const session = { ...composerSession('warm-run'), kind: 'terminal' as const, providerId: null,
  control: { kind: 'terminal' as const, hostId: 'local', runId: 'warm-run', run: { runId: 'warm-run' } } }
beforeEach(async () => { await act(async () => useLauncherState.setState({ sections: {}, drafts: {}, executors: {} })) })
afterEach(async () => { await act(async () => useLauncherState.setState(launcherBefore, true)) })

async function mount(mode: 'ready' | 'pending' | 'sibling' = 'ready') {
  const key = warmTerminalKey('local', _hygiene_fixturePath("repo"))
  const current = { ...session, id: 'current-warm-run', control: { ...session.control,
    runId: 'current-warm-run', run: { runId: 'current-warm-run' } } }
  useAppStore.setState({ activeWorkspaceId: 'workspace', recoveryCandidates: [], hostChecks: {}, executorDetections: {},
    prewarmTerminal: vi.fn(), detectExecutors: vi.fn().mockResolvedValue(undefined),
    warmTerminals: { [key]: [{ key, ownerLauncherId: mode === 'sibling' ? 'region:someone-else' : 'group:group',
      ready: Promise.resolve(session), session: mode === 'pending' ? null : session },
      ...(mode === 'sibling' ? [{ key, ownerLauncherId: 'group:group', ready: Promise.resolve(current), session: current }] : [])] } })
  await dom.render(createElement(NewTabSurface, { tabGroupId: 'group' }))
}
const claim = () => dom.container.querySelector<HTMLButtonElement>(`[${DESKTOP_ACTION_ATTRIBUTE}="${DESKTOP_ACTIONS.claimReusableTerminal}"]`)!

describe('New Tab resource action contract through its original mounted work surface', () => {
  it('exposes the exact ready reusable Terminal and the Browser action after an explicit expansion', async () => {
    await mount()
    expect(claim()).not.toBeNull()
    expect(claim().getAttribute(DESKTOP_SESSION_ATTRIBUTE)).toBe('warm-run')
    expect(claim().getAttribute('aria-label')).toBe('Open reusable Terminal in tab')
    expect(dom.container.querySelector(`[${DESKTOP_ACTION_ATTRIBUTE}="${DESKTOP_ACTIONS.openBrowser}"]`)).toBeNull()
    await dom.click('[aria-label="Expand Browser"]')
    const browser = dom.container.querySelector(`[${DESKTOP_ACTION_ATTRIBUTE}="${DESKTOP_ACTIONS.openBrowser}"]`)
    expect(browser?.getAttribute('aria-label')).toBe('Go to Browser address or search')
    expect(dom.container.querySelector('[aria-label="Browser address or search"]')).not.toBeNull()
  })

  it('does not advertise a ready Session identity while the reusable Terminal is pending', async () => {
    await mount('pending')
    expect(claim()).not.toBeNull()
    expect(claim().hasAttribute(DESKTOP_SESSION_ATTRIBUTE)).toBe(false)
    expect(claim().getAttribute('aria-label')).toBe('Open Terminal')
    expect(dom.container.querySelector('.launcher-terminal-pending')?.textContent).toContain('Preparing a reusable host shell')
  })

  it('advertises its own reusable Session while preserving the sibling Launcher candidate', async () => {
    await mount('sibling')
    expect(claim()).not.toBeNull()
    expect(claim().getAttribute(DESKTOP_SESSION_ATTRIBUTE)).toBe('current-warm-run')
    expect(claim().disabled).toBe(false)
    expect(warmCandidates(_hygiene_fixturePath("repo"))).toHaveLength(2)
    expect(warmCandidates(_hygiene_fixturePath("repo"))[0]?.ownerLauncherId).toBe('region:someone-else')
    expect(warmCandidates(_hygiene_fixturePath("repo"))[0]?.session?.control.run.runId).toBe('warm-run')
  })
})
