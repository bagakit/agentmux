import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const modulePath = fileURLToPath(new URL('../scripts/probe-process.mjs', import.meta.url))

describe('probe process ownership', () => {
  it('stops a wedged child group on an early failure marker', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentmux-probe-process-'))
    const child = await import(modulePath)
    const result = await child.runProbeProcess(process.execPath, [
      '-e',
      "process.stderr.write('file_editing_probe_failed=boom\\n'); setInterval(() => {}, 1000)"
    ], {
      temporaryRoot: root,
      cwd: root,
      env: { ...process.env },
      timeoutMs: 5_000,
      graceMs: 100
    })
    expect(result.exitCode).toBe(1)
    expect(result.timedOut).toBe(false)
    await expect(child.listProbeProcesses(-1, root)).resolves.toEqual([])
    await rm(root, { recursive: true, force: true })
  })

  it('bounds a timeout and reports cleanup failure instead of claiming zero owners', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentmux-probe-process-'))
    const child = await import(modulePath)
    const started = Date.now()
    const result = await child.runProbeProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      temporaryRoot: root,
      cwd: root,
      env: { ...process.env },
      timeoutMs: 100,
      graceMs: 50
    })
    expect(result.timedOut).toBe(true)
    expect(Date.now() - started).toBeLessThan(3_000)
    await rm(root, { recursive: true, force: true })
  })
})
