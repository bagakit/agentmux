// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { GRAPHITE_THEME, mountThemeRuntime, previewTheme } from '@agentmux/client-ui/theme'
import { StatusDot } from '../src/renderer/src/components/StatusDot'

let host: HTMLDivElement, root: Root, dispose: () => void, stylesheet: HTMLStyleElement
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  dispose = mountThemeRuntime(window)
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  stylesheet = document.createElement('style')
  // Actual stylesheet; strip import directives because happy-dom has no native asset loader.
  stylesheet.textContent = readFileSync('apps/desktop/src/renderer/src/styles/base.css', 'utf8').replace(/@import[^;]+;/gu, '')
  document.head.append(stylesheet)
})
afterEach(async () => { await act(async () => root.unmount()); dispose(); host.remove(); stylesheet.remove(); vi.unstubAllGlobals() })
it('uses each authoritative state on the original StatusDot and a replaceable bounded native mask', async () => {
  const states = ['starting', 'working', 'running', 'waiting', 'blocked', 'error', 'exited', 'done', 'disconnected'] as const
  const perState = structuredClone(GRAPHITE_THEME)
  perState.id = 'custom.distinct-presence'; perState.name = 'Distinct presence'
  for (const [i, state] of states.entries()) perState.icons[`status.presence-${state}`] = { kind: 'paths', paths: [{ d: `M${i + 1} 2H20V20H${i + 1}Z`, fill: 'currentColor' }] }
  expect(previewTheme(perState).applied).toBe(true)
  for (const state of states) {
    await act(async () => root.render(<StatusDot status={{ state, source: 'run-process' }} withLabel />))
    const dot = host.querySelector<HTMLElement>('.status__dot')!
    const mask = window.getComputedStyle(dot).getPropertyValue('mask-image') || window.getComputedStyle(dot).getPropertyValue('mask')
    expect(mask, state).toContain(document.documentElement.style.getPropertyValue(`--native-presence-${state}-mask`))
    expect(host.querySelector('.status')?.getAttribute('title')).toBe(`${state} · run-process`)
    expect(host.textContent).toBe(state)
    expect(window.getComputedStyle(dot).width).toBe(['waiting', 'blocked', 'error'].includes(state) ? '9px' : '7px')
    expect(document.documentElement.style.getPropertyValue(`--native-presence-${state}-mask`)).toMatch(/^url\("data:image\/svg\+xml,/u)
  }
  await act(async () => root.render(<StatusDot status={{ state: 'waiting', source: 'run-process' }} withLabel />))
  const element = host.querySelector('.status')!, dot = host.querySelector('.status__dot')!
  const before = document.documentElement.style.getPropertyValue('--native-presence-waiting-mask')
  const custom = structuredClone(GRAPHITE_THEME)
  custom.id = 'custom.presence-proof'; custom.name = 'Presence proof'
  custom.icons = { 'status.presence-waiting': { kind: 'paths', paths: [{ d: 'M4 4H20V20H4Z', fill: 'currentColor' }] } }
  await act(async () => { expect(previewTheme(custom).applied).toBe(true) })
  expect(host.querySelector('.status')).toBe(element); expect(host.querySelector('.status__dot')).toBe(dot)
  const mask = document.documentElement.style.getPropertyValue('--native-presence-waiting-mask')
  expect(mask).not.toBe(before); expect(decodeURIComponent(mask)).toContain('M4 4H20V20H4Z')
  expect(host.textContent).toBe('waiting'); expect(element.getAttribute('title')).toBe('waiting · run-process')
})
