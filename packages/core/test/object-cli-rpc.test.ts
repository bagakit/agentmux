import { fixturePath } from './helpers/fixture-values.js'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AGENTMUX_CLI_COMMANDS } from '../src/agentmux-cli-commands.js'
import { AGENTMUX_RPC_CONTROL_METHODS, AGENTMUX_RPC_NATIVE_METHODS } from '../src/public-rpc.js'
import { ObjectCliProbe, objectCliSeed } from './helpers/object-cli-rpc.js'
import { parseAgentMuxSpatialGraph } from '../src/spatial-graph.js'

const fixtures: ObjectCliProbe[] = []
afterEach(async () => { for (const fixture of fixtures.splice(0)) await fixture.stop() })
async function probe(handle?: ConstructorParameters<typeof ObjectCliProbe>[0]) {
  const fixture = new ObjectCliProbe(handle); fixtures.push(fixture); await fixture.start(); return fixture
}

describe('compiled object CLI through a private RPC transport probe', () => {
  it('routes the nonempty complete registration through canonical methods, independently of wire IDs', async () => {
    const fixture = await probe()
    const methods = AGENTMUX_CLI_COMMANDS.filter(entry => !entry.local).map(entry => entry.method)
    const publicMethods = [...Object.keys(AGENTMUX_RPC_CONTROL_METHODS), ...Object.keys(AGENTMUX_RPC_NATIVE_METHODS)]
      .filter(method => method !== 'system.subscription.cancel' && method !== 'system.endpoint' && !method.startsWith('runtime.'))
    // runtime.* is the Host SDK facade; application commands retain complete CLI coverage.
    const sdkMethods = Object.keys(AGENTMUX_RPC_NATIVE_METHODS).filter(method => method.startsWith('runtime.'))
    expect(sdkMethods.length).toBeGreaterThan(0)
    expect(methods.some(method => sdkMethods.includes(method))).toBe(false)
    expect(methods.length).toBeGreaterThan(0)
    expect(new Set(methods).size).toBe(methods.length)
    expect([...methods].sort()).toEqual(publicMethods.sort())
    const ordinary = AGENTMUX_CLI_COMMANDS.filter(entry => !entry.local && !entry.stream)
    expect(ordinary.length).toBeGreaterThan(0)
    const graph = parseAgentMuxSpatialGraph({ spaces: [], zones: [], tabs: [], regions: [], bindings: [], layouts: {}, tabLayouts: {}, resources: {} })
    const stdinByMethod: Record<string, string> = {
      'agent.native.confirm': JSON.stringify({ agentSessionId: 'SID', expectedRun: { runId: 'RUN' },
        expectedNativeHandle: { kind: 'provider', providerId: 'private', sessionId: 'before' },
        candidateNativeHandle: { kind: 'provider', providerId: 'private', sessionId: 'current' }, expectedObservationAt: 1, operationId: 'NATIVE' }),
      'space.commit': JSON.stringify(graph),
      'browser.task.batch': JSON.stringify({ parameters: { fresh: 'input' }, items: [{ id: 'ITEM', parameters: { fresh: 'item' } }] }),
      'browser.task.run': JSON.stringify({ fresh: 'input' })
    }
    for (const entry of ordinary) {
      const result = await fixture.run([...entry.method.split('.'), ...objectCliSeed(entry.method, fixture.inputPath)], stdinByMethod[entry.method] ?? 'return await snapshot()')
      expect(result.code, entry.method + ': ' + result.stderr).toBe(1)
      expect(JSON.parse(result.stderr)).toMatchObject({ ok: false, operation: entry.method, error: { code: 'CLI_ROUTE_PROBE' } })
    }
    expect(fixture.requests.map(request => request.method)).toEqual(ordinary.map(entry => entry.method))
    for (const request of fixture.requests) {
      expect(request).toMatchObject({ jsonrpc: '2.0', id: expect.anything(), method: expect.any(String), params: expect.any(Object) })
      expect(Object.keys(request).sort()).toEqual(['id', 'jsonrpc', 'method', 'params'])
      expect(request.params).not.toHaveProperty('schemaVersion')
      expect(request.params).not.toHaveProperty('requestId')
      if (request.params.operationId !== undefined) expect(request.id).not.toBe(request.params.operationId)
    }
    for (const method of ['agent.reopen', 'agent.reopen.check']) {
      expect(fixture.requests.find(request => request.method === method)?.params).toEqual({ agentSessionId: 'SID', expectedRetiredAt: 12, operationId: 'REOPEN' })
    }
    expect(fixture.requests.find(request => request.method === 'space.commit')?.params).toEqual({ expectedRevision: 0, graph })
    expect(fixture.requests.find(request => request.method === 'space.resolve')?.params).toEqual({ tabId: 'TAB', regionId: 'R', direction: 'left' })
    expect(fixture.requests.find(request => request.method === 'browser.run')?.params).toMatchObject({ operationId: 'BOP', code: 'return await snapshot()' })
    expect(fixture.requests.find(request => request.method === 'browser.task.run')?.params).toEqual({ browserId: 'B', assetId: 'A', version: 1, parameters: { fresh: 'input' } })
  }, 120_000)

  it('keeps literal option-looking text, opaque IDs, input JSON and exact business identities', async () => {
    const fixture = await probe()
    const cases = [
      ['agent', 'send', '--to-session', 'constructor', '--text', '--help', '--operation-id', 'M1'],
      ['settings', 'hosts', 'test', '--help'],
      ['settings', 'set', 'client.label', '--help'],
      ['settings', 'browser-links', 'forget', ''],
      ['space', 'inspect', '--operation-id', 'O1'],
      ['agent', 'open', '--project', 'P', '--source-workspace', 'W', '--space', 'S', '--new-zone', '--directory', ' ' + fixturePath("literal directory") + ' ', '--new-tab', '--executor', 'E', '--prompt', '--help', '--operation-id', 'OPEN'],
      ['settings', 'prompts', 'update', '--help', '--input', fixture.inputPath]
    ]
    for (const args of cases) {
      const reply = await fixture.run(args)
      expect(reply.code, reply.stderr).toBe(1)
      expect(JSON.parse(reply.stderr).error.code).toBe('CLI_ROUTE_PROBE')
    }
    expect(fixture.requests.map(request => request.params)).toEqual([
      { operationId: 'M1', target: { kind: 'agent-session', agentSessionId: 'constructor' }, text: '--help' },
      { id: '--help' }, { key: 'client.label', value: '--help' }, { input: { scheme: '' } }, { target: { operationId: 'O1' } },
      { operationId: 'OPEN', content: { kind: 'new-agent', executorId: 'E', prompt: '--help' }, destination: {
        spaceId: 'S', newTab: true, newZone: { kind: 'directory', projectId: 'P', sourceWorkspaceId: 'W', path: ' ' + fixturePath("literal directory") + ' ' }
      }, focus: false }, { id: '--help', input: { changes: { name: 'raw' }, expected: { name: 'before' } } }
    ])
    const taskArgs = ['browser', 'task', 'run', '--browser', '--help', '--asset', 'constructor', '--version', '2', '--step', '--run', '--help']
    const task = await fixture.run(taskArgs, '{"fresh":"literal $VALUE"}')
    expect(task.code).toBe(1)
    expect(JSON.parse(task.stderr).error.code).toBe('CLI_ROUTE_PROBE')
    expect(fixture.requests.at(-1)).toMatchObject({ method: 'browser.task.run', params: {
      browserId: '--help', assetId: 'constructor', version: 2, mode: 'step', runId: '--help', parameters: { fresh: 'literal $VALUE' }
    } })
    const requestCount = fixture.requests.length
    for (const stdin of ['{invalid', '{"fresh":"' + 'x'.repeat(65_536) + '"}']) {
      const rejected = await fixture.run(taskArgs, stdin)
      expect(rejected.code).toBe(1)
      expect(JSON.parse(rejected.stderr).error.code).toBe('INVALID_CLI_ARGUMENT')
    }
    expect(fixture.requests).toHaveLength(requestCount)
  })

  it('rejects removed aliases, duplicate/extra/mutually exclusive flags before contacting a service', async () => {
    const fixture = await probe()
    const invalid = [
      ['pmo', 'snapshot'], ['list', 'sessions'], ['demand', 'list'], ['inspect', '--session', 'SID'],
      ['open', 'file'], ['send', '--to-session', 'SID', '--text', 'x'], ['focus', '--surface', 'space'],
      ['roles', 'list'], ['settings', 'get'], ['settings', 'prompts', 'add', 'X'], ['toolkit', 'add', 'X'],
      ['agent', 'view', '--session', 'SID', '--request-id', 'OLD'],
      ['browser', 'operation', '--operation', 'OLD'],
      ['agent', 'open', '--executor', 'E', '--session', 'SID', '--zone', 'Z'],
      ['agent', 'open', '--executor', 'E', '--new-zone', '--directory', 'D', '--space', 'S'],
      ['agent', 'open', '--executor', 'E', '--zone', 'Z', '--project', 'P'],
      ['agent', 'rename', '--session', 'SID', '--clear', '--name', 'X'],
      ['agent', 'send', '--to-session', 'SID', '--text', 'x', '--text', 'y'],
      ['app', 'snapshot', '--bogus', 'x'], ['whoami', 'extra']
    ]
    expect(invalid.length).toBeGreaterThan(0)
    for (const args of invalid) {
      const result = await fixture.run(args)
      expect(result.code, args.join(' ')).toBe(1)
      expect(result.stdout).toBe('')
      expect(JSON.parse(result.stderr).error.code).toBe('INVALID_CLI_ARGUMENT')
    }
    expect(fixture.requests).toEqual([])
  })

  it('preserves authoritative typed error codes, unknown facts and candidate data', async () => {
    const candidates = [{ agentSessionId: 'A', regionIds: ['R1'] }, { agentSessionId: 'B', regionIds: ['R2'] }]
    const fixture = await probe(request => {
      if (request.method === 'agent.send') throw Object.assign(new Error('Target is ambiguous.'), { code: 'MESSAGE_TARGET_NOT_UNIQUE', candidates, details: { availability: 'unknown' } })
      return { agentSessionId: 'SID', changed: true, outcome: 'partial', override: 'Applied', save: {
        layoutApplied: true, localStorageWritten: false, storageFlushRequested: false, diskDurability: 'unconfirmed', reason: 'Private save failed.'
      } }
    })
    const error = await fixture.run(['agent', 'send', '--to-tab', 'TAB', '--text', 'x'])
    expect(error.code).toBe(1)
    expect(JSON.parse(error.stderr)).toMatchObject({ operation: 'agent.send', error: {
      code: 'MESSAGE_TARGET_NOT_UNIQUE', message: 'Target is ambiguous.', candidates, details: { availability: 'unknown' }
    } })
    const partial = await fixture.run(['agent', 'rename', '--session', 'SID', '--name', 'Applied'])
    expect(partial.code).toBe(1)
    expect(JSON.parse(partial.stdout)).toMatchObject({ ok: true, operation: 'agent.rename', result: {
      outcome: 'partial', override: 'Applied', save: { storageFlushRequested: false, diskDurability: 'unconfirmed' }
    } })
  })

  it('keeps an uncertain device mutation as one request and reads current facts without certifying the lost reply', async () => {
    const fixture = await probe(request => {
      if (request.method === 'device.revoke') throw Object.assign(new Error('Device mutation outcome is unconfirmed.'), { code: 'CONTROL_TIMEOUT' })
      return { hostId: 'original-host', devices: [{ deviceId: 'DEVICE', name: 'Original device', createdAt: 1 }], mobileAccess: { state: 'unavailable', message: 'Controlled fixture has no Host getter.' } }
    })
    const mutation = await fixture.run(['device', 'revoke', '--device', 'DEVICE'])
    expect(mutation.code).toBe(1)
    expect(JSON.parse(mutation.stderr)).toMatchObject({ operation: 'device.revoke', error: { code: 'CONTROL_TIMEOUT' } })
    expect(fixture.requests.map(request => [request.method, request.params])).toEqual([
      ['device.revoke', { deviceId: 'DEVICE' }]
    ])
    const current = await fixture.run(['device', 'ls'])
    expect(current.code, current.stderr).toBe(0)
    expect(JSON.parse(current.stdout)).toEqual({ ok: true, operation: 'device.ls', result: {
      hostId: 'original-host', devices: [{ deviceId: 'DEVICE', name: 'Original device', createdAt: 1 }], mobileAccess: { state: 'unavailable', message: 'Controlled fixture has no Host getter.' }
    } })
    expect(fixture.requests.map(request => request.method)).toEqual(['device.revoke', 'device.ls'])
  })

  it('renders the PMO manual without a service request or user material change', async () => {
    const fixture = await probe(() => { throw new Error('A manual must not invoke business.') })
    const soul = join(fixture.root, 'SOUL.md'), wiki = join(fixture.root, 'Wiki.md')
    await writeFile(soul, 'user soul\n'); await writeFile(wiki, 'user wiki\n')
    const result = await fixture.run(['mote', 'playbook', 'pmo'])
    expect(result.code).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({ operation: 'mote.playbook.pmo', result: { readOnly: true, format: 'markdown' } })
    const document = JSON.parse(result.stdout).result.document
    expect(document).toContain('PMO is a coordination role and working method')
    expect(document).toContain('agentmux app snapshot')
    expect(document).toContain('agentmux agent open')
    expect(document).toContain('space inspect --operation-id')
    expect(fixture.requests).toEqual([])
    expect(await readFile(soul, 'utf8')).toBe('user soul\n')
    expect(await readFile(wiki, 'utf8')).toBe('user wiki\n')
  })

  it('prints the original response then full notifications, preserving bytes/cursors and reader-only cancellation', async () => {
    const streamEntries = AGENTMUX_CLI_COMMANDS.filter(entry => entry.stream || entry.method === 'agent.output')
    expect(streamEntries.map(entry => entry.method)).toEqual(['agent.output', 'browser.follow', 'system.metrics.watch', 'toolkit.watch'])
    const raw = Uint8Array.from([0xe4, 0xb8, 0xad, 0x00, 0xff])
    const pending = { state: 'pending', observedAt: null, lastSuccessAt: null, reason: null, data: null }
    const observation = { schema: 'agentmux.metrics.v1', observedAt: 1,
      scope: { kind: 'unix-host', hostId: 'local', hostname: 'private-host', mainPid: 1 }, window: null,
      units: { cpu: 'percent', cpuBasis: 'one-logical-core', rss: 'KiB', storage: 'bytes', cpuAggregate: '10s-reading-peak', rssAggregate: 'latest' },
      diagnostics: pending, process: pending, app: pending, runtime: pending, main: pending, renderer: pending }
    const tool = { schema: 'agentmux.toolkit.v1', kind: 'script', toolId: 'TOOL',
      definition: { id: 'TOOL', revision: 'r', name: 'Fixture', icon: 'terminal', enabled: true,
        statusBar: 'icon', workspacePath: fixturePath("fixture"), script: "console.log('fixture')", args: [], actions: [] },
      state: 'idle', reason: null, admission: null, latestConfirmed: null, consumerCount: 0, sequence: 1 }
    for (const entry of streamEntries) for (const followed of entry.method === 'agent.output' ? [false, true] : [false]) {
      const initial = entry.method === 'agent.output'
        ? { session: { kind: 'agent', agentSessionId: 'SID', providerId: 'codex', executorId: 'codex', hostId: 'local', workspacePath: fixturePath("fixture"),
          run: { runId: 'RUN' }, retiredRuns: [], createdAt: 1, updatedAt: 1 }, run: { runId: 'RUN', state: 'running', latestOutputBytes: 10 },
          terminal: { type: 'not-requested' }, resizeRevision: 0, gap: { requestedAfterByte: 0, firstAvailableByte: 5 } }
        : entry.method === 'browser.follow' ? { runOperation: null, gap: { droppedThrough: 3 } }
        : entry.method === 'toolkit.watch' ? { toolId: 'TOOL' } : { observation }
      const data = entry.method === 'agent.output'
        ? { runId: 'RUN', replay: !followed, startByte: 5, endByte: 10, dataBase64: Buffer.from(raw).toString('base64') }
        : entry.method === 'browser.follow' ? { sequence: 4, event: { kind: 'fixture' } }
        : entry.method === 'toolkit.watch' ? tool : observation
      const fixture = await probe((request, socket) => {
        setTimeout(() => {
          for (const [index, event] of [
            { type: entry.method === 'agent.output' ? 'output' : entry.method === 'browser.follow' ? 'progress' : 'snapshot', data },
            { type: 'end', data: { reason: 'reader-ended' } }
          ].entries()) socket.write(JSON.stringify({ jsonrpc: '2.0', method: 'system.subscription.event', params: {
            subscriptionId: 'SUB', method: entry.method, sequence: index + 1, event
          } }) + '\n')
        }, 20)
        return { subscriptionId: 'SUB', method: entry.method, initial }
      })
      const args = [...entry.method.split('.'), ...objectCliSeed(entry.method, fixture.inputPath), ...(followed ? ['--follow'] : [])]
      const result = await fixture.run(args)
      expect(result.code, entry.method + ': ' + result.stderr).toBe(0)
      const frames = result.stdout.trim().split('\n').map(line => JSON.parse(line))
      expect(frames).toHaveLength(3)
      expect(frames[0]).toEqual({ jsonrpc: '2.0', id: fixture.requests[0]!.id,
        result: { subscriptionId: 'SUB', method: entry.method, initial } })
      expect(frames.slice(1).map(frame => frame.params.sequence)).toEqual([1, 2])
      expect(frames[1].params.event.data).toEqual(data)
      if (entry.method === 'agent.output') {
        expect([...Buffer.from(frames[1].params.event.data.dataBase64, 'base64')]).toEqual([...raw])
        expect(fixture.requests[0]!.params.follow).toBe(followed)
      }
      expect(fixture.requests.map(request => request.method)).toEqual([entry.method])
    }
  }, 30_000)
})
