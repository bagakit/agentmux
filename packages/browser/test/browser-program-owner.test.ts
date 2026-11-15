import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { BrowserOperationFileStore, BrowserOperationJournal } from '../src/browser-operation-journal.js'
import { BrowserProgramOwner } from '../src/browser-program-owner.js'
import type { BrowserProgramPort, BrowserProgramTarget } from '../src/browser-program-port.js'
import { BrowserResultArtifactStore } from '../src/browser-result-artifact.js'
import { BrowserStepEvidenceStore } from '../src/browser-step-evidence.js'

it('retains the result and history when an original debugger release rejects', async () => {
  const root = await mkdtemp(join(tmpdir(), 'amux-program-owner-'))
  const target: BrowserProgramTarget = { id: 'b1', navigationId: 'n1', workspaceId: null, url: 'https://example.invalid/',
    title: '', status: 'ready', connection: { id: 'original-connection' } }
  const detach = vi.fn(async (): Promise<void> => {}).mockRejectedValueOnce(new Error('Release failed'))
  const port: BrowserProgramPort = {
    require: () => target, has: () => true, stopOperation() {}, recordLedger() {}, async dispose() {},
    async attach() {
      return { async sendCommand() { return {} }, frames: new Map(), endedReason: null, frameDiscoveryFailure: null,
        observe: () => () => {}, async detach() { await detach(); return undefined } }
    },
    observe: () => () => {}, observeAvailability: () => () => {}
  }
  const journal = new BrowserOperationJournal(new BrowserOperationFileStore(join(root, 'journal.json')))
  const owner = new BrowserProgramOwner(port, { journal, refs: { async read() { return null }, async write() {} },
    results: new BrowserResultArtifactStore(join(root, 'results')), evidence: new BrowserStepEvidenceStore(join(root, 'evidence')), validateScreenshot() {} })
  try {
    const first = await owner.runScript(target.id, 'return 11', undefined, 'first-operation')
    expect(first).toMatchObject({ result: 11, outcome: { kind: 'completed' }, runOperation: { id: 'first-operation' } })
    const warning = 'debugger detach could not be confirmed'
    expect(first.runOperation.warning).toContain(warning)
    expect(await journal.get('first-operation')).toMatchObject({ phase: 'completed', warning: expect.stringContaining(warning) })
    await expect(owner.runScript(target.id, 'return 12', undefined, 'next-operation')).resolves.toMatchObject({ result: 12, outcome: { kind: 'completed' } })
    expect(detach).toHaveBeenCalledTimes(2)
  } finally {
    await owner.dispose()
    await rm(root, { recursive: true, force: true })
  }
}, 30_000)
