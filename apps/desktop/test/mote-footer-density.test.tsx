// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { observeNativeOverlayRegions } from '../src/renderer/src/lib/native-overlay-regions'
import { useAppStore } from '../src/renderer/src/store'
import { PMO_TEAMS_TOPIC_ID } from '../src/shared/scratch-topics'
import { allStyleRules } from './helpers/styles'
import { createMoteApp, moteClick, motePointer, settleMoteApp, type MoteAppFixture } from './fixtures/mote-app'
import { defaultTab, savedMoteKey } from './fixtures/mote-workface'

let app: MoteAppFixture
beforeEach(() => { app = createMoteApp() })
afterEach(async () => { await app.dispose() })

describe('actual window footer circle and original shortcut', () => {
  it('portals exactly one original launcher while every other footer action retains its owner', async () => {
    useAppStore.setState({ environmentWarning: 'Fixture directory service unavailable' })
    await app.mount()
    const footer = app.container.querySelector<HTMLElement>('footer.window-status-bar')!, entry = app.entry()
    const host = entry.closest('[data-overlay-host]')!, slot = entry.closest('.surface-navigation__slot--launcher')!
    expect(footer).not.toBeNull(); expect(host).not.toBeNull(); expect(slot).not.toBeNull()
    expect(app.container.contains(entry)).toBe(false)
    expect(slot.closest('[data-overlay-layer="window-chrome"]')).not.toBeNull()
    expect(document.querySelectorAll('[data-pmo-teams-topic-launcher]')).toHaveLength(1)
    expect(slot.querySelectorAll('button')).toHaveLength(1)
    const paint = entry.querySelector<HTMLElement>('.pmo-teams-topic-compact-launcher__surface')!
    expect(paint).not.toBeNull(); expect(paint.dataset.state).toBe('open')
    expect(entry.hasAttribute('data-state')).toBe(false); expect(entry.dataset.motePresentation).toBe('closed')
    expect(entry.getAttribute('popoverTarget')).toBe(app.panel().id)
    expect(paint.closest('button[popoverTarget]')).toBe(entry)
    expect(entry.parentElement?.hasAttribute('data-state')).toBe(false)
    expect(slot.hasAttribute('data-state')).toBe(false)
    const controls = Array.from(footer.querySelectorAll<HTMLButtonElement>('button'))
    expect(controls.length).toBeGreaterThan(4)
    expect(controls.map(button => button.getAttribute('aria-label'))).toContain('Settings')
    expect(controls.map(button => button.getAttribute('aria-label'))).toContain('Show performance and resource owners')
    expect(controls.some(button => button.closest('.window-status-bar__utilities'))).toBe(true)
    for (const control of controls) expect(control.closest('[data-overlay-layer]')).toBeNull()
    await moteClick(footer.querySelector<HTMLButtonElement>('[aria-label="Settings"]')!)
    expect(app.container.querySelector('[data-settings-page]')).not.toBeNull()
    expect(app.entry()).toBe(entry)
  })

  it('uses one complete rectangular HTML invoker for hover/click and preserves that focused button across activation', async () => {
    await app.mount()
    const button = app.entry(), paint = button.querySelector<HTMLElement>('.pmo-teams-topic-compact-launcher__surface')!, before = useAppStore.getState()
    expect(button.tagName).toBe('BUTTON'); expect(button.getAttribute('popoverTarget')).toBe(app.panel().id)
    expect(paint).not.toBeNull(); expect(paint.closest('button[popoverTarget]')).toBe(button)
    const css = allStyleRules(), rules = [...css.matchAll(/([^{}]+)\{([^{}]+)\}/g)]
      .filter(match => match[1]!.trim() === '.pmo-teams-topic-compact-launcher__button')
    expect(rules).toHaveLength(1)
    expect(rules[0]![2]).toContain('border-radius: 0'); expect(rules[0]![2]).toContain('background: transparent')
    const stored = window.localStorage.getItem(savedMoteKey)
    await motePointer(button, 'over'); await settleMoteApp()
    expect(app.panel().dataset.motePresentation).toBe('preview')
    expect(window.localStorage.getItem(savedMoteKey)).toBe(stored)
    expect(app.ensureMote).not.toHaveBeenCalled()
    await moteClick(button)
    expect(app.panel().dataset.motePresentation).toBe('pinned')
    expect(app.panel().dataset.moteTargetTopic).toBe(PMO_TEAMS_TOPIC_ID)
    expect(app.panel().dataset.moteTargetTab).toBe(defaultTab.id)
    expect(app.ensureMote).toHaveBeenCalledOnce()
    await act(async () => { button.focus(); button.click() }); await settleMoteApp()
    expect(app.panel().dataset.motePresentation).toBe('closed')
    expect(document.activeElement).toBe(button)
    await act(async () => button.click()); await settleMoteApp()
    expect(app.panel().dataset.motePresentation).toBe('pinned')
    expect(app.entry()).toBe(button)
    expect(useAppStore.getState().viewModes).toBe(before.viewModes)
    expect(useAppStore.getState().agentFocus.execution).toEqual(before.agentFocus.execution)
    expect(useAppStore.getState().agentComposerDrafts).toBe(before.agentComposerDrafts)
    expect(useAppStore.getState().agentSteerQueues).toBe(before.agentSteerQueues)
    expect(app.launch).not.toHaveBeenCalled(); expect(app.stop).not.toHaveBeenCalled()
    expect(app.send).not.toHaveBeenCalled(); expect(app.enqueue).not.toHaveBeenCalled()
  })

  it('feeds only the actual opaque circle through the existing generic native collector, with explicit px radius', async () => {
    await app.mount()
    const entry = app.entry(), paint = entry.querySelector<HTMLElement>('.pmo-teams-topic-compact-launcher__surface')!, hitbox = entry.parentElement!, wrapper = entry.closest('.window-overlay-host__entry')!
    expect(paint).not.toBeNull(); expect(paint.closest('button[popoverTarget]')).toBe(entry)
    // happy-dom has no layout/compositor. Feed actual mounted product DOM
    // dimensions and paint from production CSS into the unchanged collector.
    const css = allStyleRules()
    const rules = [...css.matchAll(/([^{}]+)\{([^{}]+)\}/g)].filter(match => match[1]!.trim() === '.pmo-teams-topic-compact-launcher__surface')
    expect(rules).toHaveLength(1)
    const styles = rules[0]![2]!, width = Number(styles.match(/\bwidth:\s*(\d+)px/)?.[1]), height = Number(styles.match(/\bheight:\s*(\d+)px/)?.[1])
    const radius = Number(styles.match(/border-radius:\s*(\d+)px/)?.[1])
    expect(width).toBeGreaterThan(0); expect(height).toBe(width); expect(radius).toBe(width / 2)
    expect(styles).toContain('background: var(--surface-2)')
    expect(styles).toContain('pointer-events: none')
    paint.style.backgroundColor = 'rgb(40, 49, 45)'; paint.style.borderRadius = radius + 'px'
    const bounds = { x: 12, y: 400, width, height }
    paint.getBoundingClientRect = () => ({ ...bounds, left: bounds.x, top: bounds.y, right: bounds.x + width, bottom: bounds.y + height, toJSON() {} })
    const wrapperGeometry = vi.spyOn(wrapper, 'getBoundingClientRect'), hitboxGeometry = vi.spyOn(hitbox, 'getBoundingClientRect'), invokerGeometry = vi.spyOn(entry, 'getBoundingClientRect')
    const nativeStage = document.createElement('div'); nativeStage.dataset.nativeBrowserStage = 'behind'
    app.container.append(nativeStage); const stageGeometry = vi.spyOn(nativeStage, 'getBoundingClientRect')
    const publish = vi.fn(), collector = observeNativeOverlayRegions(document.body, () => 1, publish)
    try {
      expect(publish.mock.calls).toEqual([[ [{ id: 'chrome-1', bounds, radius }], undefined]])
      expect(wrapperGeometry).not.toHaveBeenCalled(); expect(hitboxGeometry).not.toHaveBeenCalled()
      expect(invokerGeometry).not.toHaveBeenCalled()
      expect(stageGeometry).not.toHaveBeenCalled()
      expect(nativeStage.dataset.nativeBrowserStage).toBe('behind')
      expect(entry.dataset.motePresentation).toBe('closed')
    } finally { collector.dispose(); nativeStage.remove() }
  })
})
