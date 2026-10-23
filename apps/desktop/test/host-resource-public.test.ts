import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentMuxControlServer, AgentMuxMemoryAgentSessionStore } from '@agentmux/core'
import { parseMetricsObservation, type MetricsObservation } from '@agentmux/core/control'
import { compileRendererProfileCli } from '../../../packages/core/test/helpers/renderer-profile-cli.js'
import { objectCliEnvironment } from '../../../packages/core/test/helpers/object-cli-rpc.js'
import { RuntimeController } from '../src/main/runtime-controller.js'
import { ProcessResourceSampler } from '../src/main/process-resource-sampler.js'
import { createResourceMetricsPort } from '../src/main/resource-usage-control.js'
vi.mock('electron', () => ({ app: { getAppMetrics: () => [] }, nativeImage: {}, clipboard: {}, shell: {} }))

afterEach(() => { vi.restoreAllMocks() })
async function cli(entry: string, directory: string, args: string[]) {
  const child = spawn(process.execPath, [entry, '--endpoint', 'unix://' + join(directory, 'control.sock'), ...args],
    { env: objectCliEnvironment(directory), stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = '', stderr = ''
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8')
  child.stdout.on('data', value => { stdout += value }); child.stderr.on('data', value => { stderr += value })
  const code = await new Promise<number | null>((done, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error('Private CLI did not complete')) }, 10_000)
    child.once('error', error => { clearTimeout(timer); reject(error) }); child.once('close', value => { clearTimeout(timer); done(value) })
  })
  return { code, stdout, stderr }
}
it('reads real nonprivileged Host sources through the original Main owner, shared port, Unix RPC and compiled metrics CLI', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'amux-host-public-')), compiled = join(directory, 'compiled')
  const sampler = new ProcessResourceSampler(), connect = vi.fn(async () => { throw new Error('No Runtime should be started for Host observation') })
  const runtime = new RuntimeController(new AgentMuxMemoryAgentSessionStore(), connect, undefined, sampler)
  sampler.setObservationSources({ observeRuntime: async () => [], processOwners: () => ({ rendererPids: [], browserPids: [] }),
    mainOwners: () => ({ ...runtime.resourceOwnerCounts(), fileWatchers: 0, browserViews: 0, releasedBrowserViews: 0 }),
    observeDiagnostics: (signal, generation) => runtime.performanceDiagnostics(signal, generation) })
  const port = createResourceMetricsPort({ sampler, currentWindow: () => null })
  const server = new AgentMuxControlServer({ coreClients: () => [], execute: vi.fn(), metrics: port }, join(directory, 'control.sock'))
  const release = new AbortController(), observations: MetricsObservation[] = []
  let subscription: { dispose(): void } | undefined
  try {
    await server.start()
    const ready = new Promise<MetricsObservation>((done, reject) => {
      const timer = setTimeout(() => reject(new Error('Real Host counters did not produce a measured interval')), 12_000)
      void port.subscribe(value => {
        const current = parseMetricsObservation(value); observations.push(current)
        const host = current.diagnostics.data?.host
        if (host?.cpu.data?.percent !== null && host?.cpu.data && host.network.data?.interfaces.some(item => item.intervalMs !== null)) { clearTimeout(timer); done(current) }
      }, () => {}, release.signal).then(value => { subscription = value }, reject)
    })
    await mkdir(compiled)
    const frozen = process.env.AGENTMUX_PERFORMANCE_SOURCES ? JSON.parse(await readFile(process.env.AGENTMUX_PERFORMANCE_SOURCES, 'utf8')) : {}
    const entry = await compileRendererProfileCli(resolve(import.meta.dirname, '../../..'), compiled, frozen, process.env.AGENTMUX_PERFORMANCE_LOADED)
    const observed = await ready, host = observed.diagnostics.data!.host
    expect(host.memory.data!.totalBytes).toBeGreaterThan(0)
    expect(host.cpu.data).toMatchObject({ basis: 'whole-host-capacity', percent: expect.any(Number), intervalMs: expect.any(Number) })
    expect(host.swap.data!.totalBytes).toBeGreaterThanOrEqual(host.swap.data!.usedBytes)
    expect(['normal', 'warning', 'critical']).toContain(host.pressure.data!.level)
    expect(host.network.data!.interfaces.length).toBeGreaterThan(0)
    expect(host.network.data!.interfaces.some(value => value.intervalMs !== null && value.intervalMs > 0 && value.receiveBytesPerSecond !== null)).toBe(true)
    const { code, stdout, stderr } = await cli(entry, directory, ['system', 'metrics', 'get'])
    expect(code).toBe(0); expect(stderr).toBe('')
    const reply = JSON.parse(stdout), received = parseMetricsObservation(reply.result.observation)
    expect(received.diagnostics.data!.host.network.data!.interfaces).toEqual(host.network.data!.interfaces)
    expect(received.diagnostics.data!.host.memory.data!.totalBytes).toBe(host.memory.data!.totalBytes)
    expect(received.diagnostics.data!.host.pressure.data!.level).toBe(host.pressure.data!.level)
    const guide = await cli(entry, directory, ['system', '--skill'])
    expect(guide.code).toBe(0); expect(guide.stderr).toBe(''); expect(guide.stdout).toContain('diagnostics.host describes the local machine')
    expect(connect).not.toHaveBeenCalled()
    const evidence = process.env.AGENTMUX_HOST_EVIDENCE
    if (evidence) {
      await mkdir(evidence, { recursive: true, mode: 0o700 })
      await writeFile(join(evidence, 'real-os-cli.json'), JSON.stringify({ scope: 'private-test-process-observing-real-local-machine',
        originalAppLifecycle: false, originalRunOperation: false, observations: observations.length, host, cli: reply, code, stderr, guide }, null, 2))
      await appendFile(join(evidence, 'actual-consumers.jsonl'), JSON.stringify({ chain: ['RuntimeController.performanceDiagnostics', 'MainPerformanceDiagnostics', 'HostResourceObserver', 'ProcessResourceSampler', 'createResourceMetricsPort', 'AgentMuxControlServer', 'system metrics get'], code }) + '\n')
    }
  } finally {
    release.abort(); subscription?.dispose(); port.dispose(); sampler.dispose(); await server.stop()
    await rm(directory, { recursive: true, force: true })
  }
}, 30_000)
