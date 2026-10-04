// @vitest-environment happy-dom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { StructuredDataPreview } from '../src/renderer/src/components/file-preview/StructuredDataPreview'
import * as parsers from '../src/renderer/src/lib/file-formats/data-parse'
import { readJsonLines } from '../src/renderer/src/lib/file-formats/data-jsonl'
import type { StructuredPreview } from '../src/renderer/src/lib/file-formats/data-model'

let root: Root, container: HTMLDivElement
async function render(node: ReactNode) { await act(async () => root.render(node)); await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)); await vi.dynamicImportSettled() }) }
async function click(label: string) { const button = [...container.querySelectorAll('button')].find(item => item.textContent === label || item.getAttribute('aria-label') === label)!; expect(button).toBeDefined(); await act(async () => button.click()) }
beforeEach(() => { vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); container = document.createElement('div'); document.body.append(container); root = createRoot(container) })
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('structured current-buffer reader', () => {
  it('renders errors beside good JSONL records and an accessible paged heterogeneous table', async () => {
    await render(<StructuredDataPreview kind="jsonl" content={'{"a":null}\n{"bad":}\n{"b":false}\n0'} />)
    expect(container.textContent).toContain('1 issue')
    expect(container.textContent).toContain('Line 2, column')
    expect(container.textContent).toContain('false')
    await click('Table')
    expect([...container.querySelectorAll('thead th')].map(node => node.textContent)).toEqual(['Line', 'a', 'b', 'Value', 'Status'])
    expect(container.textContent).toContain('null'); expect(container.textContent).toContain('—')
    await render(<StructuredDataPreview kind="jsonl" content={Array.from({ length: 73 }, (_, id) => JSON.stringify({ id })).join('\n')} />)
    await click('Table')
    expect(container.querySelectorAll('tbody tr')).toHaveLength(50)
    await click('Next record page'); expect(container.querySelectorAll('tbody tr')).toHaveLength(23)
  })
  it('starts no hidden work, rejects late A→B→A results and clears the old reader before the next owner', async () => {
    const pending: Array<(parsed: StructuredPreview) => void> = []
    const parser = vi.spyOn(parsers, 'readStructuredPreview').mockImplementation(() => new Promise(resolve => pending.push(resolve)))
    const node = (content: string, visible = true, ownerKey = 'file') => <StructuredDataPreview kind="jsonl" content={content} visible={visible} ownerKey={ownerKey} />
    await render(node('1', false)); expect(parser).not.toHaveBeenCalled()
    await render(node('1')); await render(node('2')); await render(node('1'))
    expect(pending).toHaveLength(3)
    await act(async () => pending[2]!(readJsonLines('42'))); expect(container.textContent).toContain('42')
    await act(async () => { pending[0]!(readJsonLines('900')); pending[1]!(readJsonLines('901')) })
    expect(container.textContent).toContain('42'); expect(container.textContent).not.toContain('900'); expect(container.textContent).not.toContain('901')
    await render(node('1', true, 'other-file')); expect(container.textContent).not.toContain('42')
    await render(node('1', false)); await act(async () => pending[3]!(readJsonLines('999')))
    expect(container.textContent).toBe('')
  })
  it('shows independent YAML documents and a recoverable parse/admission failure', async () => {
    await render(<StructuredDataPreview kind="yaml" content={'name: first\n---\nname: second'} />)
    const select = container.querySelector('select')!
    expect(select.options).toHaveLength(2)
    await act(async () => { select.value = '1'; select.dispatchEvent(new Event('change', { bubbles: true })) })
    expect(container.textContent).toContain('second'); expect(container.textContent).not.toContain('first')
    await render(<StructuredDataPreview kind="toml" content={'key = ['} />); expect(container.textContent).toContain('column')
    await render(<StructuredDataPreview kind="yaml" content={'a'.repeat(1024 * 1024 + 1)} />); expect(container.textContent).toContain('Structured preview limit')
  })
})
