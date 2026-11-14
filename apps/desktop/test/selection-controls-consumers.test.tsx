// @vitest-environment happy-dom
import { act, useState, type ReactNode } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { MarkdownReadingLayoutControl, type MarkdownReadingLayout, type MarkdownReadingLayoutValue } from '@agentmux/client-ui/components/MarkdownReadingLayout'
import { Tabs } from '@agentmux/client-ui/components/Tabs'
import { MailboxNavigation } from '../src/renderer/src/components/MailboxNavigation'
import { ConnectorGroupDetails, ConnectorGroupDetailsHeader, type ConnectorGroupSection } from '../src/renderer/src/components/ConnectorGroupDetails'
import { GlobalSystemNotices } from '../src/renderer/src/components/GlobalSystemNotices'
import { PerformanceOverview } from '../src/renderer/src/components/performance/PerformanceOverview'
import { ProfileNetworkRoute } from '../src/renderer/src/components/settings/BrowserProfileNetwork'
import { createClientUiRoot } from './helpers/client-ui-render'
import { toggleNotificationCenter } from './helpers/notification-center'
import type { BrowserProfileSummary } from '../src/shared/contracts'

let host: HTMLDivElement
let root: ReturnType<typeof createClientUiRoot>

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  host = document.createElement('div')
  document.body.append(host)
  root = createClientUiRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
})

const render = (node: ReactNode) => act(async () => root.render(node))
const select = <T extends HTMLElement = HTMLButtonElement>(query: string, scope: ParentNode = host) => {
  const node = scope.querySelector<T>(query)
  expect(node, 'Mounted product control ' + query).not.toBeNull()
  return node!
}
const click = (button: HTMLButtonElement) => act(async () => button.click())

async function press(button: HTMLButtonElement, key: string, init?: KeyboardEventInit) {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })
  await act(async () => {
    button.focus()
    button.dispatchEvent(event)
  })
  return event
}

it('moves the original Mailbox section once and keeps one entry in the tab order', async () => {
  const onSelect = vi.fn()
  const items = [
    { key: 'messages', label: 'Messages', description: 'Show messages', icon: null, count: 2 },
    { key: 'history', label: 'History', description: 'Show history', icon: null, count: 0 },
  ] as const
  function Mailbox() {
    const [value, setValue] = useState<'messages' | 'history'>('messages')
    return <>
      <MailboxNavigation id="mailbox" selected={value} items={items} onSelect={next => { onSelect(next); setValue(next) }} />
      {items.map(item => <section key={item.key} id={'mailbox-' + item.key} role="tabpanel"
        aria-labelledby={'mailbox-' + item.key + '-tab'} hidden={value !== item.key}>{item.label}</section>)}
    </>
  }
  await render(<Mailbox />)
  const messages = select('#mailbox-messages-tab')
  const history = select('#mailbox-history-tab')
  expect((await press(messages, 'ArrowRight')).defaultPrevented, 'Mailbox consumes its navigation key').toBe(true)
  expect(document.activeElement, 'Mailbox moves focus into the original history tab').toBe(history)
  expect(onSelect, 'Mailbox activates the original tab once').toHaveBeenCalledExactlyOnceWith('history')
  expect(history.getAttribute('aria-selected')).toBe('true')
  const panel = document.getElementById(history.getAttribute('aria-controls')!)!
  expect(panel.hidden).toBe(false)
  expect(panel.getAttribute('aria-labelledby')).toBe(history.id)
  expect(host.querySelectorAll('[role="tab"][tabindex="0"]')).toHaveLength(1)
  expect((await press(history, 'ArrowRight', { isComposing: true })).defaultPrevented).toBe(false)
  expect(onSelect).toHaveBeenCalledTimes(1)
  await press(history, 'Home')
  expect(document.activeElement).toBe(messages)
})

it('keeps a Connector form mounted with its original draft and focus order', async () => {
  function Connector() {
    const [value, setValue] = useState<ConnectorGroupSection>('members')
    return <>
      <ConnectorGroupDetailsHeader id="connection" identity={null} relationship={null} configuration={null}
        section={value} onSection={setValue} />
      <ConnectorGroupDetails id="connection" section={value} activity={null} sharing={<input aria-label="Share draft" />}
        members={<input aria-label="Membership draft" defaultValue="Original draft" />} joining={null} />
    </>
  }
  await render(<Connector />)
  const draft = select<HTMLInputElement>('[aria-label="Membership draft"]')
  const members = select('#connection-members-tab')
  const sharing = select('#connection-sharing-tab')
  await press(members, 'ArrowRight')
  expect(document.activeElement).toBe(sharing)
  expect(select<HTMLElement>('#connection-sharing-panel').hidden).toBe(false)
  expect(select<HTMLElement>('#connection-members-panel').hidden).toBe(true)
  await press(sharing, 'ArrowLeft')
  expect(select('[aria-label="Membership draft"]')).toBe(draft)
  expect(draft.value).toBe('Original draft')
})

it('updates the live Notification panel relationship when the original tab moves', async () => {
  await render(<GlobalSystemNotices />)
  await toggleNotificationCenter(host, 'open')
  const current = select('[data-section="current"]')
  const history = select('[data-section="history"]')
  const panel = document.getElementById(current.getAttribute('aria-controls')!)!
  await press(current, 'End')
  expect(document.activeElement).toBe(history)
  expect(history.getAttribute('aria-selected')).toBe('true')
  expect(document.getElementById(history.getAttribute('aria-controls')!)).toBe(panel)
  expect(panel.getAttribute('aria-labelledby')).toBe(history.id)
})

it('follows the expanded Performance orientation and preserves the original panel identity', async () => {
  await render(<PerformanceOverview snapshot={null} close={() => {}} onConfigure={() => {}} onViewScript={() => {}} />)
  const overview = select('[data-performance-section-tab="overview"]')
  const target = select('[data-performance-section-tab="resources"]')
  await click(select('[aria-label="Expand Performance"]'))
  expect(select('[aria-label="Performance sections"]').getAttribute('aria-orientation')).toBe('vertical')
  await press(overview, 'ArrowDown')
  expect(document.activeElement).toBe(target)
  const panel = document.getElementById(target.getAttribute('aria-controls')!)!
  expect(panel.hidden).toBe(false)
  expect(panel.getAttribute('aria-labelledby')).toBe(target.id)
  await press(target, 'ArrowLeft')
  expect(document.activeElement).toBe(overview)
})

it('moves and changes a Markdown reading value while keeping the separate field untouched', async () => {
  const onChange = vi.fn()
  function Reader() {
    const [value, setValue] = useState<MarkdownReadingLayoutValue>({ width: 'standard', typeface: 'sans', fontSize: 13 })
    const layout: MarkdownReadingLayout = {
      value, fontSizes: { min: 12, max: 20, default: 13 },
      onChange(change) {
        onChange(change)
        if (change.kind === 'width') setValue(current => ({ ...current, width: change.width }))
      },
    }
    return <MarkdownReadingLayoutControl layout={layout} />
  }
  await render(<Reader />)
  await click(select('[aria-label="Reading layout"]'))
  const standard = select('[role="radio"][data-option="standard"]', document)
  const wide = select('[role="radio"][data-option="wide"]', document)
  await press(standard, 'ArrowRight')
  expect(document.activeElement, 'Inline radio moves focus into the newly chosen width').toBe(wide)
  expect(onChange).toHaveBeenCalledExactlyOnceWith({ kind: 'width', width: 'wide' })
  expect(wide.getAttribute('aria-checked')).toBe('true')
  expect(select('[data-option="sans"]', document).getAttribute('aria-checked')).toBe('true')
})

it('keeps Browser Profile network choice local until Apply', async () => {
  const profile: BrowserProfileSummary = { id: 'network-profile', revision: 'original', createdAt: 1, label: 'Work', isDefault: false, source: null }
  const execute = vi.fn(async () => true)
  await render(<ProfileNetworkRoute profile={profile} openBrowsers={0} run={execute} />)
  const system = select('[role="radio"][data-option="system"]')
  const proxy = select('[role="radio"][data-option="proxy"]')
  await press(system, 'End')
  expect(document.activeElement).toBe(proxy)
  expect(proxy.getAttribute('aria-checked')).toBe('true')
  expect(select('[aria-label="Proxy server"]')).toBeTruthy()
  expect(execute).not.toHaveBeenCalled()
})

it('skips disabled tabs in its own list and respects right-to-left direction', async () => {
  const onValueChange = vi.fn()
  const options = [
    { value: 'other', label: 'Other', panelId: 'other', button: { id: 'outer-first' } },
    { value: 'disabled', label: 'Disabled', panelId: 'disabled', button: { id: 'outer-middle', disabled: true } },
    { value: 'selected', label: 'Selected', panelId: 'selected', button: { id: 'outer-last' } },
  ] as const
  await render(<div dir="rtl"><Tabs aria-label="Sections" options={options} value="selected" onValueChange={onValueChange} /></div>)
  const list = select('[role="tablist"]')
  list.style.direction = 'rtl'
  const last = select('#outer-last')
  await press(last, 'ArrowRight', { ctrlKey: true })
  expect(onValueChange).not.toHaveBeenCalled()
  await press(last, 'ArrowRight')
  expect(onValueChange).toHaveBeenCalledExactlyOnceWith('other')
  expect(document.activeElement).toBe(select('#outer-first'))
})
