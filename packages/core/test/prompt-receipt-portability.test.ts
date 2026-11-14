import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createContext, runInContext } from 'node:vm'
import { build } from 'esbuild'
import { expect, it } from 'vitest'
import { parsePromptSubmissionRecord, terminalPromptPhaseOperationIdentity } from '../src/prompt-submission-record.js'
import { parseAgentInputSubmissionReceipt } from '../src/agent-input-receipt-codec.js'
import { agentInputSubmissionStatus } from '../src/agent-input-wait.js'
import type { AgentPromptSubmissionRecord, AgentTerminalInputPhaseState } from '../src/types.js'

const original = { agentSessionId: 'original-agent', run: { runId: 'original-run' } }
const submissionId = 'original-input', sourceId = 'original-native-source'
const nodeDigest = (value: string) => createHash('sha256').update(value, 'utf8').digest('base64url')
const phaseIdentity = (phase: string, data: string) => nodeDigest(JSON.stringify(['agentmux-terminal-prompt-v1', original.agentSessionId, original.run.runId, submissionId, phase, data]))
const values = ['ASCII', 'é原文', '😀𐐷', '\ud800', '\udc00', 'a\ud800b\udc00', 'line\n\0tail']

/** Original Node encodings are the independent oracle, never the implementation under test. */
function ptyRecord(text: string): AgentPromptSubmissionRecord {
  const prompt = 'Body: ' + text
  const plan = { kind: 'render-then-submit' as const, payload: prompt, renderedText: prompt, submit: '\r', prepare: { interrupt: '\x1b', endEvent: 'Interrupt', refresh: '\x1b[I' } }
  const phase = (kind: 'interrupt' | 'payload' | 'submit', data: string, startByte: number): AgentTerminalInputPhaseState => ({ operationId: phaseIdentity(kind, data),
    inputByteRange: { startByte, endByte: startByte + Buffer.byteLength(data, 'utf8') }, acknowledged: true })
  const interrupt = phase('interrupt', plan.prepare.interrupt, 10), payload = phase('payload', plan.payload, interrupt.inputByteRange.endByte), submit = phase('submit', plan.submit, payload.inputByteRange.endByte)
  const inputKey = { kind: 'prompt' as const, agentSessionId: original.agentSessionId, expectedRun: original.run, submissionId }
  return { ...original, nativeResult: { state: 'unsupported', reason: 'uncorrelated-carrier' },
    admission: { operationId: interrupt.operationId, inputKey, inputDispatch: { ref: { key: inputKey, waitGeneration: 1 }, gateId: 'original-gate' }, submissionId,
      startByte: interrupt.inputByteRange.startByte, endByte: submit.inputByteRange.endByte, acknowledged: true,
      intent: { run: original.run, ownerInstanceId: 'original-owner', prompt, plan, execution: 'immediate', message: { userContent: prompt } } },
    terminalPromptSubmission: { run: original.run, submissionId, promptDigest: nodeDigest(prompt), outputCursorBytes: 1,
      prepare: { context: 'interruptible', nativeTurnId: 'original-turn', interrupt }, payload, submit },
    ptyRefreshHistory: [{ operationId: phaseIdentity('refresh', JSON.stringify([plan.prepare.refresh, sourceId, 0])),
      inputByteRange: { startByte: 0, endByte: Buffer.byteLength(plan.prepare.refresh, 'utf8') }, acknowledged: true,
      nativeSourceId: sourceId, resizeRevision: 0, outputCursorBytes: 0 }] }
}
function receipt(record: AgentPromptSubmissionRecord) {
  const key = record.admission!.inputKey!, ref = { key, waitGeneration: 1 }
  const control = { ref, state: 'dispatch-authorized' as const, gateId: 'original-gate', at: 1 }
  return { key, ref, control, persistence: 'confirmed', admission: record, status: agentInputSubmissionStatus(control, record), observation: 'closed' }
}
function damaged(record: AgentPromptSubmissionRecord, field: 'digest' | 'operation' | 'payload-bytes' | 'submit-bytes' | 'interrupt-bytes' | 'refresh-bytes' | 'run') {
  const next = structuredClone(record), terminal = next.terminalPromptSubmission!, admission = next.admission!
  if (field === 'digest') terminal.promptDigest = 'different-original-digest'
  if (field === 'operation') terminal.payload.operationId = phaseIdentity('payload', 'different bytes')
  if (field === 'payload-bytes' || field === 'interrupt-bytes') {
    terminal.payload.inputByteRange.endByte++; terminal.submit.inputByteRange.startByte++; terminal.submit.inputByteRange.endByte++; admission.endByte++
    if (field === 'interrupt-bytes') { terminal.prepare!.interrupt!.inputByteRange.endByte++; terminal.payload.inputByteRange.startByte++ }
  }
  if (field === 'submit-bytes') { terminal.submit.inputByteRange.endByte++; admission.endByte++ }
  if (field === 'refresh-bytes') next.ptyRefreshHistory![0]!.inputByteRange.endByte++
  if (field === 'run') terminal.run = { runId: 'different-run' }
  return next
}

it('matches original Node UTF-8 JSON SHA-256 identities for every phase and surrogate vector', () => {
  for (const text of ['', ...values]) for (const phase of ['refresh', 'interrupt', 'payload', 'submit'] as const) {
    const identity = terminalPromptPhaseOperationIdentity(original, submissionId, phase, text)
    expect(identity).toBe(phaseIdentity(phase, text)); expect(identity).not.toContain('=')
  }
})

it('accepts original Node PTY hashes and byte ranges while rejecting every damaged receipt fence', () => {
  for (const text of values) {
    const record = ptyRecord(text)
    expect(() => parsePromptSubmissionRecord(record), 'Original Node receipt remains valid').not.toThrow()
    expect(parsePromptSubmissionRecord(record)).toEqual(record)
    expect(parseAgentInputSubmissionReceipt(receipt(record))).toEqual(receipt(record))
    for (const field of ['digest', 'operation', 'payload-bytes', 'submit-bytes', 'interrupt-bytes', 'refresh-bytes', 'run'] as const) {
      expect(() => parsePromptSubmissionRecord(damaged(record, field)), field).toThrow()
      expect(() => parseAgentInputSubmissionReceipt(receipt(damaged(record, field))), field).toThrow()
    }
  }
})

it('bundles actual hosted sources and consumes original mailbox and receipt codecs without Node globals', async () => {
  const root = resolve(import.meta.dirname, '../../..')
  const bundled = await build({ absWorkingDir: root, stdin: { contents: `
    import * as hosted from './packages/core/src/hosted.ts';
    import { parseAgentInputMailboxPage } from './packages/core/src/agent-input-mailbox-codec.ts';
    import { parseAgentInputSubmissionReceipt } from './packages/core/src/agent-input-receipt-codec.ts';
    export const hostedExports = Object.keys(hosted);
    export const nodeGlobals = () => [typeof globalThis.Buffer, typeof globalThis.process, typeof globalThis.require];
    export const read = (value) => parseAgentInputSubmissionReceipt(JSON.parse(JSON.stringify(value)));
    export const mailbox = (page, request) => parseAgentInputMailboxPage(JSON.parse(JSON.stringify(page)), JSON.parse(JSON.stringify(request)));
    `, resolveDir: root, sourcefile: 'prompt-receipt-browser-proof.ts', loader: 'ts' },
    bundle: true, platform: 'browser', format: 'iife', globalName: 'OriginalReceipts', write: false, metafile: true, logLevel: 'silent' })
  const graph = Object.keys(bundled.metafile!.inputs)
  for (const file of ['hosted.ts', 'hosted-client.ts', 'agent-input-mailbox-codec.ts', 'agent-input-receipt-codec.ts', 'prompt-submission-record.ts']) expect(graph).toContain('packages/core/src/' + file)
  expect(graph.some(file => file.startsWith('packages/core/dist/'))).toBe(false)
  expect(Object.values(bundled.metafile!.inputs).flatMap(file => file.imports).some(item => item.path.startsWith('node:'))).toBe(false)
  // These codecs consume JSON wire records. Native structuredClone returns host
  // prototypes in a Node VM; transfer that clone back into the receiver's JSON
  // realm so the original strict rpcRecord check sees browser-local objects.
  const context = createContext({ TextEncoder, TextDecoder, AbortController, AbortSignal, Uint8Array, ArrayBuffer, URL, setTimeout, clearTimeout,
    cloneWireJSON: (value: unknown) => JSON.stringify(structuredClone(value)) })
  runInContext('globalThis.structuredClone = ((clone) => value => JSON.parse(clone(value)))(cloneWireJSON); delete globalThis.cloneWireJSON', context)
  runInContext(bundled.outputFiles[0]!.text, context)
  const browser = context.OriginalReceipts as { hostedExports: string[]; nodeGlobals(): string[]; read(value: unknown): unknown; mailbox(page: unknown, request: unknown): unknown }
  expect(browser.hostedExports).toContain('connectHostedAgentMux'); expect(browser.nodeGlobals()).toEqual(['undefined', 'undefined', 'undefined'])
  const request = { agentSessionId: original.agentSessionId, maxBytes: 65536 }
  for (const text of values) {
    const record = ptyRecord(text), wire = receipt(record)
    expect(JSON.parse(JSON.stringify(browser.read(wire)))).toEqual(wire)
    const page = { agentSessionId: original.agentSessionId, queueId: 'original-queue', cut: { incarnation: 'original-cut', throughSequence: 1 }, budgetBytes: 65536,
      items: [{ kind: 'item', item: { kind: 'submission', sequence: 1, recordedAt: 1, key: wire.key, record } }], nextCursor: null, coverage: { kind: 'recorded-inputs', unrecorded: 'unconfirmed' } }
    expect(JSON.parse(JSON.stringify(browser.mailbox(page, request)))).toEqual(page)
    for (const field of ['digest', 'operation', 'payload-bytes', 'submit-bytes', 'interrupt-bytes', 'refresh-bytes', 'run'] as const) {
      expect(() => browser.read(receipt(damaged(record, field))), field).toThrow()
      const changed = structuredClone(page); changed.items[0]!.item.record = damaged(record, field)
      expect(() => browser.mailbox(changed, request), field).toThrow()
    }
  }
  if (process.env.AGENTMUX_PORTABILITY_BROWSER_RECEIPT) {
    const inputs = Object.fromEntries(await Promise.all(graph.filter(file => file.startsWith('packages/core/src/')).map(async file => [file, createHash('sha256').update(await readFile(resolve(root, file))).digest('hex')])))
    await writeFile(process.env.AGENTMUX_PORTABILITY_BROWSER_RECEIPT, JSON.stringify({ source_inputs: inputs, metafile: bundled.metafile,
      compiled_sha256: createHash('sha256').update(bundled.outputFiles[0]!.contents).digest('hex'), node_globals: browser.nodeGlobals(), vector_count: values.length, damaged_fences_per_vector: 7 }, null, 2) + '\n')
    await writeFile(process.env.AGENTMUX_PORTABILITY_BROWSER_RECEIPT + '.js', bundled.outputFiles[0]!.contents)
  }
})
