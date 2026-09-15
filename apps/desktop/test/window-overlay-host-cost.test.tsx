// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getWindowOverlayHost, resolveOverlayContainer } from '../src/renderer/src/components/WindowOverlayHost'

beforeEach(() => { document.body.replaceChildren() })
afterEach(() => { vi.restoreAllMocks(); document.body.replaceChildren() })

describe('window overlay host ownership', () => {
  it('resolves one host without scanning unrelated retained workbench descendants', () => {
    const workbench = document.createElement('main')
    workbench.id = 'root'
    for (let index = 0; index < 1000; index++) workbench.appendChild(document.createElement('span'))
    document.body.appendChild(workbench)
    const query = vi.spyOn(document, 'querySelector')
    const queryAll = vi.spyOn(document, 'querySelectorAll')
    const lookup = vi.spyOn(document, 'getElementById')
    const first = resolveOverlayContainer() as HTMLElement
    expect(first.parentElement).toBe(document.body)
    expect(first.hasAttribute('data-overlay-host')).toBe(true)
    expect(first.classList.contains('window-overlay-host')).toBe(true)
    expect(first.id).not.toBe('')
    for (let index = 0; index < 50; index++) expect(resolveOverlayContainer()).toBe(first)
    expect(getWindowOverlayHost()).toBe(first)
    expect(lookup).toHaveBeenCalledTimes(52)
    expect(query).not.toHaveBeenCalled()
    expect(queryAll).not.toHaveBeenCalled()
    expect(Array.from(document.body.children)).toEqual([workbench, first])
  })

  it('recreates a removed host and routes custom containers without resolving the default', () => {
    const first = resolveOverlayContainer() as HTMLElement
    first.remove()
    const recreated = resolveOverlayContainer() as HTMLElement
    expect(recreated).not.toBe(first)
    expect(recreated.id).toBe(first.id)
    expect(recreated.parentElement).toBe(document.body)
    expect(Array.from(document.body.children)).toEqual([recreated])
    const lookup = vi.spyOn(document, 'getElementById')
    const custom = document.createDocumentFragment()
    expect(resolveOverlayContainer(custom)).toBe(custom)
    expect(lookup).not.toHaveBeenCalled()
  })
})
