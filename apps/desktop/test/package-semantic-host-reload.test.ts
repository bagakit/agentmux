import { fixturePath as _reshape_fixturePath } from "../../../test/fixture-values.mjs"
import { fixturePath as _hygiene_fixturePath, fixturePsBirth as _hygiene_fixturePsBirth } from "../scripts/lib/fixture-values.mjs"
import { describe, it, expect, vi } from 'vitest'
import { readFile } from 'node:fs/promises'
import ts from 'typescript'
import { assertSemanticHostOwner, prepareSemanticHostReload, stopSemanticHostForInstall,
  confirmSemanticHostReload } from '../scripts/package-semantic-host.mjs'

const app = _reshape_fixturePath("Applications/AgentMux.app"), candidate = _reshape_fixturePath("Applications/.AgentMux.candidate.app")
const store = (_hygiene_fixturePath("data/original") + " workbench/agent-sessions.json")
const command = `${app}/Contents/MacOS/AgentMux ${app}/Contents/Resources/app/out/main/agentmux-host.js --store ${store}`
const original = { uid: process.getuid!(), pid: 211, ppid: 201, birth: _hygiene_fixturePsBirth(24022800000), command }
const identity = { hostProcessId: original.pid, storePath: store }
const modeFor = (row = original) => ({ ...row, mode: 'node', executable: `${app}/Contents/MacOS/AgentMux` })

function fixture() {
  let row: typeof original | null = { ...original }, time = 0
  let source = 'a'.repeat(40), serving = [201, 211], externalNode: number[] = []
  let publicIdentity = { ...identity }
  const events: string[] = []
  const ops = {
    source: vi.fn(async (path: string) => path === candidate ? 'b'.repeat(40) : source),
    bootstrap: vi.fn(async () => { events.push('bootstrap'); return publicIdentity }),
    processRow: vi.fn(async (pid: number) => { events.push('row'); return row?.pid === pid ? { ...row } : null }),
    processes: vi.fn(async () => ({ serving, externalNode, processes: row ? [row] : [], nodeModes: row ? [modeFor(row)] : [] })),
    bundleImage: vi.fn(async () => ({ device: '1', inode: '2' })),
    processImage: vi.fn(async () => ({ device: '1', inode: '2' })),
    signal: vi.fn((pid: number, signal: string) => { events.push(`signal:${pid}:${signal}`); row = null }),
    now: () => time,
    wait: vi.fn(async () => { time += 1000 })
  }
  return { ops, events,
    quit: () => { row = { ...original, ppid: 1 }; serving = []; externalNode = [211, 999] },
    mutate: (next: Partial<typeof original>) => { row = { ...row!, ...next } },
    namespace: (next: Partial<typeof identity>) => { publicIdentity = { ...publicIdentity, ...next } },
    launch: () => { source = 'b'.repeat(40); row = { ...original, pid: 212 }; publicIdentity = { ...identity, hostProcessId: 212 }; serving = [201, 212]; externalNode = [] },
    source: (next: string) => { source = next }
  }
}

describe('the original Semantic Host follows a full Source installation', () => {
  it('admits the identified GUI-child Node, then signals only that namespace after normal GUI exit', async () => {
    const f = fixture(), plan = await prepareSemanticHostReload(app, candidate, f.ops)
    expect(plan.owner.pid).toBe(211)
    expect(f.ops.signal).not.toHaveBeenCalled()
    f.quit()
    await stopSemanticHostForInstall(plan, f.ops)
    expect(f.ops.signal.mock.calls).toEqual([[211, 'SIGTERM']])
    expect(f.events.slice(0, f.events.indexOf('signal:211:SIGTERM'))).toContain('bootstrap')
    f.launch()
    await expect(confirmSemanticHostReload(plan, app, f.ops)).resolves.toBeUndefined()
    expect(f.ops.signal.mock.calls).toEqual([[211, 'SIGTERM']])
  })

  it('qualifies and reloads the original same-Source namespace for a full App replacement', async () => {
    const f = fixture(); f.source('b'.repeat(40))
    const plan = await prepareSemanticHostReload(app, candidate, f.ops)
    expect(plan, 'A full directory replacement must qualify its original same-Source owner').not.toBeNull()
    expect(plan.originalSource).toBe(plan.candidateSource)
    expect(plan.owner.pid).toBe(original.pid)
    expect(f.ops.bootstrap).toHaveBeenCalledOnce(); expect(f.ops.signal).not.toHaveBeenCalled()
    f.quit()
    await stopSemanticHostForInstall(plan, f.ops)
    expect(f.ops.signal.mock.calls).toEqual([[211, 'SIGTERM']])
    f.launch()
    await expect(confirmSemanticHostReload(plan, app, f.ops)).resolves.toBeUndefined()
  })

  it('keeps the cold path when no bundle Semantic Host exists', async () => {
    const f = fixture(); f.ops.processes.mockResolvedValue({ serving: [], externalNode: [], processes: [], nodeModes: [] })
    expect(await prepareSemanticHostReload(app, candidate, f.ops)).toBeNull()
    expect(f.ops.bootstrap).not.toHaveBeenCalled()
  })

  it('captures a late Host after normal GUI quit, before replacing the original App', async () => {
    const f = fixture()
    f.ops.processes.mockResolvedValueOnce({ serving: [], externalNode: [], processes: [], nodeModes: [] })
    expect(await prepareSemanticHostReload(app, candidate, f.ops)).toBeNull()
    f.quit()
    const late = await prepareSemanticHostReload(app, candidate, f.ops)
    expect(late.owner.pid).toBe(211)
    await stopSemanticHostForInstall(late, f.ops)
    expect(f.ops.signal.mock.calls).toEqual([[211, 'SIGTERM']])
  })

  it.each([
    ['PID', { pid: 999 }], ['UID', { uid: process.getuid!() + 1 }],
    ['argv', { command: ("" + (app) + ("/Contents/MacOS/AgentMux " + _hygiene_fixturePath("other-worker.js") + " --store ") + (store) + "") }]
  ])('rejects a mismatched %s without signalling any process', (_name, delta) => {
    const row = { ...original, ...delta }
    expect(() => assertSemanticHostOwner(app, identity, row, modeFor(row))).toThrow()
  })

  it.each([
    { mode: 'gui' }, { mode: 'unknown' }, { birth: 'another birth' },
    { pid: 999 }, { uid: process.getuid!() + 1 }, { ppid: 999 }, { executable: _hygiene_fixturePath("other/AgentMux") }
  ])('requires a bound kernel mode and birth (%j)', delta => {
    expect(() => assertSemanticHostOwner(app, identity, original, { ...modeFor(), ...delta })).toThrow()
  })

  it('rejects PID reuse, another Store or an intervening installation before signal', async () => {
    for (const change of ['birth', 'store', 'pid', 'source']) {
      const f = fixture(), plan = await prepareSemanticHostReload(app, candidate, f.ops); f.quit()
      if (change === 'birth') f.mutate({ birth: 'another birth' })
      if (change === 'store') f.namespace({ storePath: _hygiene_fixturePath("data/other.json") })
      if (change === 'pid') f.namespace({ hostProcessId: 999 })
      if (change === 'source') f.source('c'.repeat(40))
      await expect(stopSemanticHostForInstall(plan, f.ops)).rejects.toThrow()
      expect(f.ops.signal).not.toHaveBeenCalled()
    }
  })

  it('waits for actual GUI exit and external Node ancestry before shutdown', async () => {
    const f = fixture(), plan = await prepareSemanticHostReload(app, candidate, f.ops)
    await expect(stopSemanticHostForInstall(plan, f.ops)).rejects.toThrow('GUI')
    expect(f.ops.signal).not.toHaveBeenCalled()
  })

  it('never escalates a delayed Host shutdown to kill or Native signals', async () => {
    const f = fixture(), plan = await prepareSemanticHostReload(app, candidate, f.ops); f.quit()
    f.ops.signal.mockImplementation(() => {})
    await expect(stopSemanticHostForInstall(plan, f.ops)).rejects.toThrow('No force kill')
    expect(f.ops.signal.mock.calls).toEqual([[211, 'SIGTERM']])
  })

  it('does not claim activation for the retained old Host or wrong new namespace', async () => {
    const f = fixture(), plan = await prepareSemanticHostReload(app, candidate, f.ops)
    await expect(confirmSemanticHostReload(plan, app, f.ops)).rejects.toThrow('Source')
    f.source('b'.repeat(40))
    await expect(confirmSemanticHostReload(plan, app, f.ops)).rejects.toThrow('Semantic Host namespace')
    f.launch(); f.namespace({ storePath: _hygiene_fixturePath("data/other.json") })
    await expect(confirmSemanticHostReload(plan, app, f.ops)).rejects.toThrow('Semantic Host namespace')
  })

  it('protects Native and other Node workers from an erroneous public PID', () => {
    const daemon = { ...original, pid: 999, command: ("" + (app) + ("/Contents/Resources/app/vendor/ctxmuxd --socket " + _hygiene_fixturePath("data/runtime.sock"))) }
    expect(() => assertSemanticHostOwner(app, { ...identity, hostProcessId: 999 }, daemon, modeFor(daemon))).toThrow()
  })

  it('rejects another PID still mapped to the old App image or an intervening bundle replacement', async () => {
    for (const fact of ['mapped', 'installed']) {
      const f = fixture(), plan = await prepareSemanticHostReload(app, candidate, f.ops)
      f.launch()
      if (fact === 'mapped') f.ops.processImage.mockResolvedValue({ device: '1', inode: '3' })
      else f.ops.bundleImage.mockResolvedValue({ device: '1', inode: '3' })
      await expect(confirmSemanticHostReload(plan, app, f.ops)).rejects.toThrow('App image')
      expect(f.ops.signal).not.toHaveBeenCalled()
    }
  })

  it('does not attribute an image read to a recycled Host PID', async () => {
    const f = fixture(), plan = await prepareSemanticHostReload(app, candidate, f.ops)
    f.launch()
    f.ops.processImage.mockImplementation(async () => { f.mutate({ birth: 'another birth' }); return { device: '1', inode: '2' } })
    await expect(confirmSemanticHostReload(plan, app, f.ops)).rejects.toThrow('App image')
    expect(f.ops.signal).not.toHaveBeenCalled()
  })

  it('the real installer rechecks a cold Host after quit and confirms its mapped image after launch', async () => {
    const source = await readFile(new URL('../scripts/package-macos.mjs', import.meta.url), 'utf8')
    const parsed = ts.createSourceFile('package-macos.mjs', source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.JS)
    const install = parsed.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'installApplication')!
    expect(install).toBeDefined()
    const calls: ts.CallExpression[] = []
    const visit = (node: ts.Node): void => { if (ts.isCallExpression(node)) calls.push(node); ts.forEachChild(node, visit) }
    visit(install)
    const named = (name: string) => calls.filter(node => ts.isIdentifier(node.expression) && node.expression.text === name)
    const prepares = named('prepareSemanticHostReload'), stops = named('stopSemanticHostForInstall'), confirmations = named('confirmSemanticHostReload')
    expect(prepares).toHaveLength(2); expect(stops).toHaveLength(1); expect(confirmations).toHaveLength(1)
    const quit = named('quit')[0]!, cutover = named('rename').find(node => node.arguments[0]?.getText(parsed) === 'next')!
    expect(quit.pos).toBeGreaterThan(prepares[0]!.pos)
    expect(prepares[1]!.pos).toBeGreaterThan(quit.pos)
    expect(stops[0]!.pos).toBeGreaterThan(prepares[1]!.pos)
    expect(cutover.pos).toBeGreaterThan(stops[0]!.pos)
    const activation = named('awaitUiActivation').find(node => node.arguments[2]?.getText(parsed) === 'uiRuntime ?? runtimeUpgrade')!
    expect(confirmations[0]!.pos).toBeGreaterThan(activation.pos)
    let ancestor: ts.Node = prepares[1]!
    while (ancestor.parent && !ts.isIfStatement(ancestor)) ancestor = ancestor.parent
    expect(ts.isIfStatement(ancestor)).toBe(true)
    expect((ancestor as ts.IfStatement).expression.getText(parsed)).toBe('!semanticHost && previouslyInstalled')
  })
})
