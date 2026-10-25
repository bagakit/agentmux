import { afterAll, beforeAll, expect, it } from 'vitest'
import { build } from 'esbuild'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, relative } from 'node:path'
import { createHash } from 'node:crypto'
import { analyseV8Profile, parseV8ProfileBytes, summariseV8Profile } from '../src/v8-profile-analysis.js'
import { analyseLocalV8Profile } from '../src/v8-profile-analysis-cli.js'
import type { V8Profile } from '../src/v8-profile.js'

const execute = promisify(execFile), root = resolve(import.meta.dirname, '../../..')
const frame = (functionName: string, scriptId = '0', url = '', lineNumber = -1, columnNumber = -1) =>
  ({ functionName, scriptId, url, lineNumber, columnNumber })
function original(): V8Profile {
  return { startTime: 100, endTime: 10100, nodes: [
    { id: 1, callFrame: frame('(root)'), children: [2, 3, 4, 5] },
    { id: 2, callFrame: frame('(idle)') },
    { id: 3, callFrame: frame('(garbage collector)') },
    { id: 4, callFrame: frame('(program)') },
    { id: 5, callFrame: frame('(idle)', '3', 'app://assets/workbench.js', 8, 42), children: [6] },
    { id: 6, callFrame: frame('paint', '3', 'app://assets/workbench.js', 10, 17) }
  ], samples: [2, 3, 4, 5, 6], timeDeltas: [1000, 2000, 500, 1000, 500] }
}
function data(profile = original()) {
  const result = analyseV8Profile(profile)
  expect(result.reason).toBeNull()
  if (!result.data) throw Error('A real nonempty analysis is required')
  return result.data
}

it('partitions original self weights without counting inclusive children twice or classifying a same-named script as idle', () => {
  const value = data()
  expect(value.weights).toEqual({ script: { selfMs: 1.5, samples: 2 }, idle: { selfMs: 1, samples: 1 },
    gc: { selfMs: 2, samples: 1 }, unattributed: { selfMs: 0.5, samples: 1 } })
  expect(value.sampledMs).toBe(5)
  expect(value.frames.get(5)).toMatchObject({ selfMs: 1, totalMs: 1.5, column: 42, line: 8, scriptId: '3', parent: 1 })
  expect(value.frames.get(1)?.totalMs).toBe(5)
})

it('keeps sparse original timing, last-sample tail and overweight intervals without renormalizing', () => {
  const value = data()
  expect(value.profileDurationMs).toBe(10); expect(value.lastSampleTailMs).toBe(5); expect(value.maxSampleGapMs).toBe(2)
  const over = data({ ...original(), endTime: 1100 })
  expect(over.sampledMs).toBe(5); expect(over.lastSampleTailMs).toBe(-4)
})

it('requires the complete synthetic identity, including absent source positions', () => {
  const p = original()
  p.nodes[1]!.callFrame.columnNumber = 0
  p.nodes[2]!.callFrame.scriptId = '9'
  expect(data(p).weights).toEqual({ script: { selfMs: 3.5, samples: 3 }, idle: { selfMs: 0, samples: 0 },
    gc: { selfMs: 0, samples: 0 }, unattributed: { selfMs: 1.5, samples: 2 } })
})

it('keeps original empty URLs distinct from real scripts named like display labels', () => {
  const p = original()
  p.nodes[4]!.callFrame.url = '(runtime / no script)'
  p.nodes[5]!.callFrame.url = ''
  const value = data(p)
  expect(value.modules).toEqual([
    { url: '', selfMs: 4, samples: 4 },
    { url: '(runtime / no script)', selfMs: 1, samples: 1 }
  ])
  expect(value.weights.script).toEqual({ selfMs: 1.5, samples: 2 })
})

it.each(['empty', 'zero', 'missing', 'cycle', 'duplicate', 'overflow'] as const)('preserves unanalysable %s input instead of inventing a successful projection', kind => {
  const p = original()
  if (kind === 'empty') { p.samples = []; p.timeDeltas = [] }
  if (kind === 'zero') p.timeDeltas = [0, 0, 0, 0, 0]
  if (kind === 'missing') p.nodes[0]!.children!.push(99)
  if (kind === 'cycle') p.nodes[5]!.children = [1]
  if (kind === 'duplicate') p.nodes.push(p.nodes[1]!)
  if (kind === 'overflow') { p.samples = Array(3000).fill(2); p.timeDeltas = Array(3000).fill(Number.MAX_VALUE) }
  expect(analyseV8Profile(p).data).toBeNull()
})

let dir: string, cli: string
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'agentmux-profile-analysis-')); cli = join(dir, 'cli.mjs')
  await symlink(join(root, 'packages/core/node_modules'), join(dir, 'node_modules'), 'dir')
  const overrides = process.env.AGENTMUX_PERFORMANCE_SOURCES ? JSON.parse(await readFile(process.env.AGENTMUX_PERFORMANCE_SOURCES, 'utf8')) as Record<string, string> : {}
  await build({ absWorkingDir: root, entryPoints: ['packages/core/src/agentmux.ts'], outfile: cli,
    bundle: true, platform: 'node', format: 'esm', packages: 'external', logLevel: 'silent',
    plugins: [{ name: 'actual-source-inverses', setup(builder) {
      builder.onLoad({ filter: /\.ts$/ }, async args => {
        const code = overrides[relative(root, args.path)]
        return code === undefined ? undefined : { contents: code, loader: 'ts' }
      })
    } }] })
}, 20000)
afterAll(async () => { if (dir) await rm(dir, { recursive: true, force: true }) })

it('runs the actual CLI with invalid endpoint and incomplete managed credentials, hashing original file bytes', async () => {
  const bytes = JSON.stringify(original(), null, 2) + '\n', path = join(dir, 'original.cpuprofile')
  await writeFile(path, bytes)
  const { stdout, stderr } = await execute(process.execPath, [cli, '--endpoint', 'invalid-endpoint', 'system', 'metrics', 'profile', 'analyze', '--input', path],
    { env: { ...process.env, AGENTMUX_AGENT_SESSION_ID: 'incomplete', AGENTMUX_AGENT_CAPABILITY: '' } })
  expect(stderr).toBe('')
  const output = JSON.parse(stdout)
  expect(output.result).toEqual(summariseV8Profile(analyseV8Profile(parseV8ProfileBytes(Buffer.from(bytes))), {
    sha256: createHash('sha256').update(bytes).digest('hex'), bytes: Buffer.byteLength(bytes), captureIdentity: 'unavailable-in-bare-profile'
  }))
  expect(output).toMatchObject({ ok: true, operation: 'system.metrics.profile.analyze', result: { status: 'analysed',
    source: { sha256: createHash('sha256').update(bytes).digest('hex'), bytes: Buffer.byteLength(bytes), captureIdentity: 'unavailable-in-bare-profile' },
    timing: { weightedMs: 5, profileDurationMs: 10, lastSampleTailMs: 5 }, weights: { idle: { selfMs: 1 } } } })
  expect(output.result.frames).toHaveLength(5)
  expect(output.result.frames.find((value: { id: number }) => value.id === 5)).toMatchObject({ line: 8, column: 42 })
  expect((await execute(process.execPath, [cli, 'system', 'metrics', 'profile', '--help'])).stdout).toContain('profile analyze --input FILE')
})

it('bounds report labels and caller paths without changing the retained original bytes', async () => {
  const p = original(), secret = 'private-original-value'
  p.nodes[4]!.callFrame.functionName = 'x'.repeat(5000) + secret
  const path = join(dir, 'labels.cpuprofile'), bytes = JSON.stringify(p)
  await writeFile(path, bytes)
  const report = await analyseLocalV8Profile(path)
  expect(report.status).toBe('analysed')
  expect(JSON.stringify(report)).not.toContain(secret)
  expect(JSON.stringify(report)).toContain('"labelsTruncated":true')
  expect(Buffer.byteLength(JSON.stringify(report))).toBeLessThan(512 * 1024)
  expect(await readFile(path, 'utf8')).toBe(bytes)
})

it('rejects oversized or malformed originals without leaking the JSON parser snippet', async () => {
  const path = join(dir, 'invalid.cpuprofile')
  await writeFile(path, '{"secret-original-fragment')
  await expect(analyseLocalV8Profile(path)).rejects.toThrow('not valid profile JSON')
  const invalidUtf8 = Buffer.from(JSON.stringify(original()))
  invalidUtf8[invalidUtf8.indexOf('paint')] = 0xff
  await writeFile(path, invalidUtf8)
  await expect(analyseLocalV8Profile(path)).rejects.toThrow('not valid profile JSON')
  await writeFile(path, ' '.repeat(8 * 1024 * 1024 + 1))
  await expect(analyseLocalV8Profile(path)).rejects.toThrow('8 MiB')
})
