// @vitest-environment happy-dom
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { createClientUiRoot } from './helpers/client-ui-render'
import { WorkflowComponentGallery } from '../src/renderer/src/components/WorkflowComponentGallery'
let host: HTMLDivElement, root: Root
const examples = () => host.querySelector<HTMLElement>('.wf-gallery__examples')!
const width = () => host.querySelector<HTMLSelectElement>('[aria-label="Preview width"]')!
const bounds = () => host.querySelector<HTMLInputElement>('.wf-gallery__inspect input')!
async function change(value: string) { await act(async () => { width().value = value; width().dispatchEvent(new Event('change', { bubbles: true })) }) }
beforeEach(async () => { Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); host = document.createElement('div'); document.body.append(host); root = createClientUiRoot(host); await act(async () => root.render(<WorkflowComponentGallery />)) })
afterEach(async () => { await act(async () => root.unmount()); host.remove() })

it('the original Gallery scopes all Workflow and Observation examples inside the same inspection container', async () => {
  expect(width().value).toBe('fit'); expect(bounds().checked).toBe(false); expect(examples().dataset.inspectBounds).toBe('false')
  expect(examples().contains(host.querySelector('#workflow-context'))).toBe(true)
  expect(examples().contains(host.querySelector('.observation-gallery'))).toBe(true)
  expect(examples().contains(host.querySelector('#inline-rename'))).toBe(true)
  await change('320'); expect(examples().style.width).toBe('320px')
  await act(async () => bounds().click()); expect(examples().dataset.inspectBounds).toBe('true')
})

it('changing width and resetting inspection retain original component nodes and expanded state', async () => {
  const original = examples(), button = host.querySelector<HTMLButtonElement>('.wf-card button[aria-expanded]')!
  expect(button).not.toBeNull(); const before = button.getAttribute('aria-expanded')
  await act(async () => button.click()); expect(button.getAttribute('aria-expanded')).not.toBe(before)
  await change('390'); await act(async () => bounds().click())
  const reset = host.querySelector<HTMLButtonElement>('.wf-gallery__inspect button')!
  await act(async () => reset.click())
  expect(examples()).toBe(original); expect(host.contains(button)).toBe(true); expect(button.getAttribute('aria-expanded')).not.toBe(before)
  expect(width().value).toBe('fit'); expect(examples().style.width).toBe(''); expect(bounds().checked).toBe(false)
})
