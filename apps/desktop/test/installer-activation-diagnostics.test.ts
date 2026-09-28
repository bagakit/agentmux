import { AssertionError } from 'node:assert'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { observeApplicationProcesses } from '../scripts/package-process-scope.mjs'
import { confirmApplicationActivation } from '../scripts/package-macos.mjs'

const uid = process.getuid!(), birth = 'Sun Oct 4 12:00:01 2026'
const executable = '/private/fixture/AgentMux.app/Contents/MacOS/AgentMux'
const bundle = { executable, helperRoot: '/private/fixture/AgentMux.app/Contents/Frameworks/' }
const row = (pid: number, ppid: number, command = executable) => `${uid} ${pid} ${ppid} ${birth} ${command}`
const identity = (pid: number, ppid: number) => ({ uid, pid, ppid, birth })
const mode = (pid: number, ppid: number, kind = 'node') => ({ ...identity(pid, ppid), mode: kind, executable })
const main = { pid: 700, package: { sourceCommit: 'fixture' }, renderer: { kind: 'bundled', id: 'fixture' } }
const native = { status: 'unchanged', confirmedOwner: 'fixture-owner' }
const ps = (...rows: string[]) => [row(1, 0, '/sbin/launchd'), row(90, 1, '/private/parent --secret=PRIVATE_COMMAND'), ...rows].join('\n')
const gui = row(700, 1)
async function observe(snapshots: string[], rounds: object[][], previous: object[] = []) {
  let reads = 0
  const requests: number[][] = []
  const scope = await observeApplicationProcesses(bundle, previous, {
    processSnapshot: async () => {
      expect(snapshots[reads], 'every OS read has a bounded fixture').toBeTypeOf('string')
      return snapshots[reads++]!
    },
    modes: async pids => {
      requests.push(pids)
      expect(rounds[requests.length - 1], 'every mode read has a bounded fixture').toBeDefined()
      return rounds[requests.length - 1]!
    }
  })
  return { scope, reads, requests }
}
function activate(scope: Awaited<ReturnType<typeof observe>>['scope'], previous: object[] = [], beforeLaunch: object[] = []) {
  return confirmApplicationActivation({ previous, beforeLaunch, scope, main, native, intent: 'full', path: '/private/fixture/AgentMux.app' })
}
function failure(scope: Awaited<ReturnType<typeof observe>>['scope'], previous: object[] = [], beforeLaunch: object[] = []) {
  let caught: any
  try { activate(scope, previous, beforeLaunch) } catch (error) { caught = error }
  expect(caught).toBeInstanceOf(AssertionError)
  expect(caught.code).toBe('ERR_ASSERTION')
  expect(caught.transaction.ui.status).toBe('unknown')
  expect(caught.transaction.ui.main).toEqual(main)
  expect(caught.transaction.ui.completedStages).toEqual(['candidate-launch', 'ui-activation'])
  expect(caught.transaction.ui.failedStage).toBe('application-process-ownership')
  expect(caught.transaction.native).toBe(native)
  expect(caught.transaction.ui.ownership).toBe(caught.ownershipDiagnostic)
  return caught
}

describe('installer failure preserves point-time ownership and qualified stages', () => {
  it('records a last-snapshot candidate as not requested, preserving exact bounded reads and privacy', async () => {
    const intermediate = ps(gui, row(800, 90)), final = ps(gui, row(800, 90), row(801, 90))
    const { scope, reads, requests } = await observe([ps(gui), intermediate, final],
      [[{ ...mode(700, 1, 'gui'), argv: 'PRIVATE_ARGV', env: 'PRIVATE_ENV' }], [mode(800, 90)]])
    expect(reads).toBe(3); expect(requests).toEqual([[700], [800]])
    expect(scope.serving).toEqual([700, 801]); expect(scope.externalNode).toEqual([800])
    const error = failure(scope), diagnostic = error.ownershipDiagnostic
    expect(error.message).toContain('Application process 801 is not a confirmed descendant')
    expect(diagnostic.stage).toBe('owner-ancestry')
    expect(diagnostic.loadedMain).toEqual(identity(700, 1))
    expect(diagnostic.affected.identity).toEqual(identity(801, 90))
    expect(diagnostic.affected.mode).toEqual({ status: 'not-requested', observation: null, mismatch: [], unknown: [] })
    expect(diagnostic.ancestry).toEqual({ path: [identity(801, 90), identity(90, 1), identity(1, 0)], termination: 'system-root', missingPid: null })
    const receipt = JSON.stringify(error.transaction)
    expect(receipt).not.toContain('PRIVATE_'); expect(receipt).not.toContain('argv'); expect(receipt).not.toContain('"env"')
    expect(receipt).not.toContain('"processes"'); expect(receipt).not.toContain('"pid":800')
  })

  it('distinguishes a requested mode without a returned observation from a read that remains unknown', async () => {
    for (const returned of [[], [{ ...identity(800, 90), mode: 'unknown' }]]) {
      const final = ps(gui, row(800, 90))
      const { scope, reads, requests } = await observe([ps(gui), final, final], [[mode(700, 1, 'gui')], returned])
      expect(reads).toBe(3); expect(requests).toEqual([[700], [800]])
      expect(scope.serving).toEqual([700, 800])
      const diagnostic = failure(scope).ownershipDiagnostic
      expect(diagnostic.affected.identity).toEqual(identity(800, 90))
      expect(diagnostic.affected.mode.status).toBe(returned.length ? 'unknown' : 'not-returned')
      expect(diagnostic.affected.mode.unknown).toEqual(returned.length ? ['executable'] : [])
    }
  })

  it('retains known binding mismatches instead of dropping the stale mode from the failure receipt', async () => {
    const final = ps(gui, row(800, 90))
    const variants = [{ ...mode(800, 90), birth: 'Sun Oct 4 12:00:00 2026' },
      { ...mode(800, 90), uid: uid + 1 }, { ...mode(800, 90), ppid: 91 },
      { ...mode(800, 90), executable: '/private/argv0-lookalike' }]
    const keys = ['birth', 'uid', 'ppid', 'executable']
    for (const [index, stale] of variants.entries()) {
      const { scope, reads, requests } = await observe([final, final],
        [[mode(700, 1, 'gui'), { ...stale, argv: 'PRIVATE_ARGV', env: 'PRIVATE_ENV' }]])
      expect(reads).toBe(2); expect(requests).toEqual([[700, 800]])
      expect(scope.serving).toEqual([700, 800]); expect(scope.externalNode).toEqual([])
      const error = failure(scope), diagnostic = error.ownershipDiagnostic
      expect(diagnostic.affected.mode.status).toBe('binding-mismatch')
      expect(diagnostic.affected.mode.mismatch).toEqual([keys[index]])
      expect(diagnostic.affected.mode.observation).toEqual(stale)
      expect(JSON.stringify(error.transaction)).not.toContain('PRIVATE_')
    }
  })

  it('identifies the missing parent and terminates cyclic ancestry without dumping unrelated processes', async () => {
    for (const [parents, termination, missingPid] of [
      [[row(800, 91)], 'missing-parent', 91],
      [[row(800, 801), row(801, 800, '/private/foreign --secret=PRIVATE_COMMAND')], 'cyclic', null]
    ] as const) {
      const final = ps(gui, ...parents)
      const { scope } = await observe([final, final], [[mode(700, 1, 'gui'), mode(800, termination === 'cyclic' ? 801 : 91)]])
      expect(scope.serving).toEqual([700, 800])
      const diagnostic = failure(scope).ownershipDiagnostic
      expect(diagnostic.ancestry.termination).toBe(termination)
      expect(diagnostic.ancestry.missingPid).toBe(missingPid)
      expect(diagnostic.ancestry.path.map((entry: any) => entry.pid)).toEqual(termination === 'cyclic' ? [800, 801] : [800])
      expect(JSON.stringify(diagnostic)).not.toContain('PRIVATE_COMMAND')
    }
  })

  it('preserves external Node exclusion, direct and indirect Main workers, and final exit facts', async () => {
    const initial = ps(gui, row(701, 700), row(702, 701), row(800, 90), row(801, 90))
    const final = ps(gui, row(701, 700), row(702, 701), row(800, 90))
    const { scope, requests, reads } = await observe([initial, final], [[mode(700, 1, 'gui'), mode(701, 700), mode(702, 701), mode(800, 90), mode(801, 90)]])
    expect(reads).toBe(2); expect(requests).toEqual([[700, 701, 702, 800, 801]])
    expect(scope.serving).toEqual([700, 701, 702]); expect(scope.externalNode).toEqual([800])
    expect(activate(scope)).toEqual([{ pid: 700, ppid: 1, birth }, { pid: 701, ppid: 700, birth }, { pid: 702, ppid: 701, birth }])
  })

  it('keeps a previous same-birth worker protected and records that exact guard', async () => {
    const previous = [{ pid: 701, ppid: 700, birth }], final = ps(gui, row(701, 1), row(800, 90))
    const { scope } = await observe([final, final], [[mode(700, 1, 'gui'), mode(701, 1), mode(800, 90)]], previous)
    expect(scope.serving).toEqual([700, 701]); expect(scope.externalNode).toEqual([800])
    const diagnostic = failure(scope, previous).ownershipDiagnostic
    expect(diagnostic.stage).toBe('previous-owner'); expect(diagnostic.affected.identity).toEqual(identity(701, 1))
    expect(diagnostic.affected.previousSameBirth).toBe(true)
    expect(diagnostic.affected.mode.status).toBe('bound')
  })

  it('separates the Main and candidate-birth guards and preserves PID reuse as a success', async () => {
    const final = ps(gui, row(701, 700))
    const { scope } = await observe([final, final], [[mode(700, 1, 'gui')]])
    const absent = failure({ ...scope, serving: [] }).ownershipDiagnostic
    expect(absent.stage).toBe('loaded-main'); expect(absent.affected.identity).toEqual(identity(700, 1))
    const existingMain = failure(scope, [], [{ pid: 700, ppid: 1, birth }]).ownershipDiagnostic
    expect(existingMain.stage).toBe('main-birth'); expect(existingMain.affected.beforeLaunchSameBirth).toBe(true)
    const existingHelper = failure(scope, [], [{ pid: 701, ppid: 700, birth }]).ownershipDiagnostic
    expect(existingHelper.stage).toBe('owner-launch'); expect(existingHelper.affected.identity).toEqual(identity(701, 700))
    expect(activate(scope, [{ pid: 701, ppid: 1, birth: 'Sun Oct 4 12:00:00 2026' }])).toEqual([{ pid: 700, ppid: 1, birth }, { pid: 701, ppid: 700, birth }])
  })

  it('has a real install caller after UI qualification and before owner receipt', () => {
    const source = readFileSync(new URL('../scripts/package-macos.mjs', import.meta.url), 'utf8')
    const start = source.indexOf('    const activatedScope = await scopedProcesses(destination)'), end = source.indexOf('    process.stdout.write(`activated_serving_owners=', start)
    expect(start).toBeGreaterThan(-1); expect(end).toBeGreaterThan(start)
    const consumer = source.slice(start, end)
    expect(consumer).toContain('confirmApplicationActivation({')
    expect(consumer).toContain('main: observed.main, intent, native, path: destination')
    expect(consumer).toContain('scope: activatedScope')
  })
})
