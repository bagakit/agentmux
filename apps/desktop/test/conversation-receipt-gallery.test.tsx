// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { ClientUiProvider, type ClientUiPlatform } from '@agentmux/client-ui/platform'
import { ConversationReceiptGallery } from '../src/renderer/src/components/ConversationReceiptGallery'

let host: HTMLDivElement, root: Root
const copies: string[] = []
const platform: ClientUiPlatform = { copyText: async text => { copies.push(text); return true }, overlayContainer: () => document.body,
  bindComposerFocus: () => () => {}, renderMessageAvatar: () => null, renderProjectIcon: () => null, renderProjectLabel: () => null, renderIcon: () => null }
const receipt = () => host.querySelector<HTMLElement>('.conversation-send-receipt')!
const disclosure = () => receipt().querySelector<HTMLDetailsElement>('.message-disclosure')!
async function phase(value: string) { await act(async () => host.querySelector<HTMLButtonElement>(`[data-surface-mode="${value}"]`)!.click()) }
beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); copies.length = 0
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  await act(async () => root.render(<ClientUiProvider platform={platform}><ConversationReceiptGallery /></ClientUiProvider>))
})
afterEach(async () => { await act(async () => root.unmount()); host.remove() })

it('the real Gallery stage selector updates one original input without inventing native acceptance', async () => {
  const original = receipt(), key = original.dataset.messageSourceKey
  expect(original.dataset.receiptConfirmed).toBe('false'); expect(disclosure().open).toBe(true)
  expect(host.querySelector('[data-input-status="waiting"]')).not.toBeNull()
  await phase('terminal-confirmed')
  expect(receipt()).toBe(original); expect(receipt().dataset.messageSourceKey).toBe(key)
  expect(receipt().dataset.receiptConfirmed).toBe('false'); expect(receipt().dataset.receiptMode).toBe('compact'); expect(disclosure().open).toBe(false)
  expect(receipt().textContent).toContain('Agent 接收待核实')
  await phase('admitted')
  expect(receipt()).toBe(original); expect(receipt().dataset.receiptConfirmed).toBe('true'); expect(disclosure().open).toBe(false)
  expect(receipt().textContent).toContain('Agent 已接收')
  expect(host.querySelectorAll('[data-native-record-id]')).toHaveLength(0)
})

it('Gallery preferences keep explicit original reading and exact Copy through stage changes', async () => {
  await phase('terminal-confirmed')
  await act(async () => { disclosure().open = true; disclosure().dispatchEvent(new Event('toggle')) })
  const body = receipt().querySelector('.log-turn__body')!
  expect(body.textContent).toBe('请检查这次改动，并保留原输入与真实回执。')
  await phase('admitted')
  const select = host.querySelector<HTMLSelectElement>('[aria-label="确认后回执呈现"]')!
  await act(async () => { select.value = 'hide'; select.dispatchEvent(new Event('change', { bubbles: true })) })
  expect(disclosure().open).toBe(true); expect(receipt().querySelector('.log-turn__body')).toBe(body)
  await act(async () => host.querySelector<HTMLInputElement>('.receipt-gallery__preferences input')!.click())
  expect(select.disabled).toBe(true); expect(body.isConnected).toBe(true); expect(disclosure().hidden).toBe(false)
  await act(async () => receipt().querySelector<HTMLButtonElement>('button[aria-label="Copy message"]')!.click())
  expect(copies).toEqual(['请检查这次改动，并保留原输入与真实回执。'])
})
