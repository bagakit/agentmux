import { existsSync, readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'
import assert from 'node:assert/strict'

// Execute the actual canonical function bytes without its top-level Electron launch.
// Explicit Electron/CDP doubles below are Source evidence, never Native evidence.
const source = readFileSync(new URL('../scripts/verify-browser-recovery-restart.mjs', import.meta.url), 'utf8')
function canonical(name: string, globals: Record<string, unknown>) {
  const file = ts.createSourceFile('canonical.mjs', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  const matches = file.statements.filter(node => ts.isFunctionDeclaration(node) && node.name?.text === name)
  expect(matches).toHaveLength(1)
  return new Function(...Object.keys(globals), `return (${matches[0]!.getText(file)})`)(...Object.values(globals))
}

describe('canonical Browser recovery boundaries', () => {
  it('binds every static production source identity to an existing repository file', () => {
    const file = ts.createSourceFile('canonical.mjs', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
    const identity = file.statements.filter(node => ts.isFunctionDeclaration(node) && node.name?.text === 'identity')
    expect(identity).toHaveLength(1)
    const paths = new Set<string>()
    const visit = (node: ts.Node) => {
      if (ts.isStringLiteral(node) && /^(apps|packages)\/.*\/src\//.test(node.text)) paths.add(node.text)
      ts.forEachChild(node, visit)
    }
    visit(identity[0]!)
    expect(paths.size).toBeGreaterThan(0)
    for (const path of paths) expect(existsSync(new URL(`../../../${path}`, import.meta.url)), path).toBe(true)
  })

  it('joins the actual error document by original visible Region geometry without navigating it', async () => {
    const regions = [{ regionId: 'original', browserId: 'browser-a', url: 'http://fixture/disconnected' }, { regionId: 'sibling', browserId: 'browser-b', url: 'http://fixture/b' }]
    const stages = regions.map((region, i) => ({ regionId: region.regionId, x: i * 240, y: 50, width: 234.5, height: 300 }))
    const loadURL = vi.fn()
    const views = stages.map((stage, i) => ({ getVisible: (): boolean => true, getBounds: () => ({ x: stage.x * 1.25, y: stage.y * 1.25, width: stage.width * 1.25, height: stage.height * 1.25 }), webContents: {
      id: i + 3, isDestroyed: () => false, isLoading: () => false, getURL: () => i ? regions[1]!.url : '', getTitle: () => i ? 'Sibling' : 'Unavailable page', loadURL,
      capturePage: async () => ({ isEmpty: () => false, getSize: () => ({ width: 293, height: 375 }) }), executeJavaScript: async () => i ? 'Actual sibling page' : 'Original failed destination'
    } }))
    const main = { evaluate: async (expression: string) => JSON.parse(JSON.stringify(await runInNewContext(expression, { process: { getBuiltinModule: () => ({ createRequire: () => () => ({ BrowserWindow: { getAllWindows: () => [{ webContents: { getZoomFactor: () => 1.25 }, contentView: { children: views } }] } }) }) } }))) }
    const cdp = { evaluate: vi.fn(async () => stages) }
    const waitFor = async (_label: string, read: () => unknown) => read()
    const read = canonical('nativeRegionPages', { waitFor, desktopRoot: '/private-candidate', join: (...parts: string[]) => parts.join('/') })
    const result = await read({ cdp, main }, regions)
    expect(result).toHaveLength(2)
    expect(result.map((page: { regionId: string; url: string; visible: boolean }) => [page.regionId, page.url, page.visible])).toEqual([['original', '', true], ['sibling', regions[1]!.url, true]])
    expect(result[0].text).toBe('Original failed destination')
    expect(loadURL).not.toHaveBeenCalled()
    views[0]!.getVisible = () => false
    expect(await read({ cdp, main }, regions)).toBeNull()
    views[0]!.getVisible = () => true
    views[0]!.getBounds = () => ({ x: 900, y: 900, width: 293, height: 375 })
    expect(await read({ cdp, main }, regions)).toBeNull()
  })

  it('signals only positively discovered private PIDs through the ownership recheck', async () => {
    const listProbeProcesses = vi.fn().mockResolvedValueOnce([41001]).mockResolvedValue([])
    const signalOwnedProbeProcess = vi.fn(async () => true)
    const cleanup = canonical('cleanupOwnedProbes', { assert, listProbeProcesses, signalOwnedProbeProcess, delay: async () => {} })
    expect(await cleanup('/tmp/unique-browser-root')).toEqual({ remaining: [], errors: [] })
    expect(listProbeProcesses.mock.calls.length).toBeGreaterThan(0)
    expect(listProbeProcesses.mock.calls).toEqual(Array.from({ length: listProbeProcesses.mock.calls.length }, () => [0, '/tmp/unique-browser-root']))
    expect(signalOwnedProbeProcess.mock.calls).toEqual([[41001, '/tmp/unique-browser-root', 'SIGTERM']])
  })

  it('keeps unknown identity failure honest and never signals a guessed group or sentinel', async () => {
    const listProbeProcesses = vi.fn().mockResolvedValueOnce([41001]).mockResolvedValue([])
    const signalOwnedProbeProcess = vi.fn(async () => { throw new Error('Private process identity changed') })
    const cleanup = canonical('cleanupOwnedProbes', { assert, listProbeProcesses, signalOwnedProbeProcess, delay: async () => {} })
    expect(await cleanup('/tmp/unique-browser-root')).toEqual({ remaining: [], errors: ['Private process identity changed'] })
    expect(signalOwnedProbeProcess.mock.calls).toEqual([[41001, '/tmp/unique-browser-root', 'SIGTERM']])
  })

  it('rejects two retained Regions that both claim the same unique geometry owner', async () => {
    const regions = [{ regionId: 'original', browserId: 'browser-a' }, { regionId: 'sibling', browserId: 'browser-b' }]
    const bounds = { x: 10, y: 50, width: 234.5, height: 300 }
    const stages = regions.map(region => ({ regionId: region.regionId, ...bounds }))
    const view = { getVisible: () => true, getBounds: () => bounds, webContents: {
      id: 30, isDestroyed: () => false, isLoading: () => false, getURL: () => '', getTitle: () => 'Original error document',
      capturePage: async () => ({ isEmpty: () => false, getSize: () => ({ width: 235, height: 300 }) }),
      executeJavaScript: async () => 'Original failed destination'
    } }
    const main = { evaluate: async (expression: string) => JSON.parse(JSON.stringify(await runInNewContext(expression, {
      process: { getBuiltinModule: () => ({ createRequire: () => () => ({ BrowserWindow: {
        getAllWindows: () => [{ webContents: { getZoomFactor: () => 1 }, contentView: { children: [view] } }]
      } }) }) }
    }))) }
    const read = canonical('nativeRegionPages', { waitFor: async (_label: string, read: () => unknown) => read(),
      desktopRoot: '/private-candidate', join: (...parts: string[]) => parts.join('/') })
    expect(await read({ main, cdp: { evaluate: async () => stages } }, regions)).toBeNull()
  })

  it('keeps EPERM honest while still attempting the other positively owned PID', async () => {
    const temporaryRoot = '/tmp/unique-browser-root', remaining = new Set([41001, 41002])
    const listProbeProcesses = vi.fn(async () => [...remaining])
    const signalOwnedProbeProcess = vi.fn(async (pid: number) => {
      if (pid === 41001) throw Object.assign(new Error('EPERM: private PID could not be signalled'), { code: 'EPERM' })
      remaining.delete(pid); return true
    })
    let tick = 0
    const cleanup = canonical('cleanupOwnedProbes', { assert, listProbeProcesses, signalOwnedProbeProcess,
      delay: async () => {}, Date: { now: () => ++tick * 1_000 } })
    const result = await cleanup(temporaryRoot)
    expect(signalOwnedProbeProcess.mock.calls).toEqual([[41001, temporaryRoot, 'SIGTERM'], [41002, temporaryRoot, 'SIGTERM'], [41001, temporaryRoot, 'SIGKILL']])
    expect(result.remaining).toEqual([41001])
    expect(result.errors).toEqual(expect.arrayContaining(['EPERM: private PID could not be signalled']))
  })

  it('rechecks unique geometry at actual pixel capture after the successful preflight', async () => {
    async function execute(duplicate: boolean) {
      const stage = { x: 10, y: 50, width: 234.5, height: 300 }, captures: number[] = []
      const image = { isEmpty: () => false, getSize: () => ({ width: 235, height: 300 }), toPNG: () => Buffer.from([1, 2, 3]) }
      const view = (id: number) => ({ getVisible: () => true, getBounds: () => stage, webContents: {
        id, isDestroyed: () => false, isLoading: () => false, getURL: () => '',
        capturePage: async () => { captures.push(id); return image }
      } })
      const children = [view(30)]
      const window = { webContents: { getZoomFactor: () => 1, capturePage: async () => image }, contentView: { children } }
      const main = { evaluate: async (expression: string) => JSON.parse(JSON.stringify(await runInNewContext(expression, {
        process: { getBuiltinModule: (name: string) => name === 'module' ? { createRequire: () => () => ({ BrowserWindow: { getAllWindows: () => [window] } }) }
          : name === 'fs' ? { writeFileSync: () => {} } : name === 'crypto' ? { createHash: () => ({ update: () => ({ digest: () => 'fake-captured-bytes-hash' }) }) } : null }
      }))) }
      const observation = { viewport: { width: 1000, height: 720 }, rows: [{ sequence: '1', status: 'failed' }], stage,
        trace: { x: 10, y: 400, width: 234.5, height: 200 } }
      const cdp = { evaluate: async (expression: string) => expression.startsWith('new Promise') ? undefined : JSON.parse(JSON.stringify(observation)) }
      const receipt = { visual: { frames: [] } }
      const capture = canonical('capture', { assert, waitFor: async (_label: string, read: () => unknown) => read(),
        desktopRoot: '/private-candidate', join: (...parts: string[]) => parts.join('/'), receipt,
        captureDirectory: '/private-captures', localRecoveryCase: true,
        captureOsWindow: async () => { if (duplicate) children.push(view(31)) } })
      await capture({ main, cdp }, 'actual-error-view', 'operations', '')
      return { receipt, captures }
    }
    const single = await execute(false)
    expect(single.captures).toEqual([30]); expect(single.receipt.visual.frames).toHaveLength(1)
    await expect(execute(true)).rejects.toThrow()
  })
})
