import { spawnSync } from 'node:child_process'
import { existsSync, writeFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

/**
 * Every Agent runs `amux` many times, so the CLI's fixed startup cost is paid per call and grows
 * with the number of Agents. Reading help, and sending an ordinary RPC command, must not load the
 * in-process Core client, its Session recovery, the Providers or the Runtime adapter: those belong
 * to the process that owns Sessions, not to a short-lived command-line client.
 */
const dist = fileURLToPath(new URL('../dist/', import.meta.url))
const entry = join(dist, 'agentmux.js')
const forbidden = ['client.js', 'runtime-client.js', 'agent-session-recovery/service.js', 'providers/index.js', 'ctxmux-run-adapter.js']

function loadedCoreModules(args: string[], env: NodeJS.ProcessEnv = {}): { status: number | null; stdout: string; core: string[] } {
  const dir = mkdtempSync(join(tmpdir(), 'amux-cli-graph-'))
  try {
    const hook = join(dir, 'record.mjs'), out = join(dir, 'loaded.json')
    writeFileSync(hook, `import { registerHooks } from 'node:module'\nimport { writeFileSync } from 'node:fs'\nconst loaded = []\n` +
      `registerHooks({ load(url, context, next) { loaded.push(url); return next(url, context) } })\n` +
      `process.on('exit', () => writeFileSync(${JSON.stringify(out)}, JSON.stringify(loaded)))\n`)
    const run = spawnSync(process.execPath, ['--import', hook, entry, ...args], { encoding: 'utf8', env: { ...process.env, ...env }, timeout: 30_000 })
    const loaded: string[] = existsSync(out) ? JSON.parse(readFileSync(out, 'utf8')) : []
    return { status: run.status, stdout: run.stdout, core: loaded.filter(url => url.startsWith('file://' + dist)).map(url => url.slice(('file://' + dist).length)) }
  } finally { rmSync(dir, { recursive: true, force: true }) }
}

it('the forbidden modules exist in this build, so their absence below is meaningful', () => {
  for (const name of forbidden) expect(existsSync(join(dist, name)), name).toBe(true)
})

it('amux --help loads no in-process Core client, Provider or Runtime adapter module', () => {
  const run = loadedCoreModules(['--help'])
  expect(run.status).toBe(0)
  expect(run.stdout).toContain('amux')
  expect(run.core, 'the recorder saw the CLI entry itself').toContain('agentmux.js')
  expect(run.core.filter(name => forbidden.includes(name))).toEqual([])
})

it('an ordinary RPC command to an absent endpoint loads none of them either', () => {
  const dir = mkdtempSync(join(tmpdir(), 'amux-cli-endpoint-'))
  try {
    // A real command path that fails fast: the endpoint socket does not exist.
    const run = loadedCoreModules(['--endpoint', `unix:${join(dir, 'absent.sock')}`, 'whoami'], { AGENTMUX_AGENT_SESSION_ID: '', AGENTMUX_AGENT_CAPABILITY: '' })
    expect(run.status).not.toBe(0)
    expect(run.core).toContain('agentmux.js')
    expect(run.core.filter(name => forbidden.includes(name))).toEqual([])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
