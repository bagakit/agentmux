import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { AgentMuxDaemonServer } from '../src/daemon-server.js'

const execFileAsync = promisify(execFile)
const cliPath = resolve(import.meta.dirname, '../bin/agentmux.js')
const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })))
})

describe('agentmux CLI', () => {
  it('prints a structured Doctor report for one reachable Local daemon', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentmux-cli-doctor-'))
    roots.push(root)
    const socketPath = join(root, 'agentmuxd.sock')
    const server = new AgentMuxDaemonServer({ socketPath })
    await server.start()
    try {
      const result = await execFileAsync(process.execPath, [
        cliPath,
        'doctor',
        '--socket',
        socketPath,
        '--json'
      ])
      const report = JSON.parse(result.stdout)
      expect(report).toMatchObject({
        ok: true,
        host: { kind: 'local', reachable: true, hostId: 'local', protocolVersion: 5 },
        runtime: { pty: { version: '1.2.0-beta.15', ready: true } },
        integration: { permissionDefault: 'reject' }
      })
      expect(report.agents).toHaveLength(5)
    } finally {
      await server.stop()
    }
  })

  it('rejects SSH-only options without an explicit SSH Host', async () => {
    await expect(execFileAsync(process.execPath, [
      cliPath,
      'doctor',
      '--remote-node',
      'node'
    ])).rejects.toMatchObject({
      stderr: expect.stringContaining('SSH options require --ssh-host')
    })
  })
})
