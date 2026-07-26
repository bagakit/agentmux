import { afterEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  AgentMuxFileAgentSessionStore,
  defaultAgentMuxAgentSessionStorePath
} from '../src/agent-session-store.js'
import { terminalEnvironment } from '../src/client.js'
import { defaultAgentMuxRuntimeDirectory } from '../src/runtime-paths.js'
import type { AgentMuxStoredAgentSession } from '../src/types.js'

// The bug this guards: the desktop moved the Agent Session store onto durable userData, but the CLI each
// Agent runs still defaulted to the machine-level temp path — so `agentmux list sessions` / `inspect` read
// an empty registry for sessions that plainly exist. The desktop is the authority on the path; it tells the
// CLI through AGENTMUX_AGENT_SESSION_STORE, and a default-constructed store must honour it.

const priorInjected = process.env.AGENTMUX_AGENT_SESSION_STORE
const roots: string[] = []
afterEach(async () => {
  if (priorInjected === undefined) delete process.env.AGENTMUX_AGENT_SESSION_STORE
  else process.env.AGENTMUX_AGENT_SESSION_STORE = priorInjected
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function storedSession(): AgentMuxStoredAgentSession {
  return {
    kind: 'agent',
    agentSessionId: 'semantic-1',
    providerId: 'codex',
    executorId: 'codex',
    hostId: 'local',
    workspacePath: '/tmp/work',
    run: { runId: 'daemon-1' },
    retiredRuns: [],
    hookBindingId: 'hook-binding-1',
    hookToken: 'hook-token-1',
    outputCursorBytes: 0,
    createdAt: 100,
    updatedAt: 200,
    nativeHandle: { kind: 'provider', providerId: 'codex', sessionId: 'native-1' }
  }
}

describe('cross-process Agent Session store path', () => {
  it('resolves AGENTMUX_AGENT_SESSION_STORE so the CLI opens the desktop’s durable file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentmux-injected-store-'))
    roots.push(root)
    const injected = join(root, 'agent-sessions.json')
    process.env.AGENTMUX_AGENT_SESSION_STORE = injected
    expect(defaultAgentMuxAgentSessionStorePath()).toBe(injected)
    // The wiring that matters: a default-constructed store (what the in-agent CLI builds) opens that path.
    expect(new AgentMuxFileAgentSessionStore().path).toBe(injected)
  })

  it('falls back to the machine-level runtime temp path when the variable is absent', () => {
    delete process.env.AGENTMUX_AGENT_SESSION_STORE
    expect(defaultAgentMuxAgentSessionStorePath())
      .toBe(join(defaultAgentMuxRuntimeDirectory(), 'agent-sessions.json'))
  })

  it('rejects a relative injected path rather than silently reading a different store', () => {
    process.env.AGENTMUX_AGENT_SESSION_STORE = 'relative/agent-sessions.json'
    expect(() => defaultAgentMuxAgentSessionStorePath())
      .toThrowError(expect.objectContaining({ code: 'INVALID_AGENT_SESSION_STORE' }))
  })

  it('lets a default reader see exactly the sessions a writer at the injected path persisted', async () => {
    // End-to-end shape of the fix: the desktop writes at a durable path; the CLI, told that path through the
    // variable, constructs its store with no argument and reads the SAME sessions back — not an empty temp
    // registry. This is the behaviour that reports "0 sessions" for a live Agent when it regresses.
    const root = await mkdtemp(join(tmpdir(), 'agentmux-injected-roundtrip-'))
    roots.push(root)
    const durablePath = join(root, 'agent-sessions.json')

    const writer = new AgentMuxFileAgentSessionStore(durablePath)
    await writer.compareAndSwap(null, storedSession())

    process.env.AGENTMUX_AGENT_SESSION_STORE = durablePath
    const cliReader = new AgentMuxFileAgentSessionStore()
    const sessions = await cliReader.load()
    expect(sessions).toHaveLength(1)
    expect((sessions[0] as AgentMuxStoredAgentSession).agentSessionId).toBe('semantic-1')
  })
})

// The desktop is the only process that knows Electron userData, so it must PUSH the path to every process
// it spawns. That happens in the Client's spawn environment (terminalEnvironment), which every managed
// terminal and every Agent inherits — the CLI an Agent runs reads it back through the same variable. These
// assert on the emitted environment itself, not on source text: a scan of the function body would pass on
// the identifier appearing in a comment, so deleting the real emission has to change what the function
// RETURNS, or the divergence returns silently.
describe('the Client tells spawned processes where its store lives', () => {
  it('emits the store path under AGENTMUX_AGENT_SESSION_STORE when given one', () => {
    const env = terminalEnvironment({}, '/durable/userData/agent-sessions.json')
    expect(env.AGENTMUX_AGENT_SESSION_STORE).toBe('/durable/userData/agent-sessions.json')
    // The managed CLI hop still has to work, so its two companions must ride along in the same environment.
    expect(env.AGENTMUX_ENV).toBe('1')
    expect(env.AGENTMUX_CLI).toMatch(/\/bin\/agentmux$/u)
  })

  it('omits the variable entirely when there is no durable path (a memory-store Client)', () => {
    // A pathless store must not set the variable to an empty/undefined value — an in-agent CLI would then
    // resolve a different store than intended. Absent means absent, so the CLI keeps its own default.
    const env = terminalEnvironment({})
    expect('AGENTMUX_AGENT_SESSION_STORE' in env).toBe(false)
  })

  it('routes a file store’s path from the Client through the spawn environment end to end', async () => {
    // Bind the two halves: what a file-backed Client would hand terminalEnvironment (its store.path) is
    // exactly what defaultAgentMuxAgentSessionStorePath resolves when the CLI reads the variable back.
    const root = await mkdtemp(join(tmpdir(), 'agentmux-env-roundtrip-'))
    roots.push(root)
    const store = new AgentMuxFileAgentSessionStore(join(root, 'agent-sessions.json'))
    const env = terminalEnvironment({}, store.path)
    process.env.AGENTMUX_AGENT_SESSION_STORE = env.AGENTMUX_AGENT_SESSION_STORE
    expect(defaultAgentMuxAgentSessionStorePath()).toBe(store.path)
    expect(new AgentMuxFileAgentSessionStore().path).toBe(store.path)
  })
})

// The two spawn sites that feed terminalEnvironment (createTerminal for managed terminals, agentEnvironment
// for Agents) each have to hand it the live store path — and the accessor has to READ that path off the file
// store, not re-derive it. Proving that end to end needs a live daemon (see the packed integration test);
// in the fast suite the honest tool is a source scan, but it must be immune to the comment false-green that
// bit the earlier version: strip comments first, and anchor on code shape a comment cannot supply.
describe('every spawn site is wired to the store path', () => {
  const source = readFileSync(new URL('../src/client.ts', import.meta.url), 'utf8')
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/u, ''))
    .join('\n')

  it('hands terminalEnvironment the live path at both spawn sites', () => {
    const spawnSites = source.match(/terminalEnvironment\([^)]*this\.agentSessionStorePath\(\)/gu) ?? []
    // Assert the scan actually found the wiring — an empty match would be a silent white-green.
    expect(spawnSites.length).toBe(2)
  })

  it('reads the path off the file store instead of re-deriving it', () => {
    const accessorStart = source.indexOf('private agentSessionStorePath(')
    expect(accessorStart).toBeGreaterThan(-1)
    const accessorBody = source.slice(accessorStart, source.indexOf('\n  }\n', accessorStart))
    expect(accessorBody).toContain('this.store.path')
  })
})
