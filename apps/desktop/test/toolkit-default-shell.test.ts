import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ToolkitReceiptStore } from '../src/main/toolkit-receipt-store.js'
import { CustomToolkitOwner } from '../src/main/toolkit-custom-owner.js'
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AgentMuxClient,
  AgentMuxMemoryAgentSessionStore,
  parsePreparedTerminal,
} from '@agentmux/core'
import {
  AGENTMUX_CONTROL_SCHEMA_VERSION,
  parseToolkitToolFields,
} from '@agentmux/core/control'
import { AgentMuxHostedRuntimeService } from '../../../packages/core/src/hosted-runtime-service.js'
import { hostedTestFence } from '../../../packages/core/test/helpers/hosted-runtime-port.js'
import { decodeHostedValue } from '../../../packages/core/src/hosted-value.js'
import { agentMuxCommandHelp } from '../../../packages/core/src/agentmux-cli-help.js'
import { ConfigOwner } from '../src/main/config-owner.js'
import { DEFAULT_CONFIG } from '../src/main/config-store.js'
import {
  executeToolkitConfig,
  prepareToolkitConfig,
} from '../src/main/toolkit-config.js'
import type { AppConfig } from '../src/shared/contracts.js'
import { fixturePath } from '../scripts/lib/fixture-values.mjs'

vi.mock('electron', () => ({
  app: { getPath: () => process.cwd(), getAppPath: () => process.cwd() },
}))
afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})
const fields = {
  name: 'Default shell',
  icon: 'terminal',
  enabled: false,
  statusBar: 'icon' as const,
  workspacePath: fixturePath('workspace'),
  script: '',
  args: [],
}

describe('Toolkit blank command syntax and merged configuration', () => {
  it.each(['', ' \n\t '])(
    'accepts blank TUI command %j while keeping finite programs nonempty',
    (script) => {
      expect(() =>
        parseToolkitToolFields({ ...fields, mode: 'tui', script }),
      ).not.toThrow()
      expect(
        parseToolkitToolFields({ ...fields, mode: 'tui', script }),
      ).toMatchObject({ script, mode: 'tui' })
      expect(parseToolkitToolFields({ script }, true)).toEqual({ script })
      expect(() => parseToolkitToolFields({ ...fields, script })).toThrow()
      expect(() =>
        parseToolkitToolFields({ ...fields, mode: 'script', script }),
      ).toThrow()
      expect(() =>
        parseToolkitToolFields({
          ...fields,
          script: 'void 0',
          display: { script, args: [] },
        }),
      ).toThrow()
      expect(() =>
        parseToolkitToolFields({
          ...fields,
          script: 'void 0',
          actions: [{ id: 'a', label: 'A', script, args: [] }],
        }),
      ).toThrow()
    },
  )

  it('retains the NUL and byte limits for blank-command TUI definitions', () => {
    expect(() =>
      parseToolkitToolFields({ ...fields, mode: 'tui', script: '\0' }),
    ).toThrow()
    expect(() =>
      parseToolkitToolFields({
        ...fields,
        mode: 'tui',
        script: ' '.repeat(100_000),
      }),
    ).toThrow()
  })

  it('validates empty partial edits after merging the original mode and preserves invalid drafts on disk', async () => {
    let config: AppConfig = {
      ...structuredClone(DEFAULT_CONFIG),
      toolkit: {
        tools: [
          {
            ...fields,
            id: 'shell',
            revision: 'original',
            script: 'console.log("ready")',
          },
        ],
      },
    }
    const save = vi.fn(async (next: AppConfig) => structuredClone(next))
    const owner = new ConfigOwner({
      read: () => config,
      save,
      publish: (next) => {
        config = next
      },
      prepare: (current, next) =>
        prepareToolkitConfig(current, next, async () => {}),
    })
    const base = {
      schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION,
      requestId: 'blank-command',
      toolId: 'shell',
      operation: 'toolkit.update' as const,
    }
    await expect(
      executeToolkitConfig({ ...base, changes: { script: '' } }, owner),
    ).rejects.toMatchObject({ code: 'INVALID_SETTING_VALUE' })
    expect(save).not.toHaveBeenCalled()
    expect(
      await executeToolkitConfig(
        { ...base, changes: { mode: 'tui', script: '' } },
        owner,
      ),
    ).toMatchObject({ changed: true, definition: { mode: 'tui', script: '' } })
    const captured = structuredClone(config)
    await expect(
      executeToolkitConfig({ ...base, changes: { mode: 'script' } }, owner),
    ).rejects.toMatchObject({ code: 'INVALID_SETTING_VALUE' })
    expect(config).toEqual(captured)
    expect(
      await executeToolkitConfig(
        { ...base, changes: { script: ' \n ' }, expected: { script: '' } },
        owner,
      ),
    ).toMatchObject({
      changed: true,
      definition: { mode: 'tui', script: ' \n ' },
    })
  })

  it('explains the blank command and captured default in the existing Toolkit help consumer', () => {
    const help = agentMuxCommandHelp('toolkit')!
    expect(help).toContain("execution Host's default interactive shell")
    expect(help).toContain('args pass directly to that shell')
    expect(help).toContain(
      'prepares the complete launch request before creation',
    )
    expect(help).toContain('shell -lc')
  })
})

describe('Core terminal preparation', () => {
  it('captures the Host shell and complete request once, then replays without current environment merging', async () => {
    const client = new AgentMuxClient({
      store: new AgentMuxMemoryAgentSessionStore(),
      providers: [],
    })
    const inner = client as unknown as {
      connected: boolean
      kernel: {
        isConnected(): boolean
        startPrepared(request: unknown, key: string): Promise<unknown>
      }
    }
    vi.stubEnv('SHELL', '/bin/bash')
    vi.stubEnv('PRIVATE_HOST_MARKER', 'original')
    const input = {
      createOperationId: 'original-operation',
      workspacePath: fields.workspacePath,
      args: ['-i'],
    }
    const original = await client.prepareTerminal(input)
    const request = JSON.parse(original.launch).request
    expect(original.createOperationId).toBe(input.createOperationId)
    expect(original.workspacePath).toBe(input.workspacePath)
    expect(request).toMatchObject({
      program: '/usr/bin/env',
      cwd: input.workspacePath,
      env: { SHELL: '/bin/bash', PRIVATE_HOST_MARKER: 'original' },
      initial_size: { cols: 80, rows: 24 },
      declared_inputs: [],
    })
    expect(request.args.slice(-2)).toEqual(['/bin/bash', '-i'])
    vi.stubEnv('SHELL', '/bin/zsh')
    vi.stubEnv('PRIVATE_HOST_MARKER', 'changed')
    inner.connected = true
    vi.spyOn(inner.kernel, 'isConnected').mockReturnValue(true)
    const unavailable = new Error(
      'Private Native collaborator stops after observing the actual launch request',
    )
    const start = vi
      .spyOn(inner.kernel, 'startPrepared')
      .mockRejectedValue(unavailable)
    await expect(client.createPreparedTerminal(original)).rejects.toBe(
      unavailable,
    )
    expect(
      createHash('sha256')
        .update(JSON.stringify(start.mock.calls[0]![0]))
        .digest('hex'),
    ).toBe(createHash('sha256').update(JSON.stringify(request)).digest('hex'))
    expect(start.mock.calls[0]![1]).toBe(original.createOperationId)
    const prepare = vi.spyOn(client, 'prepareTerminal')
    await expect(client.createTerminal(input)).rejects.toBe(unavailable)
    expect(prepare).toHaveBeenCalledExactlyOnceWith(input)
    expect(start.mock.calls[1]![0]).toMatchObject({
      env: { SHELL: '/bin/zsh', PRIVATE_HOST_MARKER: 'changed' },
    })
    vi.stubEnv('SHELL', undefined)
    expect(
      JSON.parse((await client.prepareTerminal(input)).launch).request.args.slice(-2),
    ).toEqual(['/bin/sh', '-i'])
    expect(
      JSON.parse(
        (await client.prepareTerminal({ ...input, command: '/bin/false' })).launch,
      ).request.args.slice(-2),
    ).toEqual(['/bin/false', '-i'])
    vi.restoreAllMocks()
    inner.connected = false
    await client.dispose()
  })

  it('delegates preparation to the exact Host without connecting Native or recovering Sessions', async () => {
    const client = new AgentMuxClient({
      store: new AgentMuxMemoryAgentSessionStore(),
      providers: [],
    })
    const connect = vi.spyOn(client, 'connect'),
      runtime = vi.spyOn(client, 'connectRuntime')
    const service = new AgentMuxHostedRuntimeService(client, null, () => ({
      ...hostedTestFence,
      protocolVersion: 2,
      processId: process.pid,
      availability: 'connected',
      ctxmux: null,
    }))
    vi.stubEnv('SHELL', '/bin/bash')
    try {
      const result = (await service.call('runtime.invoke', {
        fence: hostedTestFence,
        consumerId: 'default-reader',
        invocation: {
          method: 'prepareTerminal',
          args: [
            {
              createOperationId: 'host-operation',
              workspacePath: fields.workspacePath,
            },
          ],
        },
      })) as { value: unknown }
      const prepared = parsePreparedTerminal(decodeHostedValue(result.value))
      expect(JSON.parse(prepared.launch).request.args.at(-1)).toBe('/bin/bash')
      expect(JSON.parse(prepared.launch).request.env.SHELL).toBe('/bin/bash')
      expect(connect).not.toHaveBeenCalled()
      expect(runtime).not.toHaveBeenCalled()
    } finally {
      await service.dispose()
      await client.dispose()
    }
  })

  it('rejects incomplete or non-data preparation without echoing its sensitive values', async () => {
    const client = new AgentMuxClient({
      store: new AgentMuxMemoryAgentSessionStore(),
      providers: [],
    })
    const valid = await client.prepareTerminal({
      workspacePath: fields.workspacePath,
    })
    const request = JSON.parse(valid.launch).request
    const packed = (request: unknown) => ({
      ...valid,
      launch: JSON.stringify({
        createOperationId: valid.createOperationId,
        request,
      }),
    })
    const cases: unknown[] = [
      null,
      {},
      { ...valid, extra: 'sensitive-value' },
      { ...valid, launch: 'invalid-sensitive-json' },
      { ...valid, createOperationId: 'different-operation' },
      { ...valid, workspacePath: fixturePath('another-directory') },
    ]
    for (const field of Object.keys(request)) {
      const incomplete = { ...request }
      delete incomplete[field]
      cases.push(packed(incomplete))
    }
    cases.push(
      packed({ ...request, args: [undefined] }),
      packed({ ...request, env: { INVALID: 'sensitive-value\0' } }),
      packed({ ...request, initial_size: { cols: 0, rows: 24 } }),
      packed({ ...request, declared_inputs: [{ arbitrary: true }] }),
    )
    for (const value of cases) {
      expect(() => parsePreparedTerminal(value)).toThrow()
      await expect(
        client.createPreparedTerminal(value as any),
      ).rejects.toMatchObject({ code: 'INVALID_TERMINAL_PREPARATION' })
    }
    try {
      parsePreparedTerminal({
        ...valid,
        launch: '{"SYNTHETIC_PRIVATE_LAUNCH":unquoted}',
      })
      expect.fail('Malformed launch must be rejected')
    } catch (error) {
      expect(error).toMatchObject({
        code: 'INVALID_TERMINAL_PREPARATION',
        message:
          'The original terminal preparation is invalid; its creation remains unconfirmed.',
      })
      expect(String(error)).not.toContain('SYNTHETIC_')
    }
    const parsed = parsePreparedTerminal(valid)
    expect(parsed).toEqual(valid)
    expect(parsed).not.toBe(valid)
    await client.dispose()
  })
})

it('keeps malformed private preparation out of the public Toolkit error and preserves its file', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'toolkit-private-receipt-'))
  const file = join(directory, 'receipts.json')
  const secret = 'SYNTHETIC_PRIVATE_LAUNCH'
  const malformed =
    '{"schema":"agentmux.toolkit.receipts.v1","tools":{"shell":{"launch":' +
    secret +
    '}}}'
  const config = {
    ...structuredClone(DEFAULT_CONFIG),
    toolkit: {
      tools: [
        { ...fields, id: 'shell', revision: 'original', mode: 'tui' as const },
      ],
    },
  }
  const openRunPort = vi.fn(async (): Promise<never> => {
    throw new Error('Private malformed receipt must not launch')
  })
  const owner = new CustomToolkitOwner({
    config: new ConfigOwner({
      read: () => config,
      save: async (next) => next,
      publish: () => {},
    }),
    receipts: new ToolkitReceiptStore(file, () => ['shell']),
    openRunPort,
    runner: process.execPath,
    env: {},
  })
  try {
    await writeFile(file, malformed, { mode: 0o600 })
    const snapshot = await owner.get('shell')
    expect(JSON.stringify(snapshot)).not.toContain('SYNTHETIC_')
    expect(snapshot).toMatchObject({
      state: 'unknown',
      reason: expect.stringContaining('Toolkit receipt storage is invalid'),
    })
    expect(JSON.stringify(snapshot)).not.toContain(secret)
    expect(await readFile(file, 'utf8')).toBe(malformed)
    expect(openRunPort).not.toHaveBeenCalled()
  } finally {
    await owner.dispose()
    await rm(directory, { recursive: true })
  }
})
