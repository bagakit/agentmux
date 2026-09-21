// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import { BrowserStructuredFields } from '../src/renderer/src/components/BrowserStructuredFields'
import type { BrowserResultArtifactChunk, BrowserResultArtifactReference } from '../src/shared/browser-result-artifact'
import type { BrowserStructuredFieldSummary, BrowserStructuredOutputReceipt } from '../src/shared/browser-structured-output'
import { allStyleRules } from './helpers/styles'

vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
const source = { workspaceId: 'workspace-a', browserId: 'browser-a', operationId: 'operation-a', navigationId: 'navigation-a',
  url: 'https://document.invalid/', document: 'main', documentUrl: 'https://document.invalid/', scope: { kind: 'page' as const } }
const reference: BrowserResultArtifactReference = { kind: 'browser-result-artifact', id: 'artifact-a', format: 'json',
  workspaceId: source.workspaceId, browserId: source.browserId, operationId: source.operationId, navigationId: source.navigationId,
  capturedAt: 7, byteLength: 1, maxReadBytes: 65536 }
const field = (key: string, rest: Partial<BrowserStructuredFieldSummary>): BrowserStructuredFieldSummary => ({
  key, type: 'string', source: { selector: `#${key}`, read: 'text' }, status: 'observed', inline: true, ...rest
})
function receipt(fields: BrowserStructuredFieldSummary[], artifact: BrowserResultArtifactReference = reference): BrowserStructuredOutputReceipt {
  return { kind: 'browser-structured-output', status: 'partial', source: { ...source, workspaceId: artifact.workspaceId,
    browserId: artifact.browserId, operationId: artifact.operationId, navigationId: artifact.navigationId },
  fields, work: null, artifactStatus: 'available', artifact }
}
function chunk(reference: BrowserResultArtifactReference, bytes: Uint8Array, offset = 0): BrowserResultArtifactChunk {
  return { reference, encoding: 'base64', data: Buffer.from(bytes).toString('base64'), offset, returnedBytes: bytes.byteLength,
    totalBytes: reference.byteLength, nextOffset: offset + bytes.byteLength < reference.byteLength ? offset + bytes.byteLength : null,
    readCost: { metadataBytes: 42, payloadBytes: bytes.byteLength } }
}
async function openRaw(host: HTMLElement) {
  const details = [...host.querySelectorAll('details')].find(details => details.querySelector('summary')?.textContent === 'Recorded JSON')
  if (!details) throw new Error('Recorded JSON control is missing')
  await act(async () => { details.open = true; details.dispatchEvent(new Event('toggle')) })
}

describe('compact saved Browser structured fields', () => {
  it('keeps actual empty/zero/false separate from missing, type errors, ambiguous and incomplete previews', async () => {
    const fields = [field('empty', { value: '' }), field('zero', { type: 'number', value: 0 }), field('false', { type: 'boolean', value: false }),
      field('long', { inline: false, preview: 'recorded prefix', valueBytes: 2000 }),
      field('missing', { status: 'missing', inline: false, detail: 'No element matched.' }),
      field('duplicate', { status: 'ambiguous', inline: false, detail: 'At least two matched.' }),
      field('badType', { status: 'type-error', type: 'number', actual: '' }),
      field('truncated', { status: 'truncated', inline: false, preview: 'partial', detail: 'Budget ended.' }),
      field('unavailable', { status: 'unavailable', inline: false, detail: 'Frame read failed.' }),
      field('changed', { status: 'page-changed', inline: false, detail: 'Document changed.' })]
    const host = document.createElement('div'), root = createRoot(host)
    try {
      await act(async () => root.render(createElement(BrowserStructuredFields, { receipt: { ...receipt(fields), artifactStatus: 'unavailable', warning: 'Result storage is unavailable.' } })))
      const rows = [...host.querySelectorAll('.browser-structured-fields__values > div')]
      expect(rows).toHaveLength(10)
      expect(rows.map(row => row.querySelector('dt')?.textContent)).toEqual(fields.map(field => field.key))
      expect(rows.slice(0, 3).map(row => row.querySelector('dd')?.textContent)).toEqual(['""', '0', 'false'])
      expect(host.querySelectorAll('.browser-structured-fields__preview-note')).toHaveLength(1)
      expect(host.querySelector('.browser-structured-fields__preview-note')?.textContent).toBe('Previews · full values were not saved')
      expect(rows[3]?.textContent).toBe('longrecorded prefix')
      expect(rows[4]?.textContent).toContain('Missing')
      expect(rows[5]?.textContent).toContain('Multiple matches')
      expect(rows[6]?.textContent).toContain('Type mismatch""')
      expect(rows[7]?.getAttribute('data-field-status')).toBe('truncated')
      const truncated = rows[7]!.querySelector<HTMLDetailsElement>('details')!
      expect(truncated.querySelector(':scope > code')).toBeNull()
      await act(async () => { truncated.open = true; truncated.dispatchEvent(new Event('toggle')) })
      expect(rows[7]?.querySelector('.browser-structured-fields__preview > code')?.textContent).toBe('partial…')
      expect(rows[7]?.querySelector('summary .browser-structured-fields__state')?.textContent).toBe('Preview · observed portion only')
      expect(rows[7]?.querySelector('.browser-structured-fields__detail')?.textContent).toBe('Budget ended.')
      expect(rows[8]?.textContent).toContain('Unavailable')
      expect(rows[9]?.textContent).toContain('Page changed')
      expect(host.querySelector('[role="status"]')?.textContent).toBe('Result storage is unavailable.')
      expect(host.textContent).toContain('#badType')
      expect(host.textContent).not.toContain('Recorded JSON')
    } finally { await act(async () => root.unmount()) }
  })

  it('discloses complete retained previews without reading again, and keeps chunk paging outside the keyboard-readable JSON region', async () => {
    const preview = `${'L'.repeat(240)} retained tail!!`
    expect(new TextEncoder().encode(preview).byteLength).toBe(256)
    const fields = [field('title', { value: 'Section value' }), field('zero', { type: 'number', value: 0 }),
      field('flag', { type: 'boolean', value: false }), field('empty', { value: '' }),
      field('invalid', { status: 'type-error', type: 'number', actual: 'not a number' }),
      field('missing', { status: 'missing', inline: false, detail: 'No element matched.' }),
      field('ambiguous', { status: 'ambiguous', inline: false, detail: 'At least two matched.' }),
      ...Array.from({ length: 6 }, (_, index) => field(`long${index + 1}`, { inline: false, preview, valueBytes: 16000 }))]
    const bytes = new TextEncoder().encode(JSON.stringify({ value: 'L'.repeat(99508) }))
    expect(bytes.byteLength).toBe(99520)
    const artifact = { ...reference, byteLength: bytes.byteLength }
    const read = vi.fn(async (_reference, options) => chunk(artifact, bytes.slice(options.offset, options.offset + 65536), options.offset))
    const host = document.createElement('div'), root = createRoot(host)
    document.body.appendChild(host)
    try {
      await act(async () => root.render(createElement(BrowserStructuredFields, { receipt: receipt(fields, artifact), readResult: read })))
      expect(host.querySelector('.browser-structured-fields__summary')?.textContent).toBe('10 / 13 observed · Partial')
      expect(host.querySelectorAll('.browser-structured-fields__values > div')).toHaveLength(13)
      expect(host.querySelectorAll('.browser-structured-fields__preview-note')).toHaveLength(1)
      expect(host.querySelector('.browser-structured-fields__preview-note')?.textContent).toBe('Previews · full result in Recorded JSON')
      expect(host.querySelector('.browser-structured-fields__values .browser-structured-fields__preview-note')).toBeNull()
      const previews = [...host.querySelectorAll<HTMLDetailsElement>('.browser-structured-fields__preview')]
      expect(previews).toHaveLength(6)
      expect(previews.map(details => details.open)).toEqual([false, false, false, false, false, false])
      expect(previews.map(details => details.querySelector('summary')?.getAttribute('aria-label')))
        .toEqual(Array.from({ length: 6 }, (_, index) => `Field preview: long${index + 1}`))
      expect(previews.map(details => details.querySelector('summary > code')?.textContent)).toEqual(Array(6).fill(preview))
      expect(previews.map(details => details.querySelector(':scope > code'))).toEqual(Array(6).fill(null))
      expect(previews.map(details => details.querySelector('summary .browser-structured-fields__state'))).toEqual(Array(6).fill(null))
      const summary = previews[0]!.querySelector('summary')!
      summary.focus()
      // Native details disclosure is mounted here. Chromium keyboard/default handling remains
      // the canonical product proof; happy-dom does not implement that browser default action.
      await act(async () => { previews[0]!.open = true; previews[0]!.dispatchEvent(new Event('toggle')) })
      expect(previews[0]!.open).toBe(true)
      expect(previews[0]!.querySelector('summary > code')).toBeNull()
      expect(summary.textContent).toBe('Preview')
      expect(previews[0]!.querySelector(':scope > code')?.textContent).toBe(preview)
      expect(document.activeElement).toBe(summary)
      expect(read).toHaveBeenCalledTimes(0)
      expect(host.querySelectorAll('button')).toHaveLength(0)

      await openRaw(host)
      const raw = host.querySelector<HTMLPreElement>('pre')!
      expect(raw.className).toBe('browser-structured-fields__raw')
      expect(raw.tabIndex).toBe(0)
      expect(raw.getAttribute('aria-label')).toBe('Recorded JSON chunk')
      expect(raw.textContent).toBe(new TextDecoder().decode(bytes.slice(0, 65536)))
      expect(host.querySelector('.browser-structured-fields__range')?.textContent).toBe('Bytes 0–65535 of 99520')
      const next = host.querySelector<HTMLButtonElement>('button')!
      expect(raw.contains(next)).toBe(false)
      expect(next.parentElement).toBe(raw.parentElement)
      next.focus()
      expect(document.activeElement).toBe(next)
      raw.focus()
      await act(async () => next.click())
      expect(document.activeElement).toBe(raw)
      expect(raw.textContent).toBe(new TextDecoder().decode(bytes.slice(65536)))
      expect(host.querySelector('.browser-structured-fields__range')?.textContent).toBe('Bytes 65536–99519 of 99520')
      expect(host.querySelector('button')).toBeNull()
      expect(host.querySelector('.browser-structured-fields__summary')?.textContent).toBe('10 / 13 observed · Partial')
      expect(read.mock.calls.map(call => call[1])).toEqual([{ offset: 0, maxBytes: 65536 }, { offset: 65536, maxBytes: 65536 }])
      expect(previews[0]!.querySelector(':scope > code')?.textContent).toBe(preview)
      await act(async () => { previews[0]!.open = false; previews[0]!.dispatchEvent(new Event('toggle')) })
      expect(previews[0]!.querySelector('summary > code')?.textContent).toBe(preview)
      expect(previews[0]!.querySelector(':scope > code')).toBeNull()
    } finally { await act(async () => root.unmount()); host.remove() }
  })

  it('reads only on opening and continues exact byte ranges with streaming UTF8 and bounded displayed chunks', async () => {
    const bytes = new TextEncoder().encode('A🙂B')
    const artifact = { ...reference, byteLength: bytes.byteLength }
    const read = vi.fn(async (_reference, options) => chunk(artifact, options.offset === 0 ? bytes.slice(0, 3) : bytes.slice(3), options.offset))
    const host = document.createElement('div'), root = createRoot(host)
    try {
      await act(async () => root.render(createElement(BrowserStructuredFields, { receipt: receipt([field('value', { value: 'A🙂B' })], artifact), readResult: read })))
      expect(read).toHaveBeenCalledTimes(0)
      expect(host.querySelector('pre')).toBeNull()
      expect(host.querySelector('.browser-structured-fields__preview-note')).toBeNull()
      await openRaw(host)
      expect(read).toHaveBeenCalledTimes(1)
      expect(read).toHaveBeenNthCalledWith(1, artifact, { offset: 0, maxBytes: 65536 })
      expect(host.querySelector('pre')?.textContent).toBe('A')
      expect(host.textContent).toContain('Bytes 0–2 of 6')
      const next = host.querySelector<HTMLButtonElement>('button')!
      expect(next.textContent).toBe('Read next chunk')
      await act(async () => next.click())
      expect(read).toHaveBeenNthCalledWith(2, artifact, { offset: 3, maxBytes: 65536 })
      expect(host.querySelector('pre')?.textContent).toBe('🙂B')
      expect(host.textContent).toContain('Bytes 3–5 of 6')
      expect(host.querySelector('button')).toBeNull()
    } finally { await act(async () => root.unmount()) }
  })

  it('states saved preview availability once without inventing a reader or reading an artifact', async () => {
    const host = document.createElement('div'), root = createRoot(host)
    try {
      const fields = Array.from({ length: 6 }, (_, index) => field(`long${index + 1}`, { inline: false, preview: `prefix ${index}`, valueBytes: 16000 }))
      await act(async () => root.render(createElement(BrowserStructuredFields, { receipt: receipt(fields) })))
      expect(host.querySelectorAll('.browser-structured-fields__values > div')).toHaveLength(6)
      expect(host.querySelectorAll('.browser-structured-fields__preview-note')).toHaveLength(1)
      expect(host.querySelector('.browser-structured-fields__preview-note')?.textContent).toBe('Previews · full result is saved')
      expect(host.textContent).not.toContain('Recorded JSON')
      expect(host.querySelectorAll('button')).toHaveLength(0)
      expect([...host.querySelectorAll('.browser-structured-fields__preview > summary > code')].map(node => node.textContent))
        .toEqual(fields.map(field => field.preview))
    } finally { await act(async () => root.unmount()) }
  })

  it('failed or foreign result reads keep fields visible and retry the same range without new DOM work', async () => {
    const artifact = { ...reference, byteLength: 3 }
    const good = chunk(artifact, new Uint8Array([123, 125, 32]))
    const invalid = [
      { ...good, reference: { ...artifact, operationId: 'another-operation' } },
      { ...good, offset: 1, returnedBytes: 1, data: 'fQ==', nextOffset: 2 },
      { ...good, nextOffset: 1 }, { ...good, returnedBytes: 1 }, { ...good, data: 'invalid base64!' }
    ]
    const read = vi.fn().mockRejectedValueOnce(new Error('disk unavailable'))
    for (const changed of invalid) read.mockResolvedValueOnce(changed)
    read.mockResolvedValueOnce(good)
    const host = document.createElement('div'), root = createRoot(host)
    try {
      await act(async () => root.render(createElement(BrowserStructuredFields, { receipt: receipt([field('retained', { value: 'still visible' })], artifact), readResult: read })))
      await openRaw(host)
      expect(host.textContent).toContain('disk unavailable')
      for (let index = 0; index < invalid.length + 1; index += 1) {
        expect(host.querySelector('.browser-structured-fields__values')?.textContent).toContain('still visible')
        expect(host.querySelector('pre')).toBeNull()
        const retry = host.querySelector<HTMLButtonElement>('button')!
        expect(retry.textContent).toBe('Retry result')
        await act(async () => retry.click())
      }
      expect(invalid).toHaveLength(5)
      expect(read).toHaveBeenCalledTimes(7)
      expect(read.mock.calls.map(call => call[1])).toEqual(Array.from({ length: 7 }, () => ({ offset: 0, maxBytes: 65536 })))
      expect(host.querySelector('pre')?.textContent).toBe('{} ')
      expect(host.querySelector('button')).toBeNull()
    } finally { await act(async () => root.unmount()) }
  })

  it('late reads from a previously selected artifact cannot overwrite the current evidence', async () => {
    let resolveFirst!: (value: BrowserResultArtifactChunk) => void
    const second = { ...reference, id: 'artifact-b', operationId: 'operation-b', byteLength: 1 }
    const read = vi.fn().mockImplementationOnce(() => new Promise(resolve => { resolveFirst = resolve }))
      .mockResolvedValueOnce(chunk(second, new Uint8Array([50])))
    const host = document.createElement('div'), root = createRoot(host)
    try {
      await act(async () => root.render(createElement(BrowserStructuredFields, { receipt: receipt([field('old', { value: 'old' })]), readResult: read })))
      await openRaw(host)
      expect(read).toHaveBeenCalledTimes(1)
      await openRaw(host)
      expect(read).toHaveBeenCalledTimes(1)
      await act(async () => root.render(createElement(BrowserStructuredFields, { receipt: receipt([field('current', { value: 'current' })], second), readResult: read })))
      expect(host.querySelector('pre')).toBeNull()
      await openRaw(host)
      expect(host.querySelector('pre')?.textContent).toBe('2')
      await act(async () => resolveFirst(chunk(reference, new Uint8Array([49]))))
      expect(host.querySelector('pre')?.textContent).toBe('2')
      expect(host.querySelector('.browser-structured-fields__values')?.textContent).toContain('current')
      expect(host.querySelector('.browser-structured-fields__values')?.textContent).not.toContain('old')
    } finally { await act(async () => root.unmount()) }
  })

  it('style source has populated compact row rules that override the existing evidence dl without adding frames', () => {
    const rules = [...allStyleRules().matchAll(/([^{}]+)\{([^{}]+)\}/g)]
      .filter(rule => rule[1]?.includes('.browser-structured-fields'))
    expect(rules.length).toBeGreaterThan(0)
    const values = rules.find(rule => rule[1]?.includes('.browser-structured-fields .browser-structured-fields__values'))
    expect(values).toBeDefined()
    expect(values?.[2]?.match(/grid-template-columns:\s*([^;]+);/)?.[1]).toBe('minmax(0, 1fr)')
    const rows = rules.find(rule => rule[1]?.includes('.browser-structured-fields__values > div'))
    expect(rows).toBeDefined()
    expect(rows?.[2]).toContain('minmax(0, 1fr) minmax(0, 2fr)')
    const declarations = rules.map(rule => rule[2]).join('\n')
    expect(declarations).not.toContain('border:')
    expect(declarations).not.toContain('background:')
    const preview = rules.find(rule => rule[1]?.trim() === '.browser-structured-fields__preview > summary > code')
    expect(preview).toBeDefined()
    expect(preview?.[2]).toContain('white-space: nowrap;')
    const previewSummary = rules.find(rule => rule[1]?.trim() === '.browser-structured-fields__preview > summary')
    expect(previewSummary).toBeDefined()
    expect(previewSummary?.[2]).toContain('white-space: nowrap;')
    expect(previewSummary?.[2]).toContain('overflow: hidden;')
    expect(previewSummary?.[2]).toContain('text-overflow: ellipsis;')
    const expanded = rules.find(rule => rule[1]?.trim() === '.browser-structured-fields__preview > code')
    expect(expanded).toBeDefined()
    expect(expanded?.[2]).toContain('display: block;')
    const raw = rules.find(rule => rule[1]?.trim() === '.browser-structured-fields pre.browser-structured-fields__raw')
    expect(raw).toBeDefined()
    expect(raw?.[2]).toContain('max-height: min(24vh, 12rem);')
    expect(raw?.[2]).toContain('overflow: auto;')
    expect(raw?.[2]).toContain('font: inherit;')
  })
})
