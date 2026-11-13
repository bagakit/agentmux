import { spawnSync } from 'node:child_process'
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

/**
 * Every Agent runs `amux` many times, so the CLI's fixed startup cost is paid per call and grows
 * with the number of Agents. Reading help and the RPC contract must not load the in-process Core
 * client, its Session recovery, the Providers or the Runtime adapter: those belong to the
 * process that owns Sessions, not to a short-lived command-line reader.
 */
const entry = fileURLToPath(new URL('../dist/agentmux.js', import.meta.url))

it('amux --help loads no in-process Core client, Provider or Runtime adapter module', () => {
  const dir = mkdtempSync(join(tmpdir(), 'amux-cli-graph-'))
  try {
    const hook = join(dir, 'record.mjs'), out = join(dir, 'loaded.json')
    writeFileSync(hook, `import { registerHooks } from 'node:module'\nimport { writeFileSync } from 'node:fs'\nconst loaded = []\n` +
      `registerHooks({ load(url, context, next) { loaded.push(url); return next(url, context) } })\n` +
      `process.on('exit', () => writeFileSync(${JSON.stringify(out)}, JSON.stringify(loaded)))\n`)
    const run = spawnSync(process.execPath, ['--import', hook, entry, '--help'], { encoding: 'utf8' })
    expect(run.status, run.stderr).toBe(0)
    expect(run.stdout).toContain('amux')
    const loaded: string[] = JSON.parse(spawnSync(process.execPath, ['-e', `process.stdout.write(require('node:fs').readFileSync(${JSON.stringify(out)}, 'utf8'))`], { encoding: 'utf8' }).stdout)
    const core = loaded.filter(url => url.includes('/packages/core/dist/') || url.includes('/@agentmux/core/dist/')).map(url => url.replace(/^.*\/dist\//u, ''))
    expect(core.length, 'the recorder saw the CLI entry itself').toBeGreaterThan(0)
    expect(core).toContain('agentmux.js')
    const forbidden = ['client.js', 'runtime-client.js', 'agent-session-recovery/service.js', 'providers/index.js', 'ctxmux-run-adapter.js']
    expect(core.filter(name => forbidden.includes(name))).toEqual([])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
