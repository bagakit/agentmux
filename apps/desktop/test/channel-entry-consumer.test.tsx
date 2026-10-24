// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
vi.hoisted(() => vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true))
vi.mock('react-resizable-panels', async () => { const { createRequire } = await import('node:module'); return createRequire(import.meta.url)('../node_modules/react-resizable-panels/dist/react-resizable-panels.browser.development.cjs.js') })
vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: () => <div>Controlled terminal rendering</div> }))
import { connectorJourneyFixture } from './fixtures/connector-journey'
import { moteConnectionJourney } from './fixtures/mote-connection-journey'
import { moteClick, settleMoteApp } from './fixtures/mote-app'
import { DiscordAdapter } from '../../../packages/connectors/src/adapters/discord/index'
import { discordConfig, discordTransport } from '../../../packages/connectors/test/fixtures/discord'
import { useAppStore } from '../src/renderer/src/store'
import type { ConnectionRecord } from '@agentmux/core/connections'

async function wait(check: () => void) { await vi.waitFor(async () => { await act(async () => {}); check() }, { timeout: 6000 }) }
async function clickText(label: string, selector = '[role="dialog"] button') {
  const button = [...document.querySelectorAll<HTMLElement>(selector)].find(item => item.textContent?.trim() === label)
  expect(button, label).toBeDefined()
  const folded: HTMLDetailsElement[] = []
  for (let parent = button!.parentElement; parent; parent = parent.parentElement) if (parent instanceof HTMLDetailsElement && !parent.open) folded.push(parent)
  for (const details of folded.reverse()) { await moteClick(details.querySelector('summary')!); expect(details.open).toBe(true) }
  await moteClick(button!)
}

describe('original Agent channel binding entry', () => {
  let wire: Awaited<ReturnType<typeof discordTransport>>, adapter: DiscordAdapter
  beforeEach(async () => {
    wire = await discordTransport(); adapter = new DiscordAdapter({ http: wire.http })
    const browser = window as unknown as { happyDOM: { settings: { fetch: { disableSameOriginPolicy: boolean } } } }
    browser.happyDOM.settings.fetch.disableSameOriginPolicy = true
  })
  const f = connectorJourneyFixture({ connection: discordConfig, adapter: () => adapter })
  afterEach(async () => { await wire.close(); (window as any).happyDOM.settings.fetch.disableSameOriginPolicy = false })

  it('binds a Discord native channel from the actual Agent menu and presents the leaf name while unsupported creation preserves the original draft and input', async () => {
    await f.mount(); await f.journey('existing')
    const newGroup = document.querySelector<HTMLButtonElement>('[aria-label="New group"]')!
    expect(newGroup.disabled).toBe(true)
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Group creation is unavailable for this application')
    await wait(() => expect(wire.calls.some(call => call.path === '/guilds/500/channels')).toBe(true))
    await f.fill('Existing group ID', '300')
    await wait(() => expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Original channel'))
    const checkbox = document.querySelector<HTMLInputElement>('.agent-connector-check input')!
    await moteClick(checkbox); await f.button('Connect group')
    await wait(() => expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Group saved'))
    const [binding] = (await f.services.connections.bindings!.list({})).bindings
    expect(binding).toMatchObject({ connectionId: discordConfig.connectionId, application: discordConfig.application, externalConversationId: '300', agentSessionId: 'original-agent' })
    expect((await f.services.connections.bindings!.inspect({ bindingId: binding!.bindingId })).grants).toEqual([])
    await f.button('Close')
    const trigger = document.querySelector<HTMLButtonElement>('[data-workbench-region-id="original-region"] [data-channel-entry="discord"]')!
    await wait(() => expect(trigger.title).toContain('Original channel'))
    expect(trigger.title).toContain('Discord')
    await act(async () => { trigger.focus(); trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })) })
    await wait(() => expect(document.querySelector('.connector-header-menu__item')?.getAttribute('aria-label')).toContain('300'))
    expect(document.querySelector('.connector-header-menu__item')?.getAttribute('aria-label')).toContain(discordConfig.connectionId)
    expect(f.calls.some(call => call.method === 'connection.room.create')).toBe(false)
    expect(f.original.create).not.toHaveBeenCalled(); expect(f.original.addMembers).not.toHaveBeenCalled()
    expect(useAppStore.getState().agentComposerDrafts['original-agent']).toBe('Keep the original draft 中')
    const input = document.querySelector<HTMLElement>('[data-workbench-region-id="original-region"] [role="textbox"]')!
    expect(input.getAttribute('contenteditable')).toBe('true')
    await f.original.unchanged()
  }, 25_000)
})

describe('actual App channel Settings navigation', () => {
  let f: Awaited<ReturnType<typeof moteConnectionJourney>>
  beforeEach(async () => {
    f = await moteConnectionJourney()
    await f.services.connections.configure({ operationId: 'exact-discord', expectedRevision: null, connection: { ...discordConfig, credentialRef: 'unresolved-native-reference' } })
  })
  afterEach(async () => { await f.dispose() })

  async function openOriginalSettings(beforeNavigate?: () => void) {
    await f.mount()
    const trigger = document.querySelector<HTMLElement>('[data-workbench-region-id="default-region"] [data-channel-entry="discord"]')!
    await act(async () => { trigger.focus(); trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })) })
    await wait(() => expect(document.querySelector('.connector-header-menu')).not.toBeNull())
    await clickText('Connect a group', '.connector-header-menu [role="menuitem"]')
    await wait(() => expect(document.querySelector('[role="dialog"]')).not.toBeNull())
    const choice = document.querySelector<HTMLElement>('[aria-label="Group application"]')!
    await moteClick(choice)
    await wait(() => expect(document.querySelector('[role="menuitemradio"][data-value="discord-connection"]')).not.toBeNull())
    await moteClick(document.querySelector<HTMLElement>('[role="menuitemradio"][data-value="discord-connection"]')!)
    await wait(() => expect(choice.dataset.value).toBe(discordConfig.connectionId))
    beforeNavigate?.()
    await clickText('Application settings')
    await settleMoteApp()
  }

  it('returns the selected Discord identity to its own saved Settings pane through the actual App route without changing the service or dropping drafts', async () => {
    const before = await f.services.connections.service!.get()
    await openOriginalSettings()
    await wait(() => expect(document.querySelector('[data-settings-pane="discord"] [data-connection-check]')).not.toBeNull())
    const pane = document.querySelector('[data-settings-pane="discord"]')!
    const facts = pane.querySelector('[aria-label="Saved identity facts"]')!
    expect(facts.textContent).toContain('App ID'); expect(facts.querySelector('code')?.textContent).toBe('100')
    expect(pane.textContent).toContain('Discord bot'); expect(pane.textContent).not.toContain('Robot A')
    expect(await f.services.connections.service!.get()).toEqual(before)
    expect(f.connections.mock.calls.some(([method]) => method === 'connection.service.configure' || method === 'connection.bind')).toBe(false)
    expect(f.app.stop).not.toHaveBeenCalled(); expect(f.app.launch).not.toHaveBeenCalled()
  }, 25_000)
  it('keeps an unavailable exact settings target unknown, preserves the original workface and recovers the same identity without choosing another bot', async () => {
    await f.services.connections.configure({ operationId: 'other-discord', expectedRevision: null,
      connection: { ...discordConfig, connectionId: 'other-discord', application: { ...discordConfig.application, appId: '101' }, label: 'Other saved bot' } })
    const forward = f.connections.getMockImplementation()!
    let omitOriginal = false
    f.connections.mockImplementation(async (method, input) => {
      const result = await forward(method, input)
      if (method === 'connection.ls' && omitOriginal) return { connections: (result as { connections: ConnectionRecord[] }).connections.filter(record => record.config.connectionId !== discordConfig.connectionId) } as never
      return result
    })
    await openOriginalSettings(() => { omitOriginal = true })
    await wait(() => expect(document.querySelector('[data-settings-pane="discord"] [data-channel-target-issue]')).not.toBeNull())
    const pane = document.querySelector('[data-settings-pane="discord"]')!
    expect(pane.querySelector('[data-channel-target-issue]')?.textContent).toContain(discordConfig.connectionId)
    expect(pane.querySelector('[data-channel-target-issue]')?.textContent).toContain('discord.com · 100')
    expect(pane.querySelector('[data-connection="other-discord"]')).not.toBeNull()
    expect(pane.querySelector('[data-connection-check]')).toBeNull()
    expect((await f.services.connections.inspect({ connectionId: discordConfig.connectionId })).connection?.config.application).toEqual(discordConfig.application)
    omitOriginal = false
    await moteClick(pane.querySelector<HTMLElement>('[data-channel-target-issue] button')!)
    await wait(() => expect(pane.querySelector('[data-connection-check]')).not.toBeNull())
    expect(pane.querySelector('[data-channel-target-issue]')).toBeNull()
    expect(pane.textContent).toContain('Discord bot'); expect(pane.textContent).not.toContain('Other saved bot')
    expect(f.app.stop).not.toHaveBeenCalled(); expect(f.app.launch).not.toHaveBeenCalled()
    expect(f.connections.mock.calls.some(([method]) => method === 'connection.bind' || method === 'connection.grant' || method === 'connection.service.configure')).toBe(false)
  }, 25_000)

})
