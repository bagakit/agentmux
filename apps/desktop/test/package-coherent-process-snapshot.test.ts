import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { appendFileSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { observeApplicationProcesses, assertApplicationActivationOwnership, applicationQuitOwnershipDiagnostic } from '../scripts/package-process-scope.mjs'
import { confirmApplicationActivation } from '../scripts/package-macos.mjs'
import { fixturePath, fixturePsBirth } from '../scripts/lib/fixture-values.mjs'

const uid = process.getuid!(), birth = fixturePsBirth(23889601000), anotherBirth = fixturePsBirth(23889602000)
const app = fixturePath('private/coherent-fixture/AgentMux.app'), executable = join(app, 'Contents/MacOS/AgentMux')
const bundle = { executable, helperRoot: join(app, 'Contents/Frameworks') + '/' }
const row = (pid: number, ppid: number, command = executable, born = birth, ownerUid = uid) => `${ownerUid} ${pid} ${ppid} ${born} ${command}`
const system = row(1, 0, '/sbin/launchd'), parent = row(90, 1, fixturePath('private/parent')), unrelated = row(91, 1, fixturePath('private/unselected'))
const mode = (pid: number, ppid: number, kind = 'node') => ({ uid, pid, ppid, birth, executable, mode: kind })
const ps = (...rows: string[]) => [system, parent, unrelated, ...rows].join('\n')
function record(value: unknown) { if (process.env.COHERENT_PROCESS_FACTS) appendFileSync(process.env.COHERENT_PROCESS_FACTS, JSON.stringify(value) + '\n') }

it.each(['gui', 'unknown'])('protects a cut-late %s and keeps unselected cut births for the actual activation consumer', async kind => {
  const first = ps(row(700, 1)), cut = ps(row(700, 1), row(800, 90))
  const reads: (number[] | undefined)[] = [], requests: number[][] = []
  const scope = await observeApplicationProcesses(bundle, [], {
    processSnapshot: async pids => { reads.push(pids); return reads.length === 1 ? first : cut },
    modes: async pids => { requests.push(pids); return requests.length === 1 ? [mode(700, 1, 'gui')] : [mode(700, 1, 'gui'), { ...mode(800, 90, kind) }] }
  })
  expect(reads.length).toBe(3); expect(reads[2]).toEqual(expect.arrayContaining([700, 800, 90, 1])); expect(reads[2]).not.toContain(91)
  expect(scope.serving).toContain(800); expect(scope.externalNode).not.toContain(800)
  expect(scope.processes).toContainEqual({ pid: 91, ppid: 1, birth })
  expect(() => confirmApplicationActivation({ previous: [], beforeLaunch: [], scope, main: { pid: 700 }, native: { status: 'unchanged' }, intent: 'full', path: app })).toThrow('not a confirmed descendant')
  expect(() => assertApplicationActivationOwnership({ previous: [], beforeLaunch: [{ pid: 91, ppid: 1, birth }], current: scope.processes, serving: [91], mainPid: 91 })).toThrow('existed before candidate launch')
  record({ case: 'cut-late-' + kind, reads, requests, serving: scope.serving, unrelatedBirthRetained: scope.processes.some(row => row.pid === 91) })
})

it.each(['birth', 'uid', 'ppid'])('does not borrow a candidate mode after targeted %s drift', async field => {
  const current = { birth, uid, ppid: 90, ...{ [field]: field === 'birth' ? anotherBirth : field === 'uid' ? uid + 1 : 91 } }
  const cut = ps(row(700, 1), row(800, 90)), final = ps(row(700, 1), row(800, current.ppid, executable, current.birth, current.uid))
  let reads = 0
  const scope = await observeApplicationProcesses(bundle, [], {
    processSnapshot: async pids => { reads++; return pids ? final : cut }, modes: async () => [mode(700, 1, 'gui'), mode(800, 90)]
  })
  record({ case: 'candidate-' + field, serving: scope.serving, modeReturned: scope.nodeModes.some(mode => mode.pid === 800) })
  expect(reads).toBe(3); expect(scope.serving).toContain(800); expect(scope.externalNode).not.toContain(800)
})

it.each(['birth', 'uid', 'ppid'])('does not follow stale cut ancestors after targeted ancestor %s drift', async field => {
  const changed = { birth, uid, ppid: 1, ...{ [field]: field === 'birth' ? anotherBirth : field === 'uid' ? uid + 1 : 91 } }
  const cut = ps(row(700, 1), row(800, 90))
  const final = [system, row(90, changed.ppid, fixturePath('private/parent'), changed.birth, changed.uid), unrelated, row(700, 1), row(800, 90)].join('\n')
  const reads: (number[] | undefined)[] = []
  const scope = await observeApplicationProcesses(bundle, [], {
    processSnapshot: async pids => { reads.push(pids); return pids ? final : cut }, modes: async () => [mode(700, 1, 'gui'), mode(800, 90)]
  })
  record({ case: 'ancestor-' + field, reads, serving: scope.serving, admission: scope.admissions.find(row => row.pid === 800) })
  expect(reads[2]).not.toContain(91)
  expect(scope.serving).toContain(800); expect(scope.externalNode).not.toContain(800)
  expect(scope.admissions.find(row => row.pid === 800)).toMatchObject({ classification: 'unknown', source: 'ancestry-unconfirmed' })
  expect(scope.nodeModes.find(row => row.pid === 800)).toMatchObject({ mode: 'node' })
})

async function actualFixture() {
  const root = mkdtempSync(join(tmpdir(), 'agentmux-coherent-process-'))
  const binary = realpathSync(createRequire(import.meta.url)('electron') as string)
  const localBundle = { executable: binary, helperRoot: resolve(dirname(binary), '../Frameworks') + '/' }
  const nodeScript = join(root, 'node.cjs'), guiScript = join(root, 'gui.cjs')
  writeFileSync(nodeScript, "process.stdin.resume();process.stdin.on('end',()=>process.exit(0));process.stdout.write('ready\\n');\n")
  writeFileSync(guiScript, "const {app}=require('electron');app.setPath('userData',require('path').join(__dirname,'gui-data'));app.setActivationPolicy('prohibited');app.disableHardwareAcceleration();process.stdin.resume();process.stdin.on('end',()=>app.exit(0));app.whenReady().then(()=>process.stdout.write('ready\\n'));\n")
  const children: { child: ChildProcess; closed: Promise<unknown[]>; kind: string }[] = []
  async function start(kind: 'node' | 'gui') {
    const env = { ...process.env }; if (kind === 'node') env.ELECTRON_RUN_AS_NODE = '1'; else delete env.ELECTRON_RUN_AS_NODE
    const child = spawn(binary, [kind === 'node' ? nodeScript : guiScript], { env, stdio: ['pipe', 'pipe', 'pipe'] })
    const closed = once(child, 'close'); children.push({ child, closed, kind })
    expect((await Promise.race([once(child.stdout!, 'data'), closed.then(exit => { throw Error('Private process closed before readiness: ' + JSON.stringify(exit)) })]))[0].toString()).toBe('ready\n')
    return child.pid!
  }
  function census(pids?: number[]) {
    const args = pids ? ['-p', pids.join(','), '-o', 'uid=,pid=,ppid=,lstart=,command='] : ['-axo', 'uid=,pid=,ppid=,lstart=,command=']
    const text = execFileSync('/bin/ps', args, { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } })
    // This private namespace excludes other tests using the same bare Electron.
    // Every non-Electron row and every original ancestor remains in the cut.
    return text.split('\n').filter(line => {
      const command = /^\s*\d+\s+\d+\s+\d+\s+\S+\s+\S+\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4}\s+(.+)$/.exec(line)?.[1] ?? ''
      return !(command === binary || command.startsWith(binary + ' ') || command.startsWith(localBundle.helperRoot)) ||
        children.some(({ child }) => new RegExp(`^\\s*\\d+\\s+${child.pid}\\s`).test(line))
    }).join('\n')
  }
  async function close() {
    const exits = await Promise.all(children.map(async ({ child, closed, kind }) => { child.stdin!.end(); const exit = await closed; expect(exit).toEqual([0, null]); return { pid: child.pid, kind, exit } }))
    record({ case: 'private-children-closed', exits, signals: [], runtimeConnections: [] }); rmSync(root, { recursive: true, force: true })
  }
  return { binary, localBundle, start, census, close }
}

describe.skipIf(process.platform !== 'darwin')('actual private Electron processes consume the finite census', () => {
  it('finishes under real Node churn without importing the final unqueried global tail', async () => {
    const f = await actualFixture(), reads: (number[] | undefined)[] = [], born: number[] = []
    try {
      const scope = await observeApplicationProcesses(f.localBundle, [], { processSnapshot: async pids => {
        reads.push(pids); born.push(await f.start('node')); return f.census(pids)
      } })
      record({ case: 'actual-node-churn', reads, born, serving: scope.serving, external: scope.externalNode })
      expect(reads.length).toBe(3); expect(reads[2]).toBeInstanceOf(Array)
      expect(scope.serving).toEqual([]); expect([...scope.externalNode].sort((a, b) => a - b)).toEqual(born.slice(0, 2).sort((a, b) => a - b))
      expect(scope.processes.some(row => row.pid === born[2])).toBe(false)
      expect(applicationQuitOwnershipDiagnostic(scope, [])).toBeNull()
    } finally { await f.close() }
  })

  it('protects a real cut-late GUI and keeps missing mode unknown on repeated observations', async () => {
    const f = await actualFixture(); let calls = 0, gui = 0
    try {
      const scope = await observeApplicationProcesses(f.localBundle, [], { processSnapshot: async pids => {
        calls++; if (calls === 1) await f.start('node'); if (calls === 2) gui = await f.start('gui'); return f.census(pids)
      } })
      expect(scope.serving).toContain(gui); expect(scope.nodeModes.find(mode => mode.pid === gui)).toMatchObject({ mode: 'gui', executable: f.binary })
      for (let i = 0; i < 2; i++) {
        const unknown = await observeApplicationProcesses(f.localBundle, [], { processSnapshot: async pids => f.census(pids), modes: async () => [] })
        expect(unknown.serving).toContain(gui); expect(unknown.admissions.find(row => row.pid === gui)).toMatchObject({ classification: 'unknown', source: 'mode-unconfirmed' })
      }
      record({ case: 'actual-cut-late-gui', gui, serving: scope.serving, mode: scope.nodeModes.find(mode => mode.pid === gui), repeatedUnknownProtected: true })
    } finally { await f.close() }
  })
})
