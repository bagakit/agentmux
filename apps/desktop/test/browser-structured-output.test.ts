// @vitest-environment happy-dom
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BrowserResultArtifactStore } from '../src/main/browser-result-artifact.js'
import { buildBrowserStructuredReadDeclaration, extractBrowserStructuredOutput, parseBrowserStructuredOutputDocument, parseBrowserStructuredOutputRequest,
  type BrowserStructuredOutputContext } from '../src/main/browser-structured-output.js'
import { BROWSER_STRUCTURED_LIMITS, type BrowserStructuredDocument, type BrowserStructuredFieldRequest,
  type BrowserStructuredOutputReceipt, type BrowserStructuredOutputRequest } from '../src/shared/browser-structured-output.js'

const owned: string[] = []
beforeEach(() => { document.body.innerHTML = ''; window.location.href = 'https://observation.invalid/document' })
afterEach(async () => { for (const directory of owned.splice(0)) await rm(directory, { recursive: true, force: true }) })
const field = (key: string, selector: string, type: BrowserStructuredFieldRequest['type'] = 'string',
  read: BrowserStructuredFieldRequest['source']['read'] = 'text', attribute?: string): BrowserStructuredFieldRequest => ({
  key, type, source: { selector, read, ...(attribute ? { attribute } : {}) }
})
const request = (...fields: BrowserStructuredFieldRequest[]): BrowserStructuredOutputRequest => ({ fields })
function domRead(root: Document | Element, declaration: string, input: BrowserStructuredOutputRequest): unknown {
  // Execute the same declaration that Main sends through CDP, rather than a parallel test implementation.
  return Function(`return (${declaration})`)().call(root, input)
}
async function fixture(input: BrowserStructuredOutputRequest, root: Document | Element = document) {
  const directory = await mkdtemp(join(tmpdir(), 'amux-structured-'))
  owned.push(directory)
  const storePath = join(directory, 'artifacts')
  const store = new BrowserResultArtifactStore(storePath)
  const documents: BrowserStructuredDocument[] = []
  let reads = 0
  const context: BrowserStructuredOutputContext = {
    source: { workspaceId: 'workspace-observed', browserId: 'browser-observed', operationId: 'operation-observed',
      navigationId: 'navigation-at-observation', url: 'https://container.invalid/page', document: 'main',
      scope: input.within || input.withinRef ? { kind: 'subtree', ...(input.within ? { within: input.within } : {}),
        ...(input.withinRef ? { withinRef: input.withinRef } : {}) } : { kind: 'page' } },
    isCurrent: () => true,
    read: async (declaration, input) => { reads += 1; return domRead(root, declaration, input) },
    register: async (document, source) => {
      documents.push(structuredClone(document))
      const path = join(directory, `${randomUUID()}.json`)
      await writeFile(path, JSON.stringify(document), { mode: 0o600 })
      return await store.import(source, path)
    }
  }
  const readDocument = async (receipt: BrowserStructuredOutputReceipt, restart = false) => {
    expect(receipt.artifactStatus).toBe('available')
    if (!receipt.artifact) throw new Error('artifact missing')
    const reader = restart ? new BrowserResultArtifactStore(storePath) : store
    const chunks: Buffer[] = []
    let offset: number | null = 0
    while (offset !== null) {
      const chunk = await reader.read(receipt.artifact, context.source, { offset, maxBytes: 8191 })
      expect(chunk.returnedBytes).toBeGreaterThan(0)
      expect(chunk.returnedBytes).toBeLessThanOrEqual(8191)
      expect(chunk.readCost.payloadBytes).toBeGreaterThan(0)
      chunks.push(Buffer.from(chunk.data, 'base64'))
      offset = chunk.nextOffset
    }
    expect(chunks.length).toBeGreaterThan(0)
    return { value: JSON.parse(Buffer.concat(chunks).toString('utf8')) as BrowserStructuredDocument, chunks: chunks.length }
  }
  return { context, documents, readDocument, reads: () => reads }
}

describe('finite schema and observed source extraction', () => {
  it('rejects unsupported, empty, duplicate and over-budget schemas before any DOM read', async () => {
    const one = field('name', '.name')
    const accepted = request(...Array.from({ length: 32 }, (_, index) => field(`f${index}`, 'span')))
    expect(parseBrowserStructuredOutputRequest(accepted).fields).toHaveLength(32)
    const invalid: unknown[] = [
      { fields: [] }, request(one, one), { fields: [{ ...one, type: 'object' }] },
      { fields: [{ ...one, default: 'invented' }] }, { ...request(one), model: 'anything' },
      { ...request(one), within: 'main', withinRef: '@e1' }, { ...request(one), withinRef: 'arbitrary' },
      request(field('big', 'x'.repeat(513))), request(field('blank', '   ')),
      request(...Array.from({ length: 33 }, (_, index) => field(`f${index}`, 'span'))),
      request(field('attribute', 'span', 'string', 'attribute')), request(field('events', 'span', 'string', 'attribute', 'onclick')),
      request(field('extra', 'span', 'string', 'text', 'title')),
      { fields: [{ ...one, source: { ...one.source, javascript: 'run()' } }] }
    ]
    const f = await fixture(request(one))
    for (const value of invalid) await expect(extractBrowserStructuredOutput(value, f.context)).rejects.toThrow()
    expect(invalid).toHaveLength(14)
    expect(f.reads()).toBe(0)
    expect(f.documents).toEqual([])
  })

  it('definition-list/form observes empty string, zero and false without actions, and stores source/schema together', async () => {
    document.body.innerHTML = '<main id="region"><dl><dt>Name</dt><dd class="name">  Ada  </dd><dd class="amount">0</dd></dl><form><input class="empty" value=""><input class="flag" type="checkbox"></form></main><aside class="name">outside</aside>'
    const root = document.querySelector('#region')!
    const input = { within: '#region', fields: [field('name', '.name'), field('amount', '.amount', 'number'),
      field('empty', '.empty', 'string', 'value'), field('flag', '.flag', 'boolean', 'checked')] }
    const f = await fixture(input, root)
    let events = 0
    root.addEventListener('input', () => events += 1); root.addEventListener('change', () => events += 1)
    const active = document.activeElement
    const receipt = await extractBrowserStructuredOutput(input, f.context)
    expect(receipt.status).toBe('complete')
    expect(receipt.fields.map(({ key, status, value }) => ({ key, status, value }))).toEqual([
      { key: 'name', status: 'observed', value: '  Ada  ' }, { key: 'amount', status: 'observed', value: 0 },
      { key: 'empty', status: 'observed', value: '' }, { key: 'flag', status: 'observed', value: false }
    ])
    expect(receipt.source).toEqual({ ...f.context.source, documentUrl: document.URL })
    expect(receipt.source.url).not.toBe(receipt.source.documentUrl)
    expect(receipt.work?.reads).toBe(4)
    expect(receipt.work?.readBytes).toBe(8)
    expect(events).toBe(0); expect(document.activeElement).toBe(active)
    const saved = (await f.readDocument(receipt, true)).value
    expect(saved).toEqual(f.documents[0])
    expect(saved.schema).toBe('browser-structured-output.v1')
    expect(saved.request).toEqual(input)
    expect(saved.source.navigationId).toBe('navigation-at-observation')
    expect(receipt.artifact).toMatchObject({ workspaceId: saved.source.workspaceId, browserId: saved.source.browserId,
      operationId: saved.source.operationId, navigationId: saved.source.navigationId })
    expect(f.documents).toHaveLength(1)
    expect(root.isConnected).toBe(true)
  })

  it('table layout preserves missing, ambiguous, attribute absence and type errors instead of selecting/defaulting', async () => {
    document.body.innerHTML = '<table><tbody><tr><td class="name">B</td><td class="number">12.5</td><td class="bool">false</td></tr><tr><td class="repeat">one</td><td class="repeat">two</td><td class="empty"></td><td class="bad">truthy</td><td><a class="link" href="/raw">link</a></td></tr></tbody></table>'
    const input = request(field('name', '.name'), field('number', '.number', 'number'), field('false', '.bool', 'boolean'),
      field('missing', '.absent'), field('duplicate', '.repeat'), field('emptyNumber', '.empty', 'number'),
      field('badBoolean', '.bad', 'boolean'), field('href', '.link', 'string', 'attribute', 'href'),
      field('attributeAbsent', '.link', 'string', 'attribute', 'title'))
    const f = await fixture(input)
    const receipt = await extractBrowserStructuredOutput(input, f.context)
    expect(receipt.status).toBe('partial')
    expect(receipt.fields.map(field => [field.key, field.status, field.value, field.actual])).toEqual([
      ['name', 'observed', 'B', undefined], ['number', 'observed', 12.5, undefined], ['false', 'observed', false, undefined],
      ['missing', 'missing', undefined, undefined], ['duplicate', 'ambiguous', undefined, undefined],
      ['emptyNumber', 'type-error', undefined, ''], ['badBoolean', 'type-error', undefined, 'truthy'],
      ['href', 'observed', '/raw', undefined], ['attributeAbsent', 'missing', undefined, undefined]
    ])
    const saved = (await f.readDocument(receipt, true)).value
    expect(saved.fields.map(field => field.status)).toEqual(receipt.fields.map(field => field.status))
    expect(saved.fields[4]).toMatchObject({ status: 'ambiguous', detail: 'At least two elements matched.' })
    expect(saved.fields[8]).toMatchObject({ status: 'missing', detail: 'The matched element has no requested attribute.' })
    expect(f.documents).toHaveLength(1)
  })

  it('counts the actual rooted traversal and reads, rather than reporting a configured budget as work', async () => {
    document.body.innerHTML = '<section id="scope"><span class="n">8</span><input class="flag" type="checkbox"><p><b>A</b>B</p></section>'
    const input = { withinRef: '@e42', fields: [field('n', '.n', 'number'), field('flag', '.flag', 'boolean', 'checked')] }
    const f = await fixture(input, document.querySelector('#scope')!)
    f.context.source.document = 'actual-frame-session'
    const receipt = await extractBrowserStructuredOutput(input, f.context)
    expect(receipt.status).toBe('complete')
    expect(receipt.source.document).toBe('actual-frame-session')
    expect(receipt.work).toEqual({ visitedElements: 5, elementWalkSteps: 5, selectorChecks: 12,
      textNodes: 1, textWalkSteps: 2, reads: 2, readBytes: 1 })
    expect(receipt.fields.map(field => field.value)).toEqual([8, false])
  })

  it('a scan ending at its element budget cannot prove missing or one-match uniqueness', async () => {
    const root = document.createElement('section')
    root.id = 'scope'; document.body.append(root)
    for (let index = 0; index < BROWSER_STRUCTURED_LIMITS.elements + 1; index += 1) {
      const span = document.createElement('span')
      if (index === 0) span.id = 'first'
      if (index < 2) span.className = 'dup'
      if (index === BROWSER_STRUCTURED_LIMITS.elements) span.id = 'late'
      root.append(span)
    }
    const input = { within: '#scope', fields: [field('early', '#first'), field('late', '#late'), field('duplicate', '.dup')] }
    const f = await fixture(input, root)
    const receipt = await extractBrowserStructuredOutput(input, f.context)
    expect(receipt.fields.map(field => field.status)).toEqual(['truncated', 'truncated', 'ambiguous'])
    expect(receipt.work?.visitedElements).toBe(BROWSER_STRUCTURED_LIMITS.elements)
    expect(receipt.work?.elementWalkSteps).toBe(BROWSER_STRUCTURED_LIMITS.elements)
    expect(receipt.work?.reads).toBe(0)
    expect(receipt.work?.readBytes).toBe(0)
    expect((await f.readDocument(receipt)).value.fields.map(field => field.status)).toEqual(['truncated', 'truncated', 'ambiguous'])
  })

  it('text-node and UTF8 field budgets retain explicit partial prefixes, without broken codepoints or complete values', async () => {
    const target = document.createElement('span'); target.id = 'many'
    document.body.append(target)
    for (let index = 0; index < BROWSER_STRUCTURED_LIMITS.textNodes + 1; index += 1) target.appendChild(document.createTextNode(''))
    const input = request(field('many', '#many'))
    const f = await fixture(input)
    const receipt = await extractBrowserStructuredOutput(input, f.context)
    expect(receipt.fields).toMatchObject([{ status: 'truncated', inline: false, preview: '' }])
    expect(receipt.work?.textNodes).toBe(BROWSER_STRUCTURED_LIMITS.textNodes)
    expect(receipt.work?.readBytes).toBe(0)
    target.textContent = '🙂'.repeat(BROWSER_STRUCTURED_LIMITS.fieldBytes / 4 + 1)
    const bytes = await extractBrowserStructuredOutput(input, f.context)
    expect(bytes.fields).toMatchObject([{ status: 'truncated', inline: false }])
    expect(bytes.fields[0]?.value).toBeUndefined()
    const full = (await f.readDocument(bytes)).value.fields[0]
    expect(full?.status).toBe('truncated')
    if (full?.status !== 'truncated') throw new Error('expected truncated field')
    expect(full.preview).toBe('🙂'.repeat(BROWSER_STRUCTURED_LIMITS.fieldBytes / 4))
    expect(bytes.work?.readBytes).toBe(BROWSER_STRUCTURED_LIMITS.fieldBytes)
    expect(Buffer.byteLength(bytes.fields[0]!.preview!)).toBe(BROWSER_STRUCTURED_LIMITS.previewBytes)
  })

  it('large complete values stay in the sole durable artifact; summaries never claim their previews are values', async () => {
    const root = document.createElement('main'); document.body.append(root)
    const fields = Array.from({ length: 17 }, (_, index) => {
      const span = document.createElement('span'); span.id = `f${index}`
      span.textContent = index < 16 ? '🙂'.repeat(BROWSER_STRUCTURED_LIMITS.fieldBytes / 4) : 'beyond-total-budget'
      root.append(span); return field(`f${index}`, `#f${index}`)
    })
    const input = request(...fields)
    const f = await fixture(input)
    const receipt = await extractBrowserStructuredOutput(input, f.context)
    expect(receipt.fields.map(field => field.status)).toEqual([...Array<string>(16).fill('observed'), 'truncated'])
    expect(receipt.fields[0]).toMatchObject({ inline: false, valueBytes: BROWSER_STRUCTURED_LIMITS.fieldBytes })
    expect(receipt.fields[0]?.value).toBeUndefined()
    expect(receipt.work?.readBytes).toBe(BROWSER_STRUCTURED_LIMITS.totalBytes)
    expect(Buffer.byteLength(JSON.stringify(receipt))).toBeLessThan(16 * 1024)
    expect(receipt.artifact?.byteLength).toBeGreaterThan(128 * 1024)
    const saved = await f.readDocument(receipt, true)
    expect(saved.chunks).toBeGreaterThan(16)
    expect(saved.value.fields[0]).toMatchObject({ status: 'observed', value: '🙂'.repeat(BROWSER_STRUCTURED_LIMITS.fieldBytes / 4) })
    expect(saved.value.fields[16]).toMatchObject({ status: 'truncated', preview: '' })
    expect(f.reads()).toBe(1)
    expect(f.documents).toHaveLength(1)
  })

  it('invalid selectors, unsupported element reads and getter failures are unavailable rather than missing', async () => {
    document.body.innerHTML = '<span id="text">real</span><input id="throwing">'
    Object.defineProperty(document.querySelector('#throwing'), 'value', { get() { throw new Error('property blocked') } })
    const input = request(field('syntax', '['), field('value', '#text', 'string', 'value'),
      field('checked', '#text', 'boolean', 'checked'), field('throwing', '#throwing', 'string', 'value'))
    const f = await fixture(input)
    const receipt = await extractBrowserStructuredOutput(input, f.context)
    expect(receipt.fields.map(field => field.status)).toEqual(['unavailable', 'unavailable', 'unavailable', 'unavailable'])
    expect(receipt.fields[3]?.detail).toContain('property blocked')
    expect(f.documents).toHaveLength(1)
  })

  it('strict scalar conversions reject empty, locale guesses, nonfinite numbers and truthiness', async () => {
    const values = ['', ' ', '01', '1,000', 'Infinity', '1e999', 'true', 'TRUE', '0', 'false']
    document.body.innerHTML = values.map((value, index) => `<span id="f${index}">${value}</span>`).join('')
    const input = request(...values.map((_, index) => field(`f${index}`, `#f${index}`, index < 7 ? 'number' : 'boolean')))
    const f = await fixture(input)
    const receipt = await extractBrowserStructuredOutput(input, f.context)
    expect(receipt.fields.map(field => field.status)).toEqual([...Array<string>(9).fill('type-error'), 'observed'])
    expect(receipt.fields[0]).toMatchObject({ actual: '', inline: true })
    expect(receipt.fields[9]).toMatchObject({ value: false })
  })

  it('page changes before, during, on CDP failure and during registration cannot publish old fields as current', async () => {
    document.body.innerHTML = '<span class="name">old page</span>'
    const input = request(field('name', '.name'))
    const before = await fixture(input); before.context.isCurrent = () => false
    expect((await extractBrowserStructuredOutput(input, before.context)).status).toBe('page-changed')
    expect(before.reads()).toBe(0); expect(before.documents).toEqual([])
    const during = await fixture(input)
    const actualRead = during.context.read; let current = true
    during.context.isCurrent = () => current
    during.context.read = async (declaration, request) => { const result = await actualRead(declaration, request); current = false; return result }
    const changed = await extractBrowserStructuredOutput(input, during.context)
    expect(changed).toMatchObject({ status: 'page-changed', artifactStatus: 'not-recorded', fields: [{ status: 'page-changed' }] })
    expect(changed.fields[0]?.value).toBeUndefined(); expect(during.documents).toEqual([])
    const failing = await fixture(input); current = true
    failing.context.isCurrent = () => current
    failing.context.read = async () => { current = false; throw new Error('Execution context destroyed') }
    expect((await extractBrowserStructuredOutput(input, failing.context)).status).toBe('page-changed')
    const saving = await fixture(input); current = true
    saving.context.isCurrent = () => current
    const register = saving.context.register
    saving.context.register = async (document, source) => { const reference = await register(document, source); current = false; return reference }
    const saved = await extractBrowserStructuredOutput(input, saving.context)
    expect(saved).toMatchObject({ status: 'page-changed', artifactStatus: 'not-recorded' })
    expect(saved.artifact).toBeUndefined(); expect(saving.documents).toHaveLength(1)
    expect(document.querySelector('.name')?.textContent).toBe('old page')
  })

  it('actual rooted document disconnection is detected even when the Main navigation counter did not change', async () => {
    document.body.innerHTML = '<main id="region"><span class="name">old frame</span></main>'
    const root = document.querySelector('#region')!
    const target = root.querySelector('.name')!
    const original = target.matches.bind(target)
    target.matches = selector => { const result = original(selector); root.remove(); return result }
    const input = { within: '#region', fields: [field('name', '.name')] }
    const f = await fixture(input, root)
    const receipt = await extractBrowserStructuredOutput(input, f.context)
    expect(receipt).toMatchObject({ status: 'page-changed', fields: [{ status: 'page-changed' }] })
    expect(f.documents).toEqual([])
  })

  it('a scope mismatch or unverified CDP result fails honestly, and failed CDP work remains unknown', async () => {
    const input = request(field('name', '.name'))
    const wrong = await fixture(input); wrong.context.source.scope = { kind: 'subtree', within: '#another' }
    const mismatched = await extractBrowserStructuredOutput(input, wrong.context)
    expect(mismatched.status).toBe('unavailable'); expect(wrong.reads()).toBe(0)
    const f = await fixture(input)
    f.context.read = async () => { throw new Error('frame unavailable') }
    const failed = await extractBrowserStructuredOutput(input, f.context)
    expect(failed).toMatchObject({ status: 'unavailable', work: null, artifactStatus: 'not-recorded' })
    expect(failed.warning).toContain('frame unavailable')
    f.context.read = async () => ({ ...domRead(document, buildBrowserStructuredReadDeclaration(), input) as object, fields: [] })
    const empty = await extractBrowserStructuredOutput(input, f.context)
    expect(empty.status).toBe('unavailable'); expect(empty.warning).toContain('field identities')
    expect(f.documents).toEqual([])
  })

  it('artifact failure or unknown Workspace keeps observed fields and a persistent warning without blocking a healthy page', async () => {
    document.body.innerHTML = '<span class="name">still usable</span>'
    const input = request(field('name', '.name'))
    const f = await fixture(input)
    const register = f.context.register
    f.context.register = async () => { throw new Error('disk unavailable') }
    const failed = await extractBrowserStructuredOutput(input, f.context)
    expect(failed).toMatchObject({ status: 'partial', artifactStatus: 'unavailable', fields: [{ status: 'observed', value: 'still usable' }] })
    expect(failed.warning).toContain('disk unavailable')
    f.context.register = register; f.context.source.workspaceId = null
    const unknown = await extractBrowserStructuredOutput(input, f.context)
    expect(unknown).toMatchObject({ status: 'partial', artifactStatus: 'unavailable', fields: [{ value: 'still usable' }] })
    expect(unknown.warning).toContain('Workspace')
    f.context.source.workspaceId = 'workspace-observed'
    const healthy = await extractBrowserStructuredOutput(input, f.context)
    expect(healthy.status).toBe('complete'); expect(document.querySelector('.name')?.isConnected).toBe(true)
  })

  it('registration must use this observation source and exact document bytes, not a runner initial nav or another owner', async () => {
    document.body.innerHTML = '<span class="name">observed</span>'
    const input = request(field('name', '.name'))
    const f = await fixture(input)
    const actual = f.context.register
    const forged = [
      { navigationId: 'navigation-from-run-start' }, { operationId: 'another-operation' }, { browserId: 'another-browser' },
      { workspaceId: 'another-workspace' }, { byteLength: 1 }, { maxReadBytes: 1 }
    ]
    for (const change of forged) {
      f.context.register = async (document, source) => ({ ...await actual(document, source), ...change })
      const receipt = await extractBrowserStructuredOutput(input, f.context)
      expect(receipt).toMatchObject({ status: 'partial', artifactStatus: 'unavailable', fields: [{ value: 'observed' }] })
      expect(receipt.artifact).toBeUndefined()
      expect(receipt.warning).toContain('captured source or document bytes')
    }
    expect(forged).toHaveLength(6)
    expect(f.documents).toHaveLength(6)
  })

  it('one full-document parser rejects source/schema drift and invented observed types; its shape check is not provenance', async () => {
    document.body.innerHTML = '<span class="n">7</span>'
    const input = request(field('n', '.n', 'number'), field('missing', '.absent'))
    const f = await fixture(input)
    const receipt = await extractBrowserStructuredOutput(input, f.context)
    const actual = (await f.readDocument(receipt)).value
    expect(parseBrowserStructuredOutputDocument(actual)).toEqual(actual)
    const observed = actual.fields[0]!
    const mismatches = [
      { ...actual, fields: [] }, { ...actual, fields: [observed] },
      { ...actual, fields: [{ ...observed, value: '7' }, actual.fields[1]] },
      { ...actual, fields: [{ ...observed, source: { ...observed.source, selector: '.another' } }, actual.fields[1]] },
      { ...actual, request: { ...actual.request, within: '#another' } },
      { ...actual, source: { ...actual.source, documentUrl: null } },
      { ...actual, work: { ...actual.work, visitedElements: BROWSER_STRUCTURED_LIMITS.elements + 1 } },
      { ...actual, fields: [observed, { ...actual.fields[1], value: 'invented' }] },
      { ...actual, schema: 'arbitrary' }, { ...actual, provenance: true }
    ]
    for (const changed of mismatches) expect(() => parseBrowserStructuredOutputDocument(changed)).toThrow()
    expect(mismatches).toHaveLength(10)
    // Arbitrary same-shaped JSON can pass shape validation. Main's real step→artifact join must authenticate it.
    expect(parseBrowserStructuredOutputDocument(JSON.parse(JSON.stringify(actual)))).toEqual(actual)
  })
})
