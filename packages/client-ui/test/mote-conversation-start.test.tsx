// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { MoteConversationStart } from '../src/components/MoteConversationStart'
import { MoteFirstMessage } from '../src/components/MoteFirstMessage'
import { ClientUiProvider, type ClientUiPlatform } from '../src/platform'
const platform: ClientUiPlatform = { copyText: async () => true, overlayContainer: () => document.body, bindComposerFocus: () => () => {},
  renderMessageAvatar: () => null, renderProjectIcon: () => null, renderProjectLabel: () => null, renderIcon: () => null, renderObjectLink: () => null }

const roots: Array<() => void> = []
afterEach(() => { for (const close of roots.splice(0)) close(); vi.unstubAllGlobals() })
function render(name: string | undefined) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const element = document.createElement('div'); document.body.append(element)
  const root = createRoot(element)
  act(() => root.render(<MoteConversationStart name={name} portrait={<span />} composer={<textarea aria-label="Draft" />} />))
  roots.push(() => { act(() => root.unmount()); element.remove() })
  return element
}

// A Topic read before its title arrives still shows the welcome and its Composer instead of crashing the pane.
it('renders the welcome and keeps its Composer before the Mote name is known', () => {
  for (const name of [undefined, '', '   ']) {
    const scene = render(name).querySelector<HTMLElement>('.mote-start')!
    expect(scene.getAttribute('aria-label')).toBe('开始对话')
    expect(scene.querySelector('.mote-start__name')).toBeNull()
    expect(scene.querySelector('.mote-start__wordmark')?.textContent).toBe('Mote')
    expect(scene.querySelector('textarea[aria-label="Draft"]')).not.toBeNull()
  }
})

it('names the Mote once and drops the duplicate wordmark when the name is Mote itself', () => {
  const named = render('  文化人 ').querySelector<HTMLElement>('.mote-start')!
  expect(named.getAttribute('aria-label')).toBe('文化人 · 开始对话')
  expect(named.querySelector('.mote-start__name')?.textContent).toBe('文化人')
  expect(named.querySelector('.mote-start__wordmark')?.textContent).toBe('Mote')
  const plain = render('Mote').querySelector<HTMLElement>('.mote-start')!
  expect(plain.querySelector('.mote-start__name')?.textContent).toBe('Mote')
  expect(plain.querySelector('.mote-start__wordmark')).toBeNull()
})

// Returning to a Mote shows its welcome settled; only the first showing plays the entrance.
it('plays the entrance the first time the scene is shown and not when it is shown again', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const element = document.createElement('div'); document.body.append(element)
  const root = createRoot(element)
  roots.push(() => { act(() => root.unmount()); element.remove() })
  const show = (active: boolean) => act(() => root.render(<MoteConversationStart name="文化人" active={active} portrait={<span />} composer={<textarea />} />))
  const scene = () => element.querySelector<HTMLElement>('.mote-start')!
  show(false); expect(scene().hasAttribute('data-entering')).toBe(false)
  show(true); expect(scene().hasAttribute('data-entering')).toBe(true)
  show(false); show(true); expect(scene().hasAttribute('data-entering')).toBe(false)
  expect(scene().dataset.active).toBe('true')
})

// The first message replaces the greeting and history, sits above the composer and names its stage in one line.
it('shows the first message in place of the greeting with one stage line and a check only when unconfirmed', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const element = document.createElement('div'); document.body.append(element)
  const root = createRoot(element)
  roots.push(() => { act(() => root.unmount()); element.remove() })
  const check = vi.fn()
  const show = (stage: 'sending' | 'delivered' | 'unconfirmed', name?: string) => act(() => root.render(<ClientUiProvider platform={platform}><MoteConversationStart name="文化人" portrait={<span />}
    composer={<textarea aria-label="Draft" />} history={<p className="history-probe">history</p>}
    pending={<MoteFirstMessage messageId="mote-first:original" prompt="介绍一下你自己" name={name} stage={stage} action={{ label: '核对', onClick: check }} />} /></ClientUiProvider>))
  show('sending', '文化人')
  const scene = element.querySelector<HTMLElement>('.mote-start')!
  expect(scene.dataset.pending).toBe('true')
  expect(scene.querySelector('.mote-start__invitation')).toBeNull(); expect(scene.querySelector('.history-probe')).toBeNull()
  const pending = scene.querySelector('.mote-start__pending')!
  expect(pending.nextElementSibling?.className).toBe('mote-start__composer')
  expect(pending.textContent).toContain('介绍一下你自己'); expect(pending.textContent).toContain('文化人 正在准备…')
  expect(pending.querySelector('.mote-first-message__status button')).toBeNull()
  show('delivered', undefined)
  expect(scene.querySelector('.mote-first-message__status')?.textContent).toBe('Mote 已收到，正在接上主对话…')
  show('unconfirmed', '文化人')
  expect(scene.querySelector('.mote-first-message__status')?.textContent).toContain('送达尚未确认，不会重复发送')
  act(() => scene.querySelector<HTMLButtonElement>('.mote-first-message__status button')!.click()); expect(check).toHaveBeenCalledOnce()
})
