import { win32 } from 'node:path'
import { fixturePath } from './helpers/fixture-values.js'
import { describe, expect, it } from 'vitest'
import { AGENTMUX_CONTROL_SCHEMA_VERSION } from '../src/control.js'
import { parseToolkitCommand } from '../src/toolkit-cli.js'
import { AGENTMUX_CLI_COMMANDS, parseAgentMuxCliInvocation } from '../src/agentmux-cli-commands.js'
import { agentMuxCommandHelp, AGENTMUX_CLI_SKILL } from '../src/agentmux-cli-help.js'
import { isAgentMuxRpcMethod } from '../src/public-rpc.js'
import { rpcControlRequest, parseRpcControlResult } from '../src/rpc-business-codec.js'
import { parseAgentMuxControlReceipt } from '../src/control-codec.js'
import { settingsResourceRecord } from '../src/settings-resource-json.js'
import { assertToolkitResultTarget, parseToolkitPackageManifest, parseToolkitPackageConfiguration,
  parseToolkitToolConfiguration, parseToolkitToolDefinition, parseToolkitRequest, parseToolkitResult,
  parseToolkitSnapshot, type ToolkitPackageConfiguration, type ToolkitToolDefinition,
  type ToolkitScriptSnapshot } from '../src/toolkit.js'

const fields = { kind: 'package' as const, packagePath: fixturePath("packages/report"), enabled: true,
  statusBar: 'icon' as const, args: ['--target', 'current'], workspacePath: fixturePath("workspace") }
const configuration: ToolkitPackageConfiguration = { ...fields, id: 'report', revision: 'configuration-one' }
const source = { path: fields.packagePath, configRevision: configuration.revision, contentSHA256: 'a'.repeat(64),
  entry: 'scripts/main.mjs', actionEntries: [{ id: 'refresh', entry: 'scripts/refresh.mjs' }] }
const definition: ToolkitToolDefinition = { id: configuration.id, revision: 'effective-one', name: 'Report',
  icon: 'terminal', enabled: fields.enabled, statusBar: fields.statusBar, workspacePath: fields.workspacePath,
  args: fields.args, script: "import './helper.mjs'", actions: [{ id: 'refresh', label: 'Refresh', script: "console.log('refresh')", args: ['--refresh'] }], package: source }
const snapshot: ToolkitScriptSnapshot = { schema: 'agentmux.toolkit.v1', kind: 'script', toolId: configuration.id,
  definition, state: 'running', reason: null, admission: { executionId: 'original-execution', invocationId: 'original-invocation',
    definition, expectedLatestExecutionId: null, target: { workspacePath: fields.workspacePath }, run: { hostId: 'local', runId: 'original-run' },
    startedAt: 1, text: 'retained output', state: 'running', reason: null }, latestConfirmed: null, consumerCount: 1, sequence: 2 }
const unavailable = { schema: 'agentmux.toolkit.v1', kind: 'package-unavailable', toolId: configuration.id,
  configuration, reason: 'TOOLKIT_PACKAGE_UNAVAILABLE: manifest.json is missing.', retained: snapshot }
const envelope = { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: 'exact-request' }

describe('Toolkit local package data and original public command', () => {
  it('saves only a package reference and preferences and keeps resolved source out of durable records', () => {
    expect(parseToolkitPackageConfiguration(configuration)).toEqual(configuration)
    expect(parseToolkitToolConfiguration(configuration)).toEqual(configuration)
    expect(parseToolkitToolDefinition(definition)).toEqual(definition)
    const { package: _package, ...inline } = definition
    expect(parseToolkitToolConfiguration(inline)).toEqual(inline)
    expect(() => parseToolkitToolConfiguration(definition)).toThrow()
    expect(() => parseToolkitPackageConfiguration({ ...configuration, script: definition.script })).toThrow()
    expect(() => parseToolkitPackageConfiguration({ ...configuration, name: definition.name })).toThrow()
    expect(() => parseToolkitPackageConfiguration({ ...configuration, kind: 'inline' })).toThrow()
    expect(() => parseToolkitPackageConfiguration({ ...configuration, args: ['bad\0arg'] })).toThrow()
    expect(() => parseToolkitPackageConfiguration({ ...configuration, args: Array.from({ length: 32 }, () => 'a'.repeat(4096)) })).toThrow()
  })
  it('strictly extends original create/update/delete carriers without weakening complete expected fields', () => {
    const value = { ...fields }; delete (value as Partial<typeof fields>).workspacePath
    expect(() => parseToolkitRequest({ ...envelope, operation: 'toolkit.add', toolId: configuration.id, value })).not.toThrow()
    expect(parseToolkitRequest({ ...envelope, operation: 'toolkit.add', toolId: configuration.id, value })).toMatchObject({ value })
    expect(rpcControlRequest('toolkit.create', { toolId: configuration.id, value })).toMatchObject({ operation: 'toolkit.add', value })
    expect(rpcControlRequest('toolkit.update', { toolId: configuration.id, input: {
      changes: { args: ['next'], packagePath: fixturePath("packages/next") }, expected: { args: fields.args, packagePath: fields.packagePath }
    } })).toMatchObject({ operation: 'toolkit.update', changes: { packagePath: fixturePath("packages/next") } })
    expect(() => rpcControlRequest('toolkit.update', { toolId: configuration.id,
      input: { changes: { packagePath: fixturePath("next") }, expected: { enabled: true } } })).toThrow()
    expect(() => rpcControlRequest('toolkit.update', { toolId: configuration.id,
      input: { changes: { packagePath: fixturePath("next"), script: 'forbidden' } } })).toThrow()
    expect(rpcControlRequest('toolkit.delete', { toolId: configuration.id, input: { expected: fields } })).toMatchObject({ expected: fields })
    expect(() => rpcControlRequest('toolkit.delete', { toolId: configuration.id, input: { expected: value } })).toThrow()
    const result = parseToolkitResult('toolkit.add', { definition: configuration, changed: true })
    expect(result).toEqual({ operation: 'toolkit.add', definition: configuration, changed: true })
    expect(() => assertToolkitResultTarget({ operation: 'toolkit.add', toolId: 'other' }, result)).toThrow()
  })
  it('normalizes an optional manifest/action argument list and rejects ambiguous or escaping entries', () => {
    const manifest = { schema: 'agentmux.toolkit.package.v1', name: 'Report', icon: 'terminal', entry: source.entry }
    expect(parseToolkitPackageManifest(manifest)).toEqual({ ...manifest, actions: [] })
    const action = { id: 'refresh', label: 'Refresh', entry: 'scripts/refresh.mjs' }
    expect(parseToolkitPackageManifest({ ...manifest, actions: [action] })).toMatchObject({ actions: [{ ...action, args: [] }] })
    for (const entry of [fixturePath("outside.mjs"), (".." + (fixturePath("outside.mjs"))), ("nested/.." + (fixturePath("outside.mjs"))), './main.mjs', 'nested//main.mjs', win32.resolve('C:', 'main.mjs')]) {
      expect(() => parseToolkitPackageManifest({ ...manifest, entry })).toThrow()
    }
    expect(() => parseToolkitPackageManifest({ ...manifest, actions: [action, action] })).toThrow()
    expect(() => parseToolkitPackageManifest({ ...manifest, actions: Array.from({ length: 17 }, (_, i) => ({ ...action, id: String(i) })) })).toThrow()
    expect(() => parseToolkitPackageManifest({ ...manifest, actions: [{ ...action, script: 'forbidden' }] })).toThrow()
    expect(() => parseToolkitPackageManifest({ ...manifest, name: 'a'.repeat(257) })).toThrow()
    expect(() => parseToolkitToolDefinition({ ...definition, package: { ...source, actionEntries: [] } })).toThrow()
    expect(() => parseToolkitToolDefinition({ ...definition, package: { ...source, contentSHA256: 'not-a-hash' } })).toThrow()
    expect(() => parseToolkitToolDefinition({ ...definition, package: { ...source, actionEntries: [{ id: 'other', entry: 'scripts/refresh.mjs' }] } } )).toThrow()
  })
  it('retains original execution facts when current package source cannot be read', () => {
    expect(parseToolkitSnapshot(unavailable)).toEqual(unavailable)
    expect(parseToolkitResult('toolkit.get', { snapshot: unavailable })).toEqual({ operation: 'toolkit.get', snapshot: unavailable })
    expect(parseToolkitSnapshot({ ...unavailable, retained: null })).toMatchObject({ retained: null, configuration })
    expect(() => parseToolkitSnapshot({ ...unavailable, toolId: 'other' })).toThrow()
    expect(() => parseToolkitSnapshot({ ...unavailable, reason: '' })).toThrow()
    expect(() => parseToolkitSnapshot({ ...unavailable, retained: { ...snapshot, toolId: 'other', definition: { ...definition, id: 'other' } } })).toThrow()
    expect(() => parseToolkitSnapshot({ ...unavailable, retained: { ...unavailable, retained: null } })).toThrow()
    expect(() => parseToolkitSnapshot({ ...unavailable, configuration: { ...configuration, script: 'fake-source' } })).toThrow()
  })
  it('carries retained package actions through the complete public receipt without widening arbitrary JSON', () => {
    const retained = { ...snapshot, latestConfirmed: { ...snapshot.admission!, executionId: 'previous-execution',
      invocationId: 'previous-invocation', state: 'succeeded', endedAt: 2, exitCode: 0 } }
    const result = { snapshot: { ...unavailable, retained } }
    const receipt = { ...envelope, operation: 'toolkit.get', ok: true, result }
    // This exact typed payload is deeper only because the public receipt wraps retained executions.
    expect(() => settingsResourceRecord(receipt, 'CONTROL_PROTOCOL_ERROR')).toThrow()
    expect(() => parseToolkitSnapshot(result.snapshot)).not.toThrow()
    expect(() => parseAgentMuxControlReceipt(receipt)).not.toThrow()
    expect(parseAgentMuxControlReceipt(receipt)).toEqual(receipt)
    expect(() => parseRpcControlResult('toolkit.inspect', result, { toolId: configuration.id })).not.toThrow()
    expect(parseRpcControlResult('toolkit.inspect', result, { toolId: configuration.id })).toEqual(result)
    const accessor = Object.defineProperty({ ...source.actionEntries[0] }, 'entry', { enumerable: true,
      get: () => { throw new Error('must not read a nested package accessor') } })
    const invalidDefinition = { ...definition, package: { ...source, actionEntries: [accessor] } }
    const bad = { ...receipt, result: { snapshot: { ...result.snapshot, retained: { ...retained,
      admission: { ...retained.admission, definition: invalidDefinition } } } } }
    expect(() => parseAgentMuxControlReceipt(bad)).toThrowError('Settings resource JSON is invalid or exceeds its budget.')
    expect(() => parseAgentMuxControlReceipt({ ...receipt, unexpected: {} })).toThrow()
    const cyclic = { ...result.snapshot }; cyclic.retained = cyclic as unknown as typeof cyclic.retained
    expect(() => parseAgentMuxControlReceipt({ ...receipt, result: { snapshot: cyclic } })).toThrow()
  })
  it('discovers package metadata independently of an effective executable revision', () => {
    const builtin = { kind: 'metrics', toolId: 'performance', name: 'Performance', readonly: true }
    const descriptor = { kind: 'package', toolId: configuration.id, readonly: false, configRevision: configuration.revision,
      path: fields.packagePath, enabled: true, statusBar: 'icon', name: 'Report', icon: 'terminal', availability: 'available', reason: null }
    expect(parseToolkitResult('toolkit.list', { tools: [builtin, descriptor] })).toMatchObject({ tools: [builtin, descriptor] })
    const missing = { ...descriptor, name: null, icon: null, availability: 'unavailable', reason: unavailable.reason }
    expect(parseToolkitResult('toolkit.list', { tools: [builtin, missing] })).toMatchObject({ tools: [builtin, missing] })
    expect(() => parseToolkitResult('toolkit.list', { tools: [builtin, { ...descriptor, revision: 'pretend-effective' }] })).toThrow()
    expect(() => parseToolkitResult('toolkit.list', { tools: [builtin, { ...missing, reason: null }] })).toThrow()
    expect(() => parseToolkitResult('toolkit.list', { tools: [builtin, { ...descriptor, name: null }] })).toThrow()
  })
  it('registers install as a local-directory carrier for the same public create method', async () => {
    const command = await parseToolkitCommand(['install', configuration.id, '--path', fields.packagePath, '--cwd', fields.workspacePath])
    expect(command).toEqual({ method: 'toolkit.create', params: { toolId: configuration.id,
      value: { ...fields, args: [] } } })
    const parsed = await parseAgentMuxCliInvocation(['--endpoint', ("unix:" + (fixturePath("private/fixture.sock"))), 'toolkit', 'install', configuration.id, `--path=${fields.packagePath}`])
    expect(parsed.command.method).toBe('toolkit.create')
    expect(parsed.params).toEqual({ toolId: configuration.id, value: { kind: 'package', packagePath: fields.packagePath,
      enabled: true, statusBar: 'icon', args: [] } })
    expect(parsed.endpoint).toBe(("unix:" + (fixturePath("private/fixture.sock"))))
    expect(AGENTMUX_CLI_COMMANDS.find(command => command.method === 'toolkit.install')?.rpcMethod).toBe('toolkit.create')
    expect(isAgentMuxRpcMethod('toolkit.install')).toBe(false)
    expect(agentMuxCommandHelp('toolkit.install')).toContain('--path <absolute-directory>')
    expect(AGENTMUX_CLI_SKILL).toContain('next explicit')
    for (const args of [[], ['--path', 'relative'], ['--path', fields.packagePath, '--path', fixturePath("duplicate")], ['--path', fields.packagePath, '--cwd', 'relative'], ['--input', fixturePath("a.json")]]) {
      await expect(parseToolkitCommand(['install', configuration.id, ...args])).rejects.toMatchObject({ code: 'INVALID_CLI_ARGUMENT' })
    }
  })
})
