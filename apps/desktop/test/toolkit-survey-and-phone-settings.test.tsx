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
