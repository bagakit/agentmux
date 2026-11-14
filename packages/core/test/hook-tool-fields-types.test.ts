import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import ts from 'typescript'
import { expect, it } from 'vitest'

it('requires a Provider owner when consuming public native tool fields in the Node SDK', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'amx-hook-tool-fields-types-'))
  try {
    const consumer = join(directory, 'consumer.mts')
    await writeFile(consumer, `import * as core from '@agentmux/core'
const specification: core.AgentNativeHookSpecification = {
  rules: [],
  toolFields(eventName, raw) {
    if (eventName !== 'OwnTool') return {}
    return { toolName: 'OwnTool', toolInput: raw.arguments,
      ...(typeof raw.originalId === 'string' ? { reportedToolCallId: raw.originalId } : {}) }
  }
}
const fields: core.AgentNativeHookToolFields = core.projectNativeHookToolFields(
  specification, 'OwnTool', { arguments: null, originalId: 'original-call' })
const empty: core.AgentNativeHookToolFields = { toolInput: '' }
const absent: core.AgentNativeHookToolFields = {}
const input: unknown = fields.toolInput
const reported: string | undefined = fields.reportedToolCallId
void empty; void absent; void input; void reported
declare const envelope: core.NativeHookEnvelope
declare const protocol: core.AgentTerminalInteractionDetection
const interaction: core.AgentMuxInteractionRequest | undefined = core.normalizeTerminalInteraction(
  envelope, 1, protocol, fields, undefined, 'permission-request')
const completion = core.normalizeTerminalInteractionCompletion(envelope, 1, protocol, fields)
void interaction; void completion
// @ts-expect-error interaction projection requires the Provider-selected facts
core.normalizeTerminalInteraction(envelope, 1, protocol)
// @ts-expect-error completion cannot parse an owner-free raw payload
core.normalizeTerminalInteractionCompletion(envelope, 1, protocol)
// @ts-expect-error raw payload alone cannot select a Provider's tool identity
core.projectNativeHookToolFields({ originalId: 'foreign-call' })
// @ts-expect-error the unsafe owner-free identity parser is no longer public
core.nativeHookToolCallId({ call_id: 'foreign-call' })
`)
    const program = ts.createProgram([consumer], {
      noEmit: true,
      strict: true,
      target: ts.ScriptTarget.ES2023,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      types: ['node'],
      typeRoots: [resolve(import.meta.dirname, '../../../node_modules/@types')],
      skipLibCheck: false,
      paths: { '@agentmux/core': [resolve(import.meta.dirname, '../dist/index.d.ts')] }
    })
    const diagnostics = ts.getPreEmitDiagnostics(program)
    expect(diagnostics.map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))).toEqual([])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
