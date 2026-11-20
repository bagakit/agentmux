import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { BrowserOperationFileStore, BrowserOperationJournal } from '@agentmux/browser/operations'
import { BrowserStepEvidenceStore } from '@agentmux/browser/operations'
import { BrowserResultArtifactStore } from '@agentmux/browser/operations'
import { BrowserProgramOwner } from '@agentmux/browser/operations'
import type { BrowserProgramPort, BrowserProgramTarget } from '@agentmux/browser/operations'

it('the shared program owner forwards exact screenshot options through its real runner and dispatch without claiming host decoration exclusion', async () => {
  const root = await mkdtemp(join(tmpdir(), 'amux-shared-capture-'))
  const data = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aCq8AAAAASUVORK5CYII='
  const target: BrowserProgramTarget = { id: 'original-shared-page', workspaceId: 'original-workspace', navigationId: 'original-document',
    url: 'https://example.test/', title: 'Original page', status: 'ready', connection: { id: 'original-connection' } }
  const sent: { method: string; params: unknown }[] = []
  // Native transport and the host's additional wire validator are controlled.
  // The real owner, worker, dispatcher, preparation, journal and PNG boundary execute.
  const port: BrowserProgramPort = { has: id => id === target.id, require: () => target, stopOperation: () => {}, recordLedger: () => {},
    observe: () => () => {}, observeAvailability: () => () => {}, dispose: async () => {}, attach: async () => ({
      frames: new Map(), endedReason: null, frameDiscoveryFailure: null, detach: async () => undefined, observe: () => () => {},
      sendCommand: async (method, params) => {
        sent.push({ method, params })
        if (method === 'Runtime.evaluate') return { result: { value: (params as { expression?: string } | undefined)?.expression?.includes('devicePixelRatio')
          ? { width: 200, height: 100, deviceScaleFactor: 2 } : { url: target.url, title: target.title } } }
        if (method === 'Page.getLayoutMetrics') return { cssVisualViewport: { pageX: 10, pageY: 100, zoom: 1, clientWidth: 200, clientHeight: 100 } }
        if (method === 'Page.captureScreenshot') return { data }
        return {}
      }
    }) }
  const owner = new BrowserProgramOwner(port, { journal: new BrowserOperationJournal(new BrowserOperationFileStore(join(root, 'operations.json'))),
    refs: { read: async () => null, write: async () => {} }, evidence: new BrowserStepEvidenceStore(join(root, 'evidence')),
    results: new BrowserResultArtifactStore(join(root, 'results')), validateScreenshot: () => {} })
  try {
    const report = await owner.runScript(target.id, 'return await captureScreenshot({clip:{x:2,y:3,width:1,height:1},pixelRatio:1})')
    expect(report.outcome.kind).toBe('completed')
    expect(report.result).toMatchObject({ browserId: target.id, navigationId: target.navigationId,
      source: { hostOverlays: 'unconfirmed', region: { x: 2, y: 3, width: 1, height: 1, pixelRatio: 1 } }, image: { width: 1, height: 1 } })
    expect(sent.filter(row => row.method === 'Page.captureScreenshot')).toEqual([{ method: 'Page.captureScreenshot', params: {
      format: 'png', fromSurface: true, captureBeyondViewport: false, clip: { x: 12, y: 103, width: 1, height: 1, scale: 0.5 }
    } }])
    expect(sent.filter(row => /^(Input\.|Emulation\.)/u.test(row.method))).toEqual([])
    expect(target.connection?.id).toBe('original-connection')
    expect(report.runOperation?.steps).toContainEqual(expect.objectContaining({ method: 'captureScreenshot' }))
  } finally { await owner.dispose(); await rm(root, { recursive: true, force: true }) }
}, 10_000)
