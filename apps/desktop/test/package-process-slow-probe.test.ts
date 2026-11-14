import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { observeApplicationProcesses } from '../scripts/package-process-scope.mjs'

describe.skipIf(process.platform !== 'darwin')('installer process identity under slow OS observation', () => {
  it('waits for both fenced process observations and keeps the bound Node owner', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agentmux-slow-process-probe-'))
    const previousNodeOptions = process.env.NODE_OPTIONS
    const executable = realpathSync(process.execPath)
    let child: ChildProcess | undefined
    try {
      // Delay the real bridge's ps read, without an external interpreter. This
      // still exercises its original fenced observation and child completion.
      const preload = join(root, 'slow-ps.mjs')
      writeFileSync(preload, `import cp from 'node:child_process';import{syncBuiltinESMExports}from'node:module';const original=cp.execFileSync;cp.execFileSync=(command,args,...rest)=>{if(command==='/bin/ps'&&args[0]==='-p')Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,2700);return original(command,args,...rest)};syncBuiltinESMExports();`)
      process.env.NODE_OPTIONS = `${previousNodeOptions ?? ''} --import=${preload}`.trim()
      child = spawn(executable, ['-e', 'setInterval(() => {}, 1000)'], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: 'ignore'
      })
      await new Promise<void>((resolve, reject) => {
        child!.once('spawn', resolve)
        child!.once('error', reject)
      })
      const pid = child.pid!
      const row = execFileSync('/bin/ps', ['-p', String(pid), '-o', 'uid=,pid=,ppid=,lstart=,command='], { encoding: 'utf8' })
      const scope = await observeApplicationProcesses({ executable, helperRoot: join(root, 'Frameworks') + '/' }, [], {
        processSnapshot: async () => row
      })
      expect(scope.nodeModes.find(mode => mode.pid === pid)).toMatchObject({
        pid, ppid: process.pid, uid: process.getuid!(), mode: 'node', executable
      })
      // The fixture omits the parent ancestry, so it must remain protected.
      expect(scope.serving).toContain(pid)
      expect(scope.admissions.find(admission => admission.pid === pid)?.classification).toBe('unknown')
    } finally {
      if (previousNodeOptions === undefined) delete process.env.NODE_OPTIONS
      else process.env.NODE_OPTIONS = previousNodeOptions
      if (child && child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM')
        await new Promise<void>(resolve => child!.once('exit', () => resolve()))
      }
      rmSync(root, { recursive: true, force: true })
    }
  }, 60_000)
})
