// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ToolkitResultLink, OpenInSurveyButton } from '../src/renderer/src/components/toolkit/ToolkitResultLink'
import { BuiltinMobileConnectionSettings } from '../src/renderer/src/components/settings/BuiltinMobileConnectionSettings'
import { SettingsNavigation } from '../src/renderer/src/components/SettingsNavigation'
import { useAppStore } from '../src/renderer/src/store'
import { composerDOM } from './helpers/composer-dom-fixture'

const dom = composerDOM()
const original = useAppStore.getState().openUrlInSurvey
const opened = { state: 'opened' as const, browserId: 'survey-browser', reference: { displayWorkspaceId: 'scratch', groupId: 'g', tabId: 't', regionId: 'r' } }
beforeEach(() => { useAppStore.setState({ openUrlInSurvey: vi.fn(async () => opened) }) })
afterEach(() => { useAppStore.setState({ openUrlInSurvey: original }); vi.restoreAllMocks() })
const button = (label: string) => [...dom.container.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent?.trim() === label)

describe('Toolkit links open in Survey', () => {
  it('opens an http(s) link through the one Survey owner, once per press, and reports the outcome', async () => {
    await dom.render(<ToolkitResultLink label="Docs" url="https://example.org/docs" copy={() => {}} />)
    const open = useAppStore.getState().openUrlInSurvey as ReturnType<typeof vi.fn>
    await act(async () => button('Open in Survey')!.click())
    expect(open).toHaveBeenCalledExactlyOnceWith('https://example.org/docs')
    expect(dom.container.querySelector('.toolkit-result__survey-feedback')?.textContent).toBe('Opened in Survey.')
    await act(async () => button('Open in Survey')!.click())
    expect(open).toHaveBeenCalledTimes(2)
  })

  it('does not open a second Browser while the first opening is in flight', async () => {
    let finish!: (value: typeof opened) => void
    const open = vi.fn(() => new Promise<typeof opened>(resolve => { finish = resolve }))
    useAppStore.setState({ openUrlInSurvey: open })
    await dom.render(<ToolkitResultLink label="Docs" url="https://example.org/docs" copy={() => {}} />)
    const first = button('Open in Survey')!
    await act(async () => { first.click(); first.click() })
    expect(open).toHaveBeenCalledOnce()
    expect(button('Opening…')?.disabled).toBe(true)
    await act(async () => finish(opened))
    expect(button('Open in Survey')?.disabled).toBe(false)
  })

  it('offers nothing for links that are not web pages, and keeps an unconfirmed opening visible without retrying', async () => {
    await dom.render(<ToolkitResultLink label="Object" url="amux://agent/abc" copy={() => {}} />)
    expect(button('Open in Survey')).toBeUndefined()
    const open = vi.fn(async () => ({ state: 'unconfirmed' as const, browserId: null, reference: null, message: 'System page opening is unconfirmed.' }))
    useAppStore.setState({ openUrlInSurvey: open })
    await dom.render(<OpenInSurveyButton url="http://10.0.0.2:8443/#AgX" note="It connects as another device." />)
    expect(button('Open in Survey')?.title).toBe('It connects as another device.')
    await act(async () => button('Open in Survey')!.click())
    expect(dom.container.querySelector('.toolkit-result__survey-feedback[role="alert"]')?.textContent).toBe('System page opening is unconfirmed.')
    expect(open).toHaveBeenCalledOnce()
  })

  it.each(['opened', 'unconfirmed', 'failed'] as const)('keeps feedback and focus with its URL (%s)', async outcome => {
    const firstURL = 'https://example.org/first', nextURL = 'https://example.org/next'
    const open = vi.fn(async (url: string) => {
      if (url === firstURL && outcome === 'failed') throw Error('First opening failed')
      return url === firstURL && outcome === 'unconfirmed'
        ? { state: 'unconfirmed' as const, browserId: null, reference: null, message: 'First opening unconfirmed' } : opened
    })
    useAppStore.setState({ openUrlInSurvey: open })
    await dom.render(<ToolkitResultLink label="Docs" url={firstURL} copy={() => {}} />)
    await act(async () => button('Open in Survey')!.click())
    expect(dom.container.querySelector('.toolkit-result__survey-feedback')).not.toBeNull()
    const retained = button('Open in Survey')!
    await act(async () => retained.focus())
    await dom.render(<ToolkitResultLink label="Docs" url={nextURL} copy={() => {}} />)
    expect(button('Open in Survey')).toBe(retained)
    expect(document.activeElement).toBe(retained)
    expect(retained.disabled).toBe(false)
    expect(dom.container.querySelector('.toolkit-result__survey-feedback')).toBeNull()
    await act(async () => retained.click())
    expect(open.mock.calls.map(([url]) => url)).toEqual([firstURL, nextURL])
  })

  it.each((['opened', 'unconfirmed', 'failed'] as const).flatMap(outcome =>
    (['waiting', 'finished'] as const).map(timing => [outcome, timing] as const)))
  ('keeps the selected URL actionable while a previous opening is in flight (%s, %s)', async (outcome, timing) => {
    const firstURL = 'https://example.org/first', nextURL = 'https://example.org/next'
    const nextOutcome = { state: 'unconfirmed' as const, browserId: null, reference: null, message: 'Next original opening is unconfirmed' }
    let finishFirst!: (value: typeof opened | typeof nextOutcome) => void, failFirst!: (reason: Error) => void
    let finishNext!: (value: typeof nextOutcome) => void
    const first = new Promise<typeof opened | typeof nextOutcome>((resolve, reject) => { finishFirst = resolve; failFirst = reject })
    const next = new Promise<typeof nextOutcome>(resolve => { finishNext = resolve })
    const open = vi.fn((url: string) => url === firstURL ? first : next)
    useAppStore.setState({ openUrlInSurvey: open })
    await dom.render(<OpenInSurveyButton url={firstURL} />)
    await act(async () => button('Open in Survey')!.click())
    await dom.render(<OpenInSurveyButton url={nextURL} />)
    const retained = button('Open in Survey')!
    expect(retained.disabled).toBe(false)
    await act(async () => { retained.click(); retained.click() })
    expect(open.mock.calls.map(([url]) => url)).toEqual([firstURL, nextURL])
    expect(button('Opening…')?.disabled).toBe(true)
    if (timing === 'finished') await act(async () => finishNext(nextOutcome))
    await act(async () => {
      if (outcome === 'failed') failFirst(Error('Late first opening failed'))
      else finishFirst(outcome === 'opened' ? opened : { ...nextOutcome, message: 'Late first opening unconfirmed' })
    })
    if (timing === 'waiting') {
      expect(button('Opening…')?.disabled).toBe(true)
      expect(dom.container.querySelector('.toolkit-result__survey-feedback')).toBeNull()
      await act(async () => finishNext(nextOutcome))
    }
    expect(button('Open in Survey')).toBe(retained)
    expect(dom.container.querySelector('.toolkit-result__survey-feedback[role="alert"]')?.textContent).toBe(nextOutcome.message)
    expect(open).toHaveBeenCalledTimes(2)
  })
})

describe('the phone connection tool settings', () => {
  it('leads with a direct way to the phone settings', async () => {
    const navigation = { open: vi.fn(), openToolkit: vi.fn() }
    await dom.render(<SettingsNavigation.Provider value={navigation as never}>
      <BuiltinMobileConnectionSettings preferences={{ enabled: true, statusBar: 'icon' }} active onSave={async () => {}} />
    </SettingsNavigation.Provider>)
    const entry = dom.container.querySelector<HTMLButtonElement>('.toolkit-settings__identity [data-phone-settings]')
    expect(entry?.textContent?.trim()).toBe('Open phone settings')
    await act(async () => entry!.click())
    expect(navigation.open).toHaveBeenCalledExactlyOnceWith('mobile')
  })
})
