import { fixtureCivil as _hygiene_fixtureCivil, fixturePath as _hygiene_fixturePath, fixturePsBirth as _hygiene_fixturePsBirth } from "../scripts/lib/fixture-values.mjs"
import { describe, expect, it } from 'vitest'
import { classifyApplicationProcesses, snapshotApplicationProcesses, observeApplicationProcesses, assertApplicationActivationOwnership, applicationQuitOwnershipDiagnostic } from '../scripts/package-process-scope.mjs'

/**
 * 打包安装脚本用 `processIdsForApplication` 回答三个问题：退出旧实例前「还有没有在服务这份包的进程」、
 * 拉起后「新包起来了没有」、以及安装收尾的幸存者断言「上一份安装的进程还活着没有」。三处都把「服务这份
 * 包」当判据。
 *
 * 事故（prior observation 实测 pid 1033）：匹配器的 `startsWith(Frameworks/)` 那条把脱钩的 crash-reporter
 * helper（`chrome_crashpad_handler`，app 退出后被 launchd 收养、PPID 1）也算进来。它不服务任何 UI、不
 * flush 状态，却让每一次后续安装都在退出旧实例这步卡死。
 *
 * 但不能因此「忽略所有 helper」——那会复活 prior observation 那次事故：renderer/GPU/utility helper 全都在
 * **服务这份包**，放过它们等于交付一个跑着旧代码的窗口。所以判据必须成对：crash reporter 被排除，其余
 * helper 仍然阻断。
 */

const APP = 'home//Applications/AgentMux.app'
const EXECUTABLE = `${APP}/Contents/MacOS/AgentMux`
const HELPER_ROOT = `${APP}/Contents/Frameworks/`
const FRAMEWORK = `${HELPER_ROOT}Electron Framework.framework/Helpers`

const bundle = { executable: EXECUTABLE, helperRoot: HELPER_ROOT }

const line = (pid: number, command: string) => `${String(pid).padStart(5)} ${command}`
const guiAdmission = (row: { pid: number; ppid: number; birth: string }) => ({ ...row, uid: process.getuid!(),
  classification: 'gui', source: 'bound-gui', initial: { classification: 'gui', source: 'bound-gui', ppid: row.ppid },
  confirmedGui: { source: 'bound-gui', ppid: row.ppid } })

describe('classifyApplicationProcesses separates serving from crash-reporter', () => {
  it('excludes a detached crashpad handler from serving so a stale one cannot block install', () => {
    const ps = line(
      1033,
      ((FRAMEWORK) + "/chrome_crashpad_handler --no-rate-limit --monitor-self-annotation=ptype=crashpad-handler --database=" + _hygiene_fixturePath("x") + " --handshake-fd=17")
    )
    const { serving, crashReporter } = classifyApplicationProcesses(ps, bundle)
    expect(serving).toEqual([])
    expect(crashReporter).toEqual([1033])
  })

  it(("keeps the main process serving — the " + _hygiene_fixtureCivil(9, 1) + " protection"), () => {
    const { serving } = classifyApplicationProcesses(line(500, EXECUTABLE), bundle)
    expect(serving).toEqual([500])
  })

  it(("keeps a renderer/GPU/utility helper serving — \"ignore all helpers\" would resurrect " + _hygiene_fixtureCivil(9, 1)), () => {
    const renderer = line(
      601,
      `${FRAMEWORK}/AgentMux Helper (Renderer).app/Contents/MacOS/AgentMux Helper (Renderer) --type=renderer`
    )
    const gpu = line(
      602,
      `${FRAMEWORK}/AgentMux Helper (GPU).app/Contents/MacOS/AgentMux Helper (GPU) --type=gpu-process`
    )
    const utility = line(
      603,
      `${FRAMEWORK}/AgentMux Helper.app/Contents/MacOS/AgentMux Helper --type=utility`
    )
    const { serving, crashReporter } = classifyApplicationProcesses([renderer, gpu, utility].join('\n'), bundle)
    expect(serving).toEqual([601, 602, 603])
    expect(crashReporter).toEqual([])
  })

  it('classifies a realistic mixed bundle: main + helpers block, only crashpad is carved out', () => {
    const ps = [
      line(500, EXECUTABLE),
      line(601, `${FRAMEWORK}/AgentMux Helper (Renderer).app/Contents/MacOS/AgentMux Helper (Renderer) --type=renderer`),
      line(602, `${FRAMEWORK}/AgentMux Helper (GPU).app/Contents/MacOS/AgentMux Helper (GPU) --type=gpu-process`),
      line(1033, ((FRAMEWORK) + "/chrome_crashpad_handler --database=" + _hygiene_fixturePath("x"))),
      line(99, '/sbin/launchd'),
      line(100, '/Applications/OtherApp.app/Contents/MacOS/OtherApp')
    ].join('\n')
    const { serving, crashReporter } = classifyApplicationProcesses(ps, bundle)
    expect(serving).toEqual([500, 601, 602])
    expect(crashReporter).toEqual([1033])
  })

  it('does not let a crashpad-looking argument on a real helper get it excluded', () => {
    // A serving helper whose *arguments* mention the crashpad handler must still block:
    // only the executable position is allowed to make the crash-reporter call.
    const ps = line(
      601,
      ((FRAMEWORK) + "/AgentMux Helper (Renderer).app/Contents/MacOS/AgentMux Helper (Renderer) --type=renderer --crashpad-handler=" + _hygiene_fixturePath("chrome_crashpad_handler"))
    )
    const { serving, crashReporter } = classifyApplicationProcesses(ps, bundle)
    expect(serving).toEqual([601])
    expect(crashReporter).toEqual([])
  })
})

describe('candidate activation uses OS ownership rather than the first launch PID list', () => {
  const oldBirth = _hygiene_fixturePsBirth(23716800000), newBirth = _hygiene_fixturePsBirth(23716801000)
  const oldMain = { pid: 500, ppid: 1, birth: oldBirth }
  const oldHelper = { pid: 601, ppid: 500, birth: oldBirth }
  const main = { pid: 700, ppid: 1, birth: newBirth }
  const renderer = { pid: 701, ppid: 700, birth: newBirth }
  const gpu = { pid: 702, ppid: 700, birth: newBirth }
  const utility = { pid: 703, ppid: 701, birth: newBirth }
  const system = { pid: 1, ppid: 0, birth: oldBirth }
  const ownership = (current: typeof main[], serving: number[] = [700, 701, 702, 703]) => ({
    previous: [guiAdmission(oldMain), guiAdmission(oldHelper)], beforeLaunch: [system, oldMain, oldHelper], current, serving, mainPid: 700
  })

  it('keeps exact nonempty process metadata while preserving the crash-reporter classification', () => {
    const ps = [
      (" " + (process.getuid!()) + (" 700 1 " + _hygiene_fixturePsBirth(23716801000) + " ") + (EXECUTABLE) + ""),
      (" " + (process.getuid!()) + (" 701 700 " + _hygiene_fixturePsBirth(23716801000) + " ") + (FRAMEWORK) + "/AgentMux Helper (Renderer).app/Contents/MacOS/AgentMux Helper (Renderer) --type=renderer"),
      (" " + (process.getuid!()) + (" 710 1 " + _hygiene_fixturePsBirth(23716801000) + " ") + (FRAMEWORK) + ("/chrome_crashpad_handler --database=" + _hygiene_fixturePath("x")))
    ].join('\n')
    const observed = snapshotApplicationProcesses(ps, bundle)
    expect(observed).toMatchObject({ serving: [700, 701], crashReporter: [710], externalNode: [],
      processes: [main, renderer, { pid: 710, ppid: 1, birth: newBirth }] })
    expect(observed.admissions).toMatchObject([{ pid: 700, classification: 'unknown', source: 'mode-unconfirmed' },
      { pid: 701, classification: 'gui', source: 'bundle-helper' }])
    expect(() => snapshotApplicationProcesses('', bundle)).toThrow('empty')
    expect(() => snapshotApplicationProcesses(`700 1 unavailable ${EXECUTABLE}`, bundle)).toThrow('birth observation')
  })

  it('accepts later Renderer/GPU/utility owners although the platform first returned only Main', () => {
    const current = [system, main, renderer, gpu, utility]
    expect(assertApplicationActivationOwnership(ownership(current))).toEqual([main, renderer, gpu, utility])
  })

  it('rejects an original owner still alive even when absent from the current canonical-path scope', () => {
    expect(() => assertApplicationActivationOwnership(ownership([system, oldMain, main, renderer, gpu, utility])))
      .toThrow('previous application owner')
    expect(() => assertApplicationActivationOwnership(ownership([system, { ...oldHelper, ppid: 700 }, main, renderer, gpu, utility])))
      .toThrow('previous application owner')
  })

  it('distinguishes PID reuse by birth and still requires the real new Main ancestry', () => {
    const reused = { pid: 601, ppid: 700, birth: newBirth }
    expect(assertApplicationActivationOwnership(ownership([system, main, reused], [700, 601]))).toEqual([main, reused])
    expect(() => assertApplicationActivationOwnership(ownership([system, main, { ...reused, ppid: 1 }], [700, 601])))
      .toThrow('not a confirmed descendant')
  })

  it('refuses an already-existing Main and a helper that existed before launch', () => {
    const current = [system, main, renderer, gpu, utility]
    expect(() => assertApplicationActivationOwnership({ ...ownership(current), beforeLaunch: [system, main] }))
      .toThrow('Main existed before')
    expect(() => assertApplicationActivationOwnership({ ...ownership(current), beforeLaunch: [system, renderer] }))
      .toThrow('existed before candidate launch')
  })

  it('does not qualify missing birth facts or an empty actual application scope', () => {
    expect(() => assertApplicationActivationOwnership(ownership([system, main, { ...renderer, birth: '' }], [700, 701])))
      .toThrow('birth is unavailable')
    expect(() => assertApplicationActivationOwnership(ownership([system, main], []))).toThrow('loaded Main')
  })

  it('terminates on a cyclic ancestry observation rather than ignoring the helper', () => {
    const a = { pid: 701, ppid: 702, birth: newBirth }, b = { pid: 702, ppid: 701, birth: newBirth }
    expect(() => assertApplicationActivationOwnership(ownership([system, main, a, b], [700, 701, 702])))
      .toThrow('ancestry is cyclic')
  })
})

describe('external Node clients and Main-owned Node workers have different authority', () => {
  const birth = _hygiene_fixturePsBirth(23716801000)
  const row = (pid: number, ppid: number, command = EXECUTABLE) => `${process.getuid!()} ${pid} ${ppid} ${birth} ${command}`
  const system = row(1, 0, '/sbin/launchd'), externalParent = row(90, 1, _hygiene_fixturePath("usr/bin/private-client"))
  const main = row(700, 1), node = (pid: number, ppid: number) => ({ pid, ppid, birth, uid: process.getuid!(), mode: 'node', executable: EXECUTABLE })
  const ps = (...rows: string[]) => [system, externalParent, ...rows].join('\n')
  const prior = [guiAdmission({ pid: 701, ppid: 700, birth })]

  it('excludes only a bound external client, preserving Main child and indirect file workers', () => {
    const scope = snapshotApplicationProcesses(ps(main, row(701, 700), row(702, 701), row(800, 90)), bundle,
      { nodeModes: [node(701, 700), node(702, 701), node(800, 90)] })
    expect(scope.serving).toEqual([700, 701, 702])
    expect(scope.externalNode).toEqual([800])
    expect(assertApplicationActivationOwnership({ previous: [], beforeLaunch: [], current: scope.processes,
      serving: scope.serving, mainPid: 700 })).toEqual(scope.processes.filter(row => [700, 701, 702].includes(row.pid)))
  })

  it('protects an original worker after Main quits and the OS reparents it, until that birth really exits', () => {
    const alive = snapshotApplicationProcesses(ps(row(701, 1), row(800, 90)), bundle,
      { nodeModes: [node(701, 1), node(800, 90)], previousOwners: prior })
    expect(alive.serving).toEqual([701]); expect(alive.externalNode).toEqual([800])
    const gone = snapshotApplicationProcesses(ps(row(800, 90)), bundle,
      { nodeModes: [node(800, 90)], previousOwners: prior })
    expect(gone.serving).toEqual([]); expect(gone.externalNode).toEqual([800])
    const fresh = snapshotApplicationProcesses(ps(row(701, 90)), bundle,
      { nodeModes: [{ ...node(701, 90) }], previousOwners: [{ ...prior[0], birth: _hygiene_fixturePsBirth(23716800000) }] })
    expect(fresh.serving).toEqual([]); expect(fresh.externalNode).toEqual([701])
  })

  it('never treats an unknown mode, argv environment word, foreign GUI or identity drift as external Node', () => {
    for (const mode of [undefined, { ...node(800, 90), mode: 'unknown' }, { ...node(800, 90), mode: 'gui' },
      { ...node(800, 90), birth: _hygiene_fixturePsBirth(23716800000) }, { ...node(800, 90), uid: process.getuid!() + 1 },
      { ...node(800, 90), executable: _hygiene_fixturePath("usr/bin/argv0-lookalike") },
      { ...node(800, 90), ppid: 91 }]) {
      const scope = snapshotApplicationProcesses(ps(main, row(800, 90, `${EXECUTABLE} --fake=ELECTRON_RUN_AS_NODE=1`)), bundle,
        { nodeModes: mode ? [mode] : [] })
      expect(scope.serving).toEqual([700, 800]); expect(scope.externalNode).toEqual([])
      expect(() => assertApplicationActivationOwnership({ previous: [], beforeLaunch: [], current: scope.processes,
        serving: scope.serving, mainPid: 700 })).toThrow('not a confirmed descendant')
    }
    const changedUid = snapshotApplicationProcesses(ps(main,
      row(800, 90).replace(`${process.getuid!()} 800`, `${process.getuid!() + 1} 800`)), bundle, { nodeModes: [node(800, 90)] })
    expect(changedUid.serving).toEqual([700, 800]); expect(changedUid.externalNode).toEqual([])
  })

  it('keeps mode-confirmed Node protected when ancestry is missing or cyclic', () => {
    for (const graph of [ps(main, row(800, 91)), ps(main, row(800, 801), row(801, 800, _hygiene_fixturePath("private/foreign")))]) {
      const scope = snapshotApplicationProcesses(graph, bundle,
        { nodeModes: [node(800, graph.includes('800 91 ') ? 91 : 801)] })
      expect(scope.serving).toEqual([700, 800]); expect(scope.externalNode).toEqual([])
    }
  })

  it('a bound Node mode never exempts a previous same-birth owner from activation', () => {
    const scope = snapshotApplicationProcesses(ps(main, row(701, 1)), bundle,
      { nodeModes: [node(701, 1)], previousOwners: prior })
    expect(scope.serving).toEqual([700, 701])
    expect(() => assertApplicationActivationOwnership({ previous: prior, beforeLaunch: [], current: scope.processes,
      serving: scope.serving, mainPid: 700 })).toThrow('previous application owner')
  })

  it('rechecks authoritative OS existence: gone is removed, a still-existing unreadable mode remains protected', async () => {
    const initial = ps(main, row(800, 90)), final = ps(main)
    const snapshots = [initial, final], requested: number[][] = []
    const gone = await observeApplicationProcesses(bundle, [], { processSnapshot: async () => snapshots.shift()!,
      modes: async pids => { requested.push(pids); return [] } })
    expect(requested).toEqual([[700, 800]])
    expect(gone.serving).toEqual([700]); expect(gone.externalNode).toEqual([])
    expect(gone.processes.map(row => row.pid)).toEqual([1, 90, 700])
    const present = await observeApplicationProcesses(bundle, [], { processSnapshot: async () => initial, modes: async () => [] })
    expect(present.serving).toEqual([700, 800]); expect(present.externalNode).toEqual([])
  })

})


describe('a bounded observation reads candidates introduced after its first OS snapshot', () => {
  const birth = _hygiene_fixturePsBirth(23716801000), laterBirth = _hygiene_fixturePsBirth(23716802000)
  const uid = process.getuid!()
  const row = (pid: number, ppid: number, born = birth, ownerUid = uid) =>
    `${ownerUid} ${pid} ${ppid} ${born} ${EXECUTABLE}`
  const system = `${uid} 1 0 ${birth} /sbin/launchd`
  const parents = [("" + (uid) + " 90 1 " + (birth) + (" " + _hygiene_fixturePath("private/external"))), ("" + (uid) + " 91 1 " + (birth) + (" " + _hygiene_fixturePath("private/other-external")))]
  const main = row(700, 1)
  const ps = (...rows: string[]) => [system, ...parents, ...rows].join('\n')
  const mode = (pid: number, ppid: number, born = birth, ownerUid = uid, kind = 'node') =>
    ({ pid, ppid, birth: born, uid: ownerUid, mode: kind, executable: EXECUTABLE })
  async function observe(snapshots: string[], rounds: ReturnType<typeof mode>[][], previousOwners: object[] = []) {
    const requested: number[][] = [], reads: string[] = []
    const scope = await observeApplicationProcesses(bundle, previousOwners, {
      processSnapshot: async () => {
        const next = snapshots[reads.length]
        expect(next, 'bounded OS snapshot must be present').toBeTypeOf('string')
        reads.push(next)
        return next
      },
      modes: async pids => {
        requested.push(pids)
        const result = rounds[requested.length - 1]
        expect(result, 'bounded selected-PID mode round must be present').toBeDefined()
        return result
      }
    })
    return { scope, requested, reads }
  }
  function activate(scope: Awaited<ReturnType<typeof observe>>['scope'], previous: object[] = []) {
    return assertApplicationActivationOwnership({ previous, beforeLaunch: [], current: scope.processes,
      serving: scope.serving, mainPid: 700 })
  }

  it('reads a newly observed external Node before requiring Main ancestry', async () => {
    const initial = ps(main), final = ps(main, row(800, 90))
    const { scope, requested, reads } = await observe([initial, final, final],
      [[mode(700, 1, birth, uid, 'gui')], [mode(800, 90)]])
    expect(requested).toEqual([[700], [800]]); expect(reads).toEqual([initial, final, final])
    expect(scope.serving).toEqual([700]); expect(scope.externalNode).toEqual([800])
    expect(scope.nodeModes).toEqual([mode(700, 1, birth, uid, 'gui'), mode(800, 90)])
    expect(activate(scope)).toEqual([{ pid: 700, ppid: 1, birth }])
  })

  it('retains newly observed direct and indirect Main-owned Node workers', async () => {
    const final = ps(main, row(701, 700), row(702, 701))
    const { scope, requested } = await observe([ps(main), final, final],
      [[mode(700, 1, birth, uid, 'gui')], [mode(701, 700), mode(702, 701)]])
    expect(requested).toEqual([[700], [701, 702]])
    expect(scope.serving).toEqual([700, 701, 702]); expect(scope.externalNode).toEqual([])
    expect(activate(scope)).toEqual([{ pid: 700, ppid: 1, birth }, { pid: 701, ppid: 700, birth }, { pid: 702, ppid: 701, birth }])
  })

  it('does not reuse an earlier mode for a new birth or changed UID at the same PID', async () => {
    for (const original of [{ born: birth, uid }, { born: laterBirth, uid: uid + 1 }]) {
      const initial = ps(main, row(800, 90, original.born, original.uid))
      const final = ps(main, row(800, 90, laterBirth))
      const { scope, requested } = await observe([initial, final, final],
        [[mode(700, 1, birth, uid, 'gui'), mode(800, 90, original.born, original.uid)], [mode(800, 90, laterBirth)]])
      expect(requested).toEqual([[700, 800], [800]])
      expect(scope.externalNode).toEqual([800]); expect(scope.serving).toEqual([700])
      expect(scope.nodeModes.find(row => row.pid === 800)).toEqual(mode(800, 90, laterBirth))
      expect(activate(scope)).toEqual([{ pid: 700, ppid: 1, birth }])
    }
  })

  it('rebinds a changed PPID instead of retaining a stale ancestry mode', async () => {
    const final = ps(main, row(800, 91))
    const { scope, requested } = await observe([ps(main, row(800, 90)), final, final],
      [[mode(700, 1, birth, uid, 'gui'), mode(800, 90)], [mode(800, 91)]])
    expect(requested).toEqual([[700, 800], [800]])
    expect(scope.externalNode).toEqual([800]); expect(scope.serving).toEqual([700])
    expect(scope.nodeModes.find(row => row.pid === 800)).toEqual(mode(800, 91))
    expect(activate(scope)).toEqual([{ pid: 700, ppid: 1, birth }])
  })

  it('uses the final authoritative snapshot when the newly read candidate has exited', async () => {
    const initial = ps(main), intermediate = ps(main, row(800, 90))
    const { scope, requested, reads } = await observe([initial, intermediate, initial],
      [[mode(700, 1, birth, uid, 'gui')], [mode(800, 90)]])
    expect(requested).toEqual([[700], [800]]); expect(reads).toEqual([initial, intermediate, initial])
    expect(scope.serving).toEqual([700]); expect(scope.externalNode).toEqual([])
    expect(scope.nodeModes).toEqual([mode(700, 1, birth, uid, 'gui')])
    expect(activate(scope)).toEqual([{ pid: 700, ppid: 1, birth }])
  })

  it('keeps an unreadable newly observed process unconfirmed and makes no further mode attempt', async () => {
    const final = ps(main, row(800, 90))
    const { scope, requested, reads } = await observe([ps(main), final, final], [[mode(700, 1, birth, uid, 'gui')], []])
    expect(requested).toEqual([[700], [800]]); expect(reads.length).toBe(3)
    expect(scope.serving).toEqual([700, 800]); expect(scope.externalNode).toEqual([])
    expect(() => activate(scope)).toThrow('not a confirmed descendant')
  })

  it('does not loop or silently exempt another process introduced in the last snapshot', async () => {
    const intermediate = ps(main, row(800, 90)), final = ps(main, row(800, 90), row(801, 90))
    const { scope, requested, reads } = await observe([ps(main), intermediate, final],
      [[mode(700, 1, birth, uid, 'gui')], [mode(800, 90)]])
    expect(requested).toEqual([[700], [800]]); expect(reads.length).toBe(3)
    expect(scope.serving).toEqual([700, 801]); expect(scope.externalNode).toEqual([800])
    expect(() => activate(scope)).toThrow('Application process 801 is not a confirmed descendant')
  })

  it('keeps the original same-birth worker protected while classifying a new external Node', async () => {
    const prior = [guiAdmission({ pid: 701, ppid: 700, birth })], initial = ps(main, row(701, 1)), final = ps(main, row(701, 1), row(800, 90))
    const { scope, requested } = await observe([initial, final, final],
      [[mode(700, 1, birth, uid, 'gui'), mode(701, 1)], [mode(800, 90)]], prior)
    expect(requested).toEqual([[700, 701], [800]])
    expect(scope.serving).toEqual([700, 701]); expect(scope.externalNode).toEqual([800])
    expect(() => activate(scope, prior)).toThrow('previous application owner')
  })
})

describe('typed admissions retain original evidence without promoting unknown to GUI ownership', () => {
  const uid = process.getuid!(), birth = _hygiene_fixturePsBirth(23716801000), anotherBirth = _hygiene_fixturePsBirth(23716802000)
  const row = (pid: number, ppid: number, command = EXECUTABLE, ownerUid = uid, born = birth) =>
    `${ownerUid} ${pid} ${ppid} ${born} ${command}`
  const mode = (pid: number, ppid: number, kind = 'node', ownerUid = uid, born = birth) =>
    ({ uid: ownerUid, pid, ppid, birth: born, mode: kind, executable: EXECUTABLE })
  const ps = (...rows: string[]) => [row(1, 0, '/sbin/launchd'), row(90, 1, _hygiene_fixturePath('private/independent')), ...rows].join('\n')
  const main = row(700, 1), mainMode = mode(700, 1, 'gui')
  async function observe(snapshot: string, nodeModes: object[], previousOwners: object[] = [], independentOwners: object[] = []) {
    return observeApplicationProcesses(bundle, previousOwners, {
      processSnapshot: async () => snapshot, modes: async () => nodeModes, independentOwners
    })
  }

  it('releases an original unknown only after fresh bound mode and complete external ancestry, including activation', async () => {
    const snapshot = ps(main, row(800, 90, `${EXECUTABLE} --private-argument`))
    const first = await observe(snapshot, [mainMode])
    const initial = first.admissions.find(row => row.pid === 800)!
    expect(initial).toMatchObject({ uid, birth, classification: 'unknown', source: 'mode-unconfirmed',
      initial: { classification: 'unknown', source: 'mode-unconfirmed', ppid: 90,
        mode: { status: 'not-observed', observation: null },
        ancestry: { path: [{ uid, pid: 800, ppid: 90, birth }, { uid, pid: 90, ppid: 1, birth }, { uid, pid: 1, ppid: 0, birth }],
          termination: 'system-root', missingPid: null } } })
    expect(initial.confirmedGui).toBeUndefined()
    const external = await observe(snapshot, [mainMode, mode(800, 90)], first.admissions)
    expect(external.serving).toEqual([700]); expect(external.externalNode).toEqual([800])
    expect(external.admissions.find(row => row.pid === 800)).toMatchObject({ classification: 'external', source: 'system-root', initial: initial.initial })
    expect(assertApplicationActivationOwnership({ previous: [initial], beforeLaunch: first.processes.filter(row => row.pid === 800),
      current: external.processes, serving: external.serving, mainPid: 700, observation: external.ownershipObservation }))
      .toEqual(external.processes.filter(row => row.pid === 700))
  })

  it('preserves the original bounded mode mismatch after a later accurate read resolves it', async () => {
    const snapshot = ps(main, row(800, 90))
    const first = await observe(snapshot, [mainMode, { ...mode(800, 90), birth: anotherBirth, executable: _hygiene_fixturePath('private/another-executable') }])
    const admission = first.admissions.find(row => row.pid === 800)!
    expect(admission.initial.mode).toMatchObject({ status: 'binding-mismatch', mismatch: ['birth', 'executable'],
      observation: { uid, pid: 800, ppid: 90, birth: anotherBirth, mode: 'node', executableMatches: false } })
    const current = await observe(snapshot, [mainMode, mode(800, 90)], first.admissions)
    expect(current.admissions.find(row => row.pid === 800)).toMatchObject({ classification: 'external', initial: admission.initial })
    expect(JSON.stringify(admission.initial)).not.toContain('another-executable')
  })

  it('keeps a later GUI confirmation through reparenting without replacing the initial unknown fact', () => {
    const first = snapshotApplicationProcesses(ps(main, row(701, 700)), bundle, { nodeModes: [mainMode] })
    const admitted = snapshotApplicationProcesses(ps(main, row(701, 700)), bundle,
      { nodeModes: [mainMode, mode(701, 700)], previousOwners: first.admissions })
    const owner = admitted.admissions.find(row => row.pid === 701)!
    expect(owner).toMatchObject({ classification: 'gui', source: 'gui-ancestry', initial: { classification: 'unknown' },
      confirmedGui: { source: 'gui-ancestry', ppid: 700 } })
    const reparented = snapshotApplicationProcesses(ps(row(701, 1)), bundle,
      { nodeModes: [mode(701, 1)], previousOwners: admitted.admissions })
    expect(reparented.serving).toEqual([701]); expect(reparented.externalNode).toEqual([])
    expect(reparented.admissions.find(row => row.pid === 701)).toMatchObject({ classification: 'gui', source: 'retained-gui',
      initial: owner.initial, confirmedGui: owner.confirmedGui })
  })

  it('retains a disappeared GUI admission without claiming it is alive, then recognizes the same original birth', () => {
    const first = snapshotApplicationProcesses(ps(main, row(701, 700)), bundle, { nodeModes: [mainMode, mode(701, 700)] })
    const missing = snapshotApplicationProcesses(ps(), bundle, { previousOwners: first.admissions })
    expect(missing.serving).toEqual([]); expect(missing.admissions).toEqual(first.admissions)
    const returned = snapshotApplicationProcesses(ps(row(701, 1)), bundle, { nodeModes: [mode(701, 1)], previousOwners: missing.admissions })
    expect(returned.serving).toEqual([701])
    expect(returned.admissions.find(row => row.pid === 701)).toMatchObject({ classification: 'gui', source: 'retained-gui' })
  })

  it('does not transfer a prior GUI pin across UID or birth replacement at the same PID', async () => {
    const original = guiAdmission({ pid: 800, ppid: 700, birth })
    for (const before of [{ ...original, uid: uid + 1 }, { ...original, birth: anotherBirth }]) {
      const current = await observe(ps(main, row(800, 90)), [mainMode, mode(800, 90)], [before])
      expect(current.serving).toEqual([700]); expect(current.externalNode).toEqual([800])
      expect(current.admissions).toContainEqual(before)
      const active = current.ownershipObservation.admissions.get(800)!
      expect(active.classification).toBe('external'); expect(active.confirmedGui).toBeUndefined()
      expect(active.initial.classification).toBe('external')
      if (before.birth === birth) expect(() => assertApplicationActivationOwnership({ previous: [before], beforeLaunch: [],
        current: current.processes, serving: current.serving, mainPid: 700, observation: current.ownershipObservation }))
        .toThrow('previous application owner')
    }
  })

  it('stops GUI ancestry at the authenticated independent Node owner across a Native intermediate', () => {
    const owner = { uid, pid: 600, ppid: 700, birth, command: `${EXECUTABLE} --original-semantic-owner` }
    const graph = ps(main, row(600, 700, owner.command), row(610, 600, _hygiene_fixturePath('private/native-runtime')),
      row(620, 610), row(701, 700))
    const scope = snapshotApplicationProcesses(graph, bundle, { independentOwners: [owner],
      nodeModes: [mainMode, mode(600, 700), mode(620, 610), mode(701, 700)] })
    expect(scope.serving).toEqual([700, 701]); expect(scope.externalNode).toEqual([600, 620])
    expect(scope.admissions.filter(row => [600, 620].includes(row.pid)))
      .toMatchObject([{ classification: 'external', source: 'independent-owner' }, { classification: 'external', source: 'independent-owner' }])
    expect(scope.admissions.find(row => row.pid === 620)!.initial.ancestry).toEqual({
      path: [{ uid, pid: 620, ppid: 610, birth }, { uid, pid: 610, ppid: 600, birth }, { uid, pid: 600, ppid: 700, birth }],
      termination: 'independent-owner', missingPid: null })
    expect(scope.admissions.find(row => row.pid === 701)).toMatchObject({ classification: 'gui', source: 'gui-ancestry' })
    const reparented = snapshotApplicationProcesses(ps(row(600, 1, owner.command), row(610, 600, _hygiene_fixturePath('private/native-runtime')), row(620, 610)), bundle,
      { independentOwners: [owner], nodeModes: [mode(600, 1), mode(620, 610)], previousOwners: scope.admissions })
    expect(reparented.serving).toEqual([]); expect(reparented.externalNode).toEqual([600, 620])
  })

  it('does not exempt a leaf or independent root with unbound mode or identity', () => {
    const owner = { uid, pid: 600, ppid: 700, birth, command: `${EXECUTABLE} --original-semantic-owner` }
    const graph = ps(main, row(600, 700, owner.command), row(610, 600, _hygiene_fixturePath('private/native-runtime')), row(620, 610))
    for (const changed of [{ owner: { ...owner, uid: uid + 1 } }, { owner: { ...owner, birth: anotherBirth } },
      { owner: { ...owner, command: `${EXECUTABLE} --another-owner` } },
      { root: { ...mode(600, 700), executable: _hygiene_fixturePath('private/another-executable') } },
      { root: { ...mode(600, 700), mode: 'unknown' } }, { root: { ...mode(600, 700), ppid: 90 } },
      { leaf: { ...mode(620, 610), birth: anotherBirth } }, { leaf: { ...mode(620, 610), mode: 'unknown' } }]) {
      const scope = snapshotApplicationProcesses(graph, bundle, { independentOwners: [changed.owner ?? owner],
        nodeModes: [mainMode, changed.root ?? mode(600, 700), changed.leaf ?? mode(620, 610)] })
      expect(scope.serving).toContain(620); expect(scope.externalNode).not.toContain(620)
    }
  })

  it('does not invent a path to an independent owner through missing or cyclic ancestry', () => {
    const owner = { uid, pid: 600, ppid: 700, birth, command: `${EXECUTABLE} --original-semantic-owner` }
    for (const graph of [ps(main, row(600, 700, owner.command), row(620, 610)),
      ps(main, row(600, 700, owner.command), row(610, 620, _hygiene_fixturePath('private/native-runtime')), row(620, 610))]) {
      const scope = snapshotApplicationProcesses(graph, bundle, { independentOwners: [owner], nodeModes: [mainMode, mode(600, 700), mode(620, 610)] })
      expect(scope.serving).toContain(620)
      expect(scope.admissions.find(row => row.pid === 620)).toMatchObject({ classification: 'unknown', source: 'ancestry-unconfirmed' })
    }
  })

  it('keeps unknown admission provenance in bounded activation diagnostics without exposing commands', async () => {
    const snapshot = ps(main, row(800, 91, `${EXECUTABLE} --private-argument`))
    const initial = await observe(snapshot, [mainMode])
    const current = await observe(snapshot, [mainMode, mode(800, 91)], initial.admissions)
    let failure: any
    try { assertApplicationActivationOwnership({ previous: initial.admissions.filter(row => row.pid === 800), beforeLaunch: [],
      current: current.processes, serving: current.serving, mainPid: 700, observation: current.ownershipObservation }) } catch (error) { failure = error }
    expect(failure?.ownershipDiagnostic.affected.admission).toMatchObject({ classification: 'unknown', source: 'ancestry-unconfirmed',
      initial: { classification: 'unknown', source: 'mode-unconfirmed' } })
    expect(failure.ownershipDiagnostic.ancestry.termination).toBe('missing-parent')
    expect(JSON.stringify(failure.ownershipDiagnostic)).not.toContain('private-argument')
  })

  it('explains the exact first quit survivor with original and current admissions, not unrelated commands', async () => {
    const initial = await observe(ps(main, row(800, 91, `${EXECUTABLE} --private-argument`)), [mainMode])
    const current = await observe(ps(row(800, 91, `${EXECUTABLE} --private-argument`), row(801, 90)), [mode(800, 91)], initial.admissions)
    const diagnostic = applicationQuitOwnershipDiagnostic(current, initial.admissions)!
    expect(diagnostic).toMatchObject({ stage: 'graceful-quit', mainPid: null, loadedMain: null, remainingCount: 2,
      affected: { identity: { uid, pid: 800, ppid: 91, birth }, mode: { status: 'bound' },
        admission: { classification: 'unknown', source: 'ancestry-unconfirmed' },
        previousAdmission: { classification: 'unknown', source: 'mode-unconfirmed' } },
      ancestry: { path: [{ uid, pid: 800, ppid: 91, birth }], termination: 'missing-parent', missingPid: 91 } })
    expect(diagnostic.affected.previousAdmission).toEqual(initial.admissions.find(row => row.pid === 800))
    expect(diagnostic.affected.admission).toEqual(current.admissions.find(row => row.pid === 800))
    expect(diagnostic.affected.admission.initial).toEqual(diagnostic.affected.previousAdmission.initial)
    expect(JSON.stringify(diagnostic)).not.toMatch(/private-argument|"(?:command|argv|environment)"/)
    expect(diagnostic.ancestry.path.some(row => row.pid === 801 || row.pid === 700)).toBe(false)
  })

  it('explains a retained GUI quit survivor after reparenting with both original and current ancestry', async () => {
    const initial = await observe(ps(main, row(701, 700)), [mainMode, mode(701, 700)])
    const current = await observe(ps(row(701, 1)), [mode(701, 1)], initial.admissions)
    const diagnostic = applicationQuitOwnershipDiagnostic(current, initial.admissions)!
    expect(diagnostic).toMatchObject({ remainingCount: 1, affected: { identity: { pid: 701, ppid: 1 },
      admission: { classification: 'gui', source: 'retained-gui', confirmedGui: { source: 'gui-ancestry', ppid: 700 } },
      previousAdmission: { classification: 'gui', source: 'gui-ancestry', ppid: 700 } } })
    expect(diagnostic.affected.admission.initial.ancestry.path.map(row => row.pid)).toEqual([701, 700])
    expect(diagnostic.ancestry.path.map(row => row.pid)).toEqual([701, 1])
    expect(diagnostic.ancestry.termination).toBe('system-root')
  })

  it('does not fabricate a quit survivor diagnostic when the current live set is empty', async () => {
    const current = await observe(ps(), [])
    expect(applicationQuitOwnershipDiagnostic(current, [])).toBeNull()
  })

  it('rejects untyped previous rows rather than treating missing admission facts as GUI confirmation', () => {
    expect(() => snapshotApplicationProcesses(ps(main), bundle, { previousOwners: [{ uid, pid: 800, ppid: 90, birth }] }))
      .toThrow('admission identity or provenance')
  })
})
