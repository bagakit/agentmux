import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { buildSync } from 'esbuild'
import { formatSessionAddress, formatRegionAddress, formatTabAddress, parseAmuxObjectLink, agentSessionSendCommand } from '../src/sharing.js'
import { ObjectCliProbe } from './helpers/object-cli-rpc.js'

const exec = promisify(execFile)
const packageRoot = fileURLToPath(new URL('../', import.meta.url))
const bin = join(packageRoot, 'bin')
const probes: ObjectCliProbe[] = []
afterEach(async () => { for (const probe of probes.splice(0)) await probe.stop() })

async function command(probe: ObjectCliProbe, script: string) {
  const env = probe.environment({ PATH: [bin, dirname(process.execPath), '/usr/bin', '/bin'].join(':') })
  return await exec('/bin/zsh', ['-f', '-c', script], { env })
    .then(reply => ({ code: 0, ...reply }),
      error => error as { code: number; stdout: string; stderr: string })
}

describe('public amux sharing consumption', () => {
  it('consumes decoded object links through the real short-name CLI and public service', async () => {
    const probe = new ObjectCliProbe(); probes.push(probe); await probe.start()
    const identity = "--original id$'quoted"
    const quoted = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'"
    const links = [formatSessionAddress(identity), formatRegionAddress(identity), formatTabAddress(identity)]
    expect(links).toHaveLength(3)
    for (const link of links) {
      const target = parseAmuxObjectLink(link)
      const script = target.kind === 'agent' ? agentSessionSendCommand(target.agentSessionId)
        : target.kind === 'region' ? `amux space inspect --region=${quoted(target.regionId)}`
        : target.kind === 'tab' ? `amux space inspect --tab=${quoted(target.tabId)}` : ''
      expect(script.length).toBeGreaterThan(0)
      const result = await command(probe, script)
      expect(result.code, result.stderr).toBe(1)
      expect(JSON.parse(result.stderr).error.code).toBe('CLI_ROUTE_PROBE')
    }
    expect(probe.requests.map(request => ({ method: request.method, params: request.params }))).toEqual([
      { method: 'agent.send', params: { target: { kind: 'agent-session', agentSessionId: identity }, text: '...', sourceChannel: 'cli', operationId: expect.any(String) } },
      { method: 'space.inspect', params: { target: { regionId: identity } } },
      { method: 'space.inspect', params: { target: { tabId: identity } } }
    ])
    const guide = await command(probe, 'amux --skill')
    expect(guide.code, guide.stderr).toBe(0)
    expect(guide.stdout).toContain('amux://')
    expect(guide.stdout).toContain('parseAmuxObjectLink')
    expect(guide.stdout).toContain('--expect-session SID')
    expect(probe.requests).toHaveLength(3)
  })

  it('publishes one node-free export for both browser and Node consumers', async () => {
    const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'))
    expect(manifest.bin.amux).toBe('./bin/amux')
    expect(manifest.bin).not.toHaveProperty('agentmux')
    expect(manifest.exports['./sharing']).toEqual({
      types: './dist/sharing.d.ts', import: './dist/sharing.js'
    })
    const bundled = buildSync({
      stdin: { contents: "import {formatSessionAddress} from '@agentmux/core/sharing'; console.log(formatSessionAddress('S'))",
        resolveDir: fileURLToPath(new URL('../../../apps/desktop', import.meta.url)) },
      bundle: true, platform: 'browser', write: false, metafile: true
    })
    expect(bundled.outputFiles).toHaveLength(1)
    expect(Object.keys(bundled.metafile!.inputs)).toEqual(expect.arrayContaining([expect.stringContaining('dist/sharing.js')]))
    expect(Object.keys(bundled.metafile!.inputs).filter(path => /client\.js|ctxmux|react|electron/.test(path))).toEqual([])
    const result = await exec(process.execPath, ['--input-type=module', '-e',
      "import {formatSessionAddress} from '@agentmux/core/sharing'; console.log(formatSessionAddress('S'))"
    ], { cwd: fileURLToPath(new URL('../../../apps/desktop', import.meta.url)) })
    expect(result.stdout).toBe('amux://agent/S\n')
  })

  it('includes the executable short name and sharing module in the real package archive', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'amux-sharing-package-'))
    try {
      const result = await exec('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', directory], {
        cwd: packageRoot, timeout: 20_000
      })
      const archives = JSON.parse(result.stdout)
      expect(archives).toHaveLength(1)
      const files = archives[0].files as { path: string; mode: number }[]
      const shortName = files.find(file => file.path === 'bin/amux')
      expect(shortName).toBeDefined()
      expect(shortName!.mode & 0o111).not.toBe(0)
      expect(files.map(file => file.path)).not.toContain('bin/agentmux')
      await exec('tar', ['-xzf', join(directory, archives[0].filename), '-C', directory])
      // Reuse the locked dependency closure; execute the archive's own bin and dist.
      await symlink(join(packageRoot, 'node_modules'), join(directory, 'package', 'node_modules'))
      const invoked = await exec(join(directory, 'package', 'bin', 'amux'), ['system', 'endpoint'])
      expect(JSON.parse(invoked.stdout)).toMatchObject({ ok: true, operation: 'system.endpoint' })
      expect(files.map(file => file.path)).toEqual(expect.arrayContaining(['dist/sharing.js', 'dist/sharing.d.ts']))
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }, 30_000)
})
