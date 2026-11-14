import assert from 'node:assert/strict'
import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { observeApplicationProcesses } from '../scripts/package-process-scope.mjs'

// The fixture runs only a private Node script in the selected signed Electron.
// It does not bootstrap Main, connect to a Runtime, or signal another process.
describe.skipIf(process.platform !== 'darwin' || !process.env.PROCESS_IDENTITY_ELECTRON)('installer original process identity across title changes', () => {
  it('reobserves the renamed real Electron Node child by its original OS identity and image', async () => {
    assert(process.env.PROCESS_IDENTITY_ELECTRON, 'Select the exact signed Electron executable for the private fixture')
    const executable = realpathSync(process.env.PROCESS_IDENTITY_ELECTRON)
    const bundle = { executable, helperRoot: resolve(dirname(executable), '../Frameworks') + '/' }
    const root = mkdtempSync(join(tmpdir(), 'agentmux-process-title-'))
    const script = join(root, 'private-node.cjs')
    const title = 'agentmux-private-renamed-node'
    writeFileSync(script, `const input=require('node:readline').createInterface({input:process.stdin});input.on('line',title=>{process.title=title;process.stdout.write('renamed\\n')});input.on('close',()=>process.exit(0));process.stdout.write('ready\\n');\n`)
    let child: ChildProcess | undefined
    const facts: Record<string, unknown> = { schema: 'agentmux.installer-process-title-proof.v1', executable,
      runtimeConnections: [], signals: [] }
    try {
      child = spawn(executable, [script], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['pipe', 'pipe', 'pipe'] })
      const closed = once(child, 'close')
      // Retain the exact ChildProcess close before any checks, including failures.
      facts.pid = child.pid
      try {
        expect((await once(child.stdout!, 'data'))[0].toString()).toBe('ready\n')
        const pid = child.pid!
        const row = () => execFileSync('/bin/ps', ['-p', String(pid), '-o', 'uid=,pid=,ppid=,lstart=,command='], { encoding: 'utf8' }).trim()
        facts.beforeRow = row()
        // Model one missing mode observation, retaining the actual OS admission.
        const missing = await observeApplicationProcesses(bundle, [], { modes: async () => [] })
        const initial = missing.admissions.find(admission => admission.pid === pid)!
        expect(initial).toMatchObject({ uid: process.getuid!(), pid, ppid: process.pid, classification: 'unknown', source: 'mode-unconfirmed' })
        const original = await observeApplicationProcesses(bundle)
        facts.originalMode = original.nodeModes.find(mode => mode.pid === pid)
        expect(facts.originalMode).toMatchObject({ uid: process.getuid!(), pid, ppid: process.pid, birth: initial.birth, mode: 'node', executable })
        const renamed = once(child.stdout!, 'data')
        child.stdin!.write(title + '\n')
        expect((await renamed)[0].toString()).toBe('renamed\n')
        const afterRow = row()
        facts.afterRow = afterRow
        expect(afterRow).toMatch(new RegExp(` ${title}$`))
        const image = JSON.parse(execFileSync(resolve(import.meta.dirname, '../../../packages/core/dist/native-socket-peer-darwin'),
          ['--process-executable', String(pid)], { encoding: 'utf8' }))
        facts.actualImage = image
        expect(image.pid).toBe(pid)
        expect(Buffer.from(image.pathHex, 'hex').toString('utf8')).toBe(executable)
        const current = await observeApplicationProcesses(bundle, missing.admissions)
        facts.current = { requested: current.ownershipObservation.requested.has(pid),
          mode: current.nodeModes.find(mode => mode.pid === pid) ?? null,
          admission: current.admissions.find(admission => admission.pid === pid),
          serving: current.serving.includes(pid), external: current.externalNode.includes(pid) }
        expect(facts.current).toMatchObject({ requested: true, serving: false, external: true,
          mode: { uid: initial.uid, pid, ppid: process.pid, birth: initial.birth, mode: 'node', executable },
          admission: { classification: 'external', source: 'system-root', initial: initial.initial } })
        const helperTitle = bundle.helperRoot + 'private-node-helper'
        const helperRenamed = once(child.stdout!, 'data')
        child.stdin!.write(helperTitle + '\n')
        expect((await helperRenamed)[0].toString()).toBe('renamed\n')
        const helperRow = row()
        expect(helperRow.endsWith(' ' + helperTitle)).toBe(true)
        // A fresh discovery must also read the real mode before assigning GUI.
        const helper = await observeApplicationProcesses(bundle)
        facts.helperTitle = { row: helperRow, requested: helper.ownershipObservation.requested.has(pid),
          mode: helper.nodeModes.find(mode => mode.pid === pid), admission: helper.admissions.find(admission => admission.pid === pid),
          serving: helper.serving.includes(pid), external: helper.externalNode.includes(pid) }
        expect(facts.helperTitle).toMatchObject({ requested: true, serving: false, external: true,
          mode: { pid, birth: initial.birth, mode: 'node', executable },
          admission: { classification: 'external', source: 'system-root' } })
        // Failed re-observation never borrows an earlier Node mode as authority.
        const unreadable = await observeApplicationProcesses(bundle, missing.admissions, { modes: async () => [] })
        expect(unreadable.serving).toContain(pid)
        expect(unreadable.admissions.find(admission => admission.pid === pid)).toMatchObject({ classification: 'unknown', source: 'mode-unconfirmed', initial: initial.initial })
        facts.unreadable = { serving: unreadable.serving.includes(pid), mode: unreadable.nodeModes.find(mode => mode.pid === pid) ?? null }
      } finally {
        child.stdin!.end()
        facts.exit = await closed
        expect(facts.exit).toEqual([0, null])
      }
    } finally {
      if (process.env.PROCESS_TITLE_FACTS) writeFileSync(process.env.PROCESS_TITLE_FACTS, JSON.stringify(facts, null, 2))
      rmSync(root, { recursive: true, force: true })
    }
  }, 30_000)
})
