import { fixtureEpoch as _tailFixtureEpoch } from "../../../test/fixture-values.mjs"
import { appendFileSync, readFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'
import { BrowserOperationFileStore, BrowserOperationJournal, browserOperationAlreadyExistsError,
  type BrowserOperationEvent, type BrowserOperationJournalDocument } from '../src/main/browser-operation-journal.js'
import { browserRunResult } from '../src/shared/browser-run-result.js'
import type { BrowserOperation } from '../src/shared/browser-operation.js'
import { rpcControlRequest, parseRpcControlResult } from '../../../packages/core/src/rpc-business-codec.js'

const composite = ' ' + 'x'.repeat(240) + '界'.repeat(20) + '😀'.repeat(50)
const identities = ['x'.repeat(241), 'x'.repeat(512), 'é'.repeat(256), '😀'.repeat(128), composite + ' A ', ' padded ']
const input = { browserId: 'original-page', operator: { id: 'operator', name: 'Operator' }, summary: 'Original operation', url: 'https://fixture.invalid/page' }
const operation = (id: string): BrowserOperation => ({ ...input, id, startedAt: _tailFixtureEpoch(0, 0, 1), finishedAt: _tailFixtureEpoch(0, 0, 2), phase: 'completed', steps: [] })
const admitted = (id: string) => rpcControlRequest('browser.run', { browserId: input.browserId, operationId: id, code: 'return 1' })

describe('Browser operation exact identity', () => {
  it.each(identities)('preserves an admitted machine value through SQLite reopen, step keys and subscription backlog: %s', async id => {
    expect(admitted(id)).toMatchObject({ operation: 'browser.run', operationId: id, requestId: id })
    const directory = await mkdtemp(join(tmpdir(), 'browser-exact-identity-'))
    try {
      const path = join(directory, 'operations.sqlite'), journal = new BrowserOperationJournal(new BrowserOperationFileStore(path))
      expect((await journal.start({ ...input, id })).id).toBe(id)
      const delivered = vi.fn(), subscription = await journal.subscribe(id, undefined, delivered)
      expect(subscription.operation?.id).toBe(id)
      expect(subscription.backlog.map(row => row.event.operationId)).toEqual([id])
      await journal.setPhase(id, 'running')
      const step = await journal.startStep(id, { method: 'snapshot', label: 'Original observed page' })
      expect(step?.sequence).toBe(1)
      await journal.finishStep(id, 1, { status: 'completed' })
      await journal.finish(id, 'completed')
      expect(delivered.mock.calls.length).toBeGreaterThan(0)
      expect(delivered.mock.calls.every(([row]) => row.event.operationId === id)).toBe(true)
      subscription.dispose()
      const reopened = new BrowserOperationJournal(new BrowserOperationFileStore(path)), record = await reopened.get(id)
      expect(record).toMatchObject({ id, phase: 'completed', steps: [{ sequence: 1, status: 'completed' }] })
      const events = await reopened.events(id)
      expect(events.map(event => event.type)).toEqual(['operation-started', 'phase-changed', 'step-started', 'step-finished', 'operation-finished'])
      expect(events.every(event => event.operationId === id && (!('operation' in event) || event.operation.id === id))).toBe(true)
      const backlog = await reopened.subscribe(id, undefined, () => {})
      expect(backlog.operation?.id).toBe(id); expect(backlog.backlog).toHaveLength(5)
      expect(backlog.backlog.every(row => row.event.operationId === id)).toBe(true); backlog.dispose()
      expect(parseRpcControlResult('browser.inspect', { runOperation: record }, { operationId: id })).toMatchObject({ runOperation: { id } })
      expect(parseRpcControlResult('browser.stop', { runOperation: record }, { operationId: id })).toMatchObject({ runOperation: { id } })
      expect(() => parseRpcControlResult('browser.inspect', { runOperation: { ...record, id: id + 'different' } }, { operationId: id })).toThrow()
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('keeps same-prefix and padded values distinct while retaining actual old shortened identities and blank-only minting', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'browser-exact-distinct-'))
    try {
      let minted = 0
      const path = join(directory, 'operations.sqlite'), journal = new BrowserOperationJournal(new BrowserOperationFileStore(path), { id: () => `generated-${++minted}` })
      const old = 'x'.repeat(239) + '…', ids = [old, 'x'.repeat(240) + 'A', 'x'.repeat(240) + 'B', 'padded', ' padded ']
      for (const id of ids) { await expect(journal.start({ ...input, id })).resolves.toMatchObject({ id }); await journal.finish(id, 'completed') }
      expect((await journal.start(input)).id).toBe('generated-1')
      expect((await journal.start({ ...input, id: '  ' })).id).toBe('generated-2')
      const reopened = new BrowserOperationJournal(new BrowserOperationFileStore(path))
      for (const id of ids) expect(await reopened.get(id)).toMatchObject({ id, phase: 'completed' })
      expect(() => admitted('x'.repeat(513))).toThrow()
      expect(() => admitted('😀'.repeat(129))).toThrow()
      expect(() => admitted('   ')).toThrow()
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  const id = composite + ' B '
  const eventCases: BrowserOperationEvent[] = [
    ...(['operation-started', 'operation-finished', 'operation-checked'] as const).map(type => ({ type, operationId: id, at: _tailFixtureEpoch(0, 0, 2), operation: operation(id) })),
    ...(['step-started', 'step-finished'] as const).map(type => ({ type, operationId: id, at: _tailFixtureEpoch(0, 0, 2), step: { sequence: 1, method: 'snapshot', label: 'Original step', startedAt: _tailFixtureEpoch(0, 0, 1), status: 'completed' as const, finishedAt: _tailFixtureEpoch(0, 0, 2) } })),
    { type: 'phase-changed', operationId: id, at: _tailFixtureEpoch(0, 0, 2), phase: 'running', warning: 'Original phase notice' },
    { type: 'operation-recovered', operationId: id, at: _tailFixtureEpoch(0, 0, 2), warning: 'Original recovery notice' }
  ]
  it.each(eventCases)('loads the original JSON event identity without changing its family: $type', async event => {
    const directory = await mkdtemp(join(tmpdir(), 'browser-exact-json-'))
    try {
      const path = join(directory, 'operations.json'), document: BrowserOperationJournalDocument = { version: 1, operations: [operation(id)], events: [event] }
      await writeFile(path, JSON.stringify(document))
      const journal = new BrowserOperationJournal(new BrowserOperationFileStore(path))
      expect(await journal.get(id)).toMatchObject({ id })
      expect(await journal.events(id)).toEqual([event])
      const subscription = await journal.subscribe(id, undefined, () => {})
      expect(subscription.backlog.map(row => row.event)).toEqual([event]); subscription.dispose()
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('retains the exact interrupted SQLite operation and step/event keys after a second owner loads the original file', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'browser-exact-recovery-'))
    try {
      const path = join(directory, 'operations.sqlite'), first = new BrowserOperationJournal(new BrowserOperationFileStore(path))
      await first.start({ ...input, id }); await first.startStep(id, { method: 'click', label: 'Original action' })
      const reopened = new BrowserOperationJournal(new BrowserOperationFileStore(path))
      expect(await reopened.get(id)).toMatchObject({ id, phase: 'indeterminate', steps: [{ sequence: 1, status: 'stopped' }] })
      expect((await reopened.events(id)).map(event => event.type)).toEqual(['operation-started', 'step-started', 'operation-recovered'])
      const third = new BrowserOperationJournal(new BrowserOperationFileStore(path))
      expect(await third.get(id)).toEqual(await reopened.get(id))
      const events = await third.events(id)
      expect(events.map(event => event.type)).toEqual(['operation-started', 'step-started', 'operation-recovered'])
      expect(events.every(event => event.operationId === id)).toBe(true)
      expect(parseRpcControlResult('browser.stop', { runOperation: await third.get(id) }, { operationId: id })).toMatchObject({ runOperation: { id, phase: 'indeterminate' } })
    } finally { await rm(directory, { recursive: true, force: true }) }
  })
})

// Execute the original Main admission body with a real Journal lookup, not a duplicate policy copy.
const ipcSource = readFileSync(process.env.AGENTMUX_BROWSER_IDENTITY_IPC_SOURCE ?? new URL('../src/main/ipc.ts', import.meta.url), 'utf8')
function handler(ports: Record<string, unknown>) {
  const file = ts.createSourceFile('ipc.ts', ipcSource, ts.ScriptTarget.Latest, true), found: ts.Node[] = []
  const visit = (node: ts.Node) => { if (ts.isCallExpression(node) && node.expression.getText(file) === 'handleWithEvent' && ts.isStringLiteral(node.arguments[0]!) && node.arguments[0].text === 'browser:runScript') found.push(node.arguments[1]!); ts.forEachChild(node, visit) }
  visit(file); expect(found).toHaveLength(1)
  if (process.env.AGENTMUX_PERFORMANCE_LOADED) appendFileSync(process.env.AGENTMUX_PERFORMANCE_LOADED, JSON.stringify({ path: 'apps/desktop/src/main/ipc.ts', sha256: createHash('sha256').update(ipcSource).digest('hex'), kind: 'original-IPC-handler' }) + '\n')
  return new Function(...Object.keys(ports), ts.transpile(`const execute = ${found[0]!.getText(file)}`, { target: ts.ScriptTarget.ES2022 }) + ';return execute')(...Object.values(ports)) as (...args: unknown[]) => Promise<Awaited<ReturnType<typeof browserRunResult>>>
}
describe('Browser operation exact identity public forwarding', () => {
  it.each(identities)('uses the real original Journal identity before acquiring or dispatching a repeated request: %s', async id => {
    const directory = await mkdtemp(join(tmpdir(), 'browser-exact-admission-'))
    try {
      const path = join(directory, 'operations.sqlite'), first = new BrowserOperationJournal(new BrowserOperationFileStore(path))
      await first.start({ ...input, id }); await first.finish(id, 'completed')
      const journal = new BrowserOperationJournal(new BrowserOperationFileStore(path)), record = await journal.get(id)
      const ports = { browsers: { getOperation: vi.fn((key: string) => journal.get(key)), runScript: vi.fn() }, ensureBrowser: vi.fn(), config: { browser: { agentAutomation: true } }, requireTrustedSender: vi.fn(),
        browserRunResult, browserOperationAlreadyExistsError, workspace: vi.fn(), externalBridge: { require: vi.fn() }, externalBrowsers: { has: vi.fn(() => false), runScript: vi.fn() } }
      const request = admitted(id)
      expect(request).toMatchObject({ operationId: id })
      expect(await handler(ports)({}, input.browserId, 'return 1', undefined, id)).toMatchObject({ ok: false, error: { code: 'BROWSER_OPERATION_ALREADY_EXISTS' } })
      expect(ports.browsers.getOperation).toHaveBeenCalledExactlyOnceWith(id)
      expect(ports.ensureBrowser).not.toHaveBeenCalled(); expect(ports.browsers.runScript).not.toHaveBeenCalled(); expect(ports.externalBrowsers.runScript).not.toHaveBeenCalled()
      expect(await journal.get(id)).toEqual(record)
    } finally { await rm(directory, { recursive: true, force: true }) }
  })
})
