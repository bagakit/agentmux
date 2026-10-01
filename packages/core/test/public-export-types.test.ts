import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import ts from 'typescript'
import { expect, it } from 'vitest'

it('compiles the complete public Core export graph without Node ambient types or skipped declarations', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'amx-public-types-'))
  try {
    const consumer = join(directory, 'consumer.mts')
    await writeFile(consumer, `import * as core from '@agentmux/core'
import { openAgentMuxRpcHttpRequest, parseRpcResponse, rpcResponseError, encodeHostedValue, decodeHostedValue, parseAgentMuxRpcPrivateAccessState, type AgentMuxRpcPrivateAccessState, type AgentMuxRpcCertificatePreparation } from '@agentmux/core/public-rpc-http'
const portableState: AgentMuxRpcPrivateAccessState = parseAgentMuxRpcPrivateAccessState({ state: 'unavailable', message: 'Unconfirmed' }, 'host')
const rootState: core.AgentMuxRpcPrivateAccessState = portableState
declare const locator: AgentMuxRpcCertificatePreparation
const rootLocator: core.AgentMuxRpcCertificatePreparation = locator
void rootState
void rootLocator
const fetchRequest: typeof openAgentMuxRpcHttpRequest = openAgentMuxRpcHttpRequest
const response = parseRpcResponse({ jsonrpc: '2.0', id: 'portable', result: {} })
const failure = rpcResponseError(response)
void fetchRequest
void failure
void decodeHostedValue(encodeHostedValue([new Uint8Array([0, 255]), undefined]))
const connect: typeof core.connectAgentMuxRpc = core.connectAgentMuxRpc
declare const client: core.AgentMuxRpcClient
const subscribe: core.AgentMuxRpcClient['subscribe'] = client.subscribe
declare const request: core.AgentMuxRpcStreamParams<'toolkit.watch'>
declare const handlers: core.AgentMuxRpcSubscriptionOptions<'toolkit.watch'>
void connect
void subscribe('toolkit.watch', request, handlers)
`)
    const program = ts.createProgram([consumer], {
      noEmit: true,
      strict: true,
      target: ts.ScriptTarget.ES2023,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      types: [],
      skipLibCheck: false,
      paths: {
        '@agentmux/core': [resolve(import.meta.dirname, '../dist/index.d.ts')],
        '@agentmux/core/public-rpc-http': [resolve(import.meta.dirname, '../dist/public-rpc-http.d.ts')]
      }
    })
    const diagnostics = ts.getPreEmitDiagnostics(program)
    expect(diagnostics.map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))).toEqual([])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
