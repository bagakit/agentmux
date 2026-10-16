import { fixtureEpoch as _tailFixtureEpoch } from "../../../test/fixture-values.mjs"
import { appendFileSync, readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'
import { BrowserOperationFileStore, BrowserOperationJournal, browserOperationAlreadyExistsError,
  type BrowserOperationJournalDocument, type BrowserOperationJournalStore, type BrowserOperationJournalChanges } from '../src/main/browser-operation-journal.js'
import { browserRunResult, unwrapBrowserRunResult } from '../src/shared/browser-run-result.js'
import type { BrowserScriptRunReport } from '../src/shared/contracts.js'
import { applyJournalChanges } from './browser-operation-memory-store.js'
import { parseAgentMuxControlReceipt } from '../../../packages/core/src/control-codec.js'
import { AGENTMUX_CONTROL_SCHEMA_VERSION } from '../../../packages/core/src/control.js'

const input = { browserId: 'original-page', operator: { id: 'operator', name: 'Operator' }, summary: 'Original program', url: 'https://fixture.invalid/page' }
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes }); return { promise, resolve } }
class Store implements BrowserOperationJournalStore {
  document: BrowserOperationJournalDocument | null = null
  fail = false
  beforeSave: (() => Promise<void>) | undefined
  load = vi.fn(async () => this.document ? structuredClone(this.document) : null)
  save = vi.fn(async (changes: BrowserOperationJournalChanges) => {
    await this.beforeSave?.()
    if (this.fail) throw new Error('Original journal write unavailable')
    this.document = applyJournalChanges(this.document, changes)
  })
}

describe('Browser operation identity owner', () => {
  it('rejects a retained completed identity on either Browser without replacing facts, events or writes', async () => {
    const store = new Store(), journal = new BrowserOperationJournal(store)
    await journal.start({ ...input, id: 'original' })
    await journal.startStep('original', { method: 'snapshot', label: 'Observed original page' })
    await journal.finishStep('original', 1, { status: 'completed' }); await journal.finish('original', 'completed')
    const original = await journal.get('original'), events = await journal.events(), document = structuredClone(store.document), saves = store.save.mock.calls.length
    const delivered = vi.fn(), subscription = await journal.subscribe('original', undefined, delivered)
    for (const browserId of [input.browserId, 'another-page']) await expect(journal.start({ ...input, browserId, id: 'original', summary: 'Replacement' })).rejects.toMatchObject({ code: 'BROWSER_OPERATION_ALREADY_EXISTS' })
    expect(await journal.get('original')).toEqual(original); expect(await journal.events()).toEqual(events)
    expect(store.document).toEqual(document); expect(store.save).toHaveBeenCalledTimes(saves); expect(delivered).not.toHaveBeenCalled()
    subscription.dispose()
    await expect(journal.start({ ...input, id: 'fresh' })).resolves.toMatchObject({ id: 'fresh', browserId: input.browserId })
  })

  it('admits concurrent starts only once while the first original save is still pending', async () => {
    const store = new Store(), journal = new BrowserOperationJournal(store), saving = deferred<void>(), release = deferred<void>(), duplicateSave = deferred<{ duplicateSave: true }>()
    let saves = 0
    store.beforeSave = async () => { if (++saves === 1) saving.resolve(undefined); else duplicateSave.resolve({ duplicateSave: true }); await release.promise }
    const first = journal.start({ ...input, id: 'concurrent' })
    const second = journal.start({ ...input, browserId: 'another-page', id: 'concurrent' }).then(value => ({ value }), error => ({ error }))
    await saving.promise
    try {
      expect(await Promise.race([second, duplicateSave.promise])).toMatchObject({ error: { code: 'BROWSER_OPERATION_ALREADY_EXISTS' } })
      expect(store.save).toHaveBeenCalledTimes(1)
      expect(await journal.get('concurrent')).toMatchObject({ browserId: input.browserId })
    } finally { release.resolve(undefined) }
    await expect(first).resolves.toMatchObject({ id: 'concurrent', browserId: input.browserId })
  })

  it('rejects restart-indeterminate identity from the original durable file without reseeding', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'browser-operation-identity-'))
    try {
      const path = join(directory, 'operations.sqlite'), first = new BrowserOperationJournal(new BrowserOperationFileStore(path))
      await first.start({ ...input, id: 'interrupted' })
      await first.startStep('interrupted', { method: 'click', label: 'Original action' })
      const reopened = new BrowserOperationJournal(new BrowserOperationFileStore(path)), original = await reopened.get('interrupted')
      expect(original).toMatchObject({ id: 'interrupted', phase: 'indeterminate', steps: [{ sequence: 1, status: 'stopped' }] })
      const events = await reopened.events()
      await expect(reopened.start({ ...input, id: 'interrupted' })).rejects.toMatchObject({ code: 'BROWSER_OPERATION_ALREADY_EXISTS' })
      expect(await reopened.get('interrupted')).toEqual(original); expect(await reopened.events()).toEqual(events)
      const third = new BrowserOperationJournal(new BrowserOperationFileStore(path))
      expect(await third.get('interrupted')).toEqual(original)
      await expect(reopened.start({ ...input, id: 'after-restart' })).resolves.toMatchObject({ id: 'after-restart' })
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('keeps exact nonblank identities distinct and rejects only actual generated collisions', async () => {
    const store = new Store(), minted = ['generated', 'generated', 'fresh-generated'], journal = new BrowserOperationJournal(store, { id: () => minted.shift()! })
    await journal.start({ ...input, id: 'trimmed' })
    await expect(journal.start({ ...input, id: ' trimmed ' })).resolves.toMatchObject({ id: ' trimmed ' })
    const prefix = 'x'.repeat(300), long = await journal.start({ ...input, id: prefix + 'first' })
    await expect(journal.start({ ...input, id: prefix + 'second' })).resolves.toMatchObject({ id: prefix + 'second' })
    expect(long.id).toBe(prefix + 'first')
    expect(await journal.get(long.id)).toEqual(long)
    await expect(journal.start(input)).resolves.toMatchObject({ id: 'generated' })
    await expect(journal.start(input)).rejects.toMatchObject({ code: 'BROWSER_OPERATION_ALREADY_EXISTS' })
    await expect(journal.start(input)).resolves.toMatchObject({ id: 'fresh-generated' })
  })

  it('keeps accepted in-memory identity after failed persistence and never uses a duplicate as a hidden save retry', async () => {
    const store = new Store(), journal = new BrowserOperationJournal(store); store.fail = true
    const original = await journal.start({ ...input, id: 'write-unconfirmed' }), events = await journal.events()
    expect(journal.getPersistenceWarning()).toContain('Original journal write unavailable')
    store.fail = false
    await expect(journal.start({ ...input, id: 'write-unconfirmed' })).rejects.toMatchObject({ code: 'BROWSER_OPERATION_ALREADY_EXISTS' })
    expect(store.save).toHaveBeenCalledTimes(1); expect(store.document).toBeNull()
    expect(await journal.get(original.id)).toEqual(original); expect(await journal.events()).toEqual(events)
    await expect(journal.start({ ...input, id: 'fresh-after-write-failure' })).resolves.toMatchObject({ id: 'fresh-after-write-failure' })
  })
})

const report: BrowserScriptRunReport = { result: { preserved: true }, logs: ['Original log'], outcome: { kind: 'completed' },
  runOperation: { id: 'fresh', browserId: 'original-page', operator: input.operator, startedAt: _tailFixtureEpoch(0, 0, 1), phase: 'completed', summary: 'Original program', url: input.url, steps: [] } }
describe('Browser operation identity carrier', () => {
  it('preserves actual refusal code, message and detail through a plain structured clone before unwrap', async () => {
    const failure = Object.assign(browserOperationAlreadyExistsError(), { detail: 'Original cleanup is unconfirmed' })
    const carrier = structuredClone(await browserRunResult(async () => { throw failure }))
    expect(carrier).toEqual({ ok: false, error: { code: 'BROWSER_OPERATION_ALREADY_EXISTS', message: failure.message, detail: failure.detail } })
    let caught: unknown
    try { unwrapBrowserRunResult(carrier) } catch (error) { caught = error }
    expect(caught).toBeInstanceOf(Error); expect(caught).toMatchObject({ code: failure.code, message: failure.message, detail: failure.detail })
    const parse = () => parseAgentMuxControlReceipt({ schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: 'original', operation: 'browser.run', ok: false, error: { code: failure.code, message: failure.message } })
    expect(parse).not.toThrow(); expect(parse()).toMatchObject({ ok: false, error: { code: failure.code } })
  })
  it('preserves the complete successful program report through the same copied carrier', async () => {
    expect(unwrapBrowserRunResult(structuredClone(await browserRunResult(async () => report)))).toEqual(report)
  })
})

const apiSource = readFileSync(process.env.AGENTMUX_BROWSER_IDENTITY_API_SOURCE ?? new URL('../src/renderer/src/lib/api.ts', import.meta.url), 'utf8')
function browserAdapter(preload: { browser: { runScript: (...args: unknown[]) => Promise<Awaited<ReturnType<typeof browserRunResult>>> } }) {
  const file = ts.createSourceFile('api.ts', apiSource, ts.ScriptTarget.Latest, true), found: ts.Node[] = []
  const owner = file.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'requireDesktopApi')
  expect(owner).toBeDefined()
  function walk(node: ts.Node) {
    if (ts.isPropertyAssignment(node) && node.name.getText(file) === 'browser') found.push(node.initializer)
    ts.forEachChild(node, walk)
  }
  walk(owner!); expect(found).toHaveLength(1)
  if (process.env.AGENTMUX_PERFORMANCE_LOADED) appendFileSync(process.env.AGENTMUX_PERFORMANCE_LOADED, JSON.stringify({ path: 'apps/desktop/src/renderer/src/lib/api.ts', sha256: createHash('sha256').update(apiSource).digest('hex'), kind: 'original-Renderer-browser-adapter' }) + '\n')
  const code = ts.transpile(`const browser = ${found[0]!.getText(file)}`, { target: ts.ScriptTarget.ES2022 })
  return new Function('preload', 'unwrapBrowserRunResult', code + ';return browser')(preload, unwrapBrowserRunResult) as { runScript(...args: unknown[]): Promise<BrowserScriptRunReport> }
}
describe('Browser operation identity Renderer boundary', () => {
  it('unwraps the copied real refusal in the production Browser adapter and retains successful reports', async () => {
    const failure = Object.assign(browserOperationAlreadyExistsError(), { detail: 'Original public recovery detail' })
    const preload = { browser: { runScript: vi.fn(async (..._args: unknown[]) => structuredClone(await browserRunResult(async () => { throw failure }))) } }
    const adapter = browserAdapter(preload)
    await expect(adapter.runScript('original-page', 'return 1', undefined, 'retained')).rejects.toMatchObject({ code: failure.code, message: failure.message, detail: failure.detail })
    expect(preload.browser.runScript).toHaveBeenCalledExactlyOnceWith('original-page', 'return 1', undefined, 'retained')
    preload.browser.runScript.mockImplementationOnce(async () => structuredClone(await browserRunResult(async () => report)))
    await expect(adapter.runScript('original-page', 'return 2')).resolves.toEqual(report)
  })
})

// Reuse the cold-owner fixture seam: execute the exact original IPC handler, not copied policy.
const ipcSource = readFileSync(process.env.AGENTMUX_BROWSER_IDENTITY_IPC_SOURCE ?? new URL('../src/main/ipc.ts', import.meta.url), 'utf8')
function runHandler(ports: Record<string, unknown>) {
  const file = ts.createSourceFile('ipc.ts', ipcSource, ts.ScriptTarget.Latest, true), found: ts.Node[] = []
  function walk(node: ts.Node) {
    if (ts.isCallExpression(node) && node.expression.getText(file) === 'handleWithEvent' && ts.isStringLiteral(node.arguments[0]!) && node.arguments[0].text === 'browser:runScript') found.push(node.arguments[1]!)
    ts.forEachChild(node, walk)
  }
  walk(file); expect(found).toHaveLength(1)
  if (process.env.AGENTMUX_PERFORMANCE_LOADED) appendFileSync(process.env.AGENTMUX_PERFORMANCE_LOADED, JSON.stringify({ path: 'apps/desktop/src/main/ipc.ts', sha256: createHash('sha256').update(ipcSource).digest('hex'), kind: 'original-IPC-handler' }) + '\n')
  const code = ts.transpile(`const execute = ${found[0]!.getText(file)}`, { target: ts.ScriptTarget.ES2022 })
  return new Function(...Object.keys(ports), code + ';return execute')(...Object.values(ports)) as (...args: unknown[]) => Promise<Awaited<ReturnType<typeof browserRunResult>>>
}
function publicPorts() {
  const browsers = { getOperation: vi.fn<BrowserOperationJournal['get']>(async () => null), runScript: vi.fn(async () => report) }
  return { browsers, config: { browser: { agentAutomation: true } }, requireTrustedSender: vi.fn(), ensureBrowser: vi.fn(async () => {}),
    browserRunResult, browserOperationAlreadyExistsError, workspace: vi.fn(), externalBridge: { require: vi.fn(() => ({ workspaceId: 'workspace' })) },
    externalBrowsers: { has: vi.fn(() => false), runScript: vi.fn(async () => report) } }
}
describe('Browser operation identity public admission', () => {
  it.each(['completed', 'indeterminate'] as const)('refuses retained %s before any cold acquisition or embedded/external program dispatch', async phase => {
    const ports = publicPorts(); ports.browsers.getOperation.mockResolvedValue({ ...report.runOperation, id: 'retained', phase, steps: [] })
    const result = await runHandler(ports)({}, 'original-page', 'return 1', undefined, 'retained')
    expect(result).toMatchObject({ ok: false, error: { code: 'BROWSER_OPERATION_ALREADY_EXISTS' } })
    expect(ports.browsers.getOperation).toHaveBeenCalledExactlyOnceWith('retained')
    expect(ports.ensureBrowser).not.toHaveBeenCalled(); expect(ports.browsers.runScript).not.toHaveBeenCalled(); expect(ports.externalBrowsers.runScript).not.toHaveBeenCalled()
  })
  it('keeps trusted/automation admission before observation and preserves fresh embedded/external operations', async () => {
    const ports = publicPorts(), handle = runHandler(ports)
    ports.config.browser.agentAutomation = false
    expect(await handle({}, 'original-page', 'return 1', undefined, 'fresh')).toMatchObject({ ok: false, error: { code: 'BROWSER_AUTOMATION_DISABLED' } })
    expect(ports.browsers.getOperation).not.toHaveBeenCalled(); expect(ports.ensureBrowser).not.toHaveBeenCalled()
    ports.config.browser.agentAutomation = true
    ports.requireTrustedSender.mockImplementationOnce(() => { throw Object.assign(new Error('Untrusted sender'), { code: 'CONTROL_PERMISSION_DENIED' }) })
    await expect(handle({}, 'original-page', 'return 1', undefined, 'fresh')).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
    expect(ports.browsers.getOperation).not.toHaveBeenCalled()
    expect(unwrapBrowserRunResult(await handle({}, 'original-page', 'return 1', undefined, 'fresh'))).toEqual(report)
    expect(ports.browsers.runScript).toHaveBeenCalledExactlyOnceWith('original-page', 'return 1', undefined, undefined, 'fresh')
    expect(ports.ensureBrowser).toHaveBeenCalledExactlyOnceWith('original-page')
    ports.externalBrowsers.has.mockReturnValue(true)
    expect(unwrapBrowserRunResult(await handle({}, 'external-page', 'return 2', undefined, 'fresh-external'))).toEqual(report)
    expect(ports.externalBrowsers.runScript).toHaveBeenCalledExactlyOnceWith('external-page', 'return 2', undefined, 'fresh-external')
    expect(ports.ensureBrowser).toHaveBeenCalledTimes(1)
  })
})
