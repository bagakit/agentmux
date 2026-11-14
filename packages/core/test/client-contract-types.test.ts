import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import ts from 'typescript'
import { expect, it } from 'vitest'

it('preserves all public Client operation contracts in the Node SDK declaration graph', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'amx-client-contract-types-'))
  try {
    const consumer = join(directory, 'consumer.mts')
    await writeFile(consumer, `import type * as core from '@agentmux/core'
declare const operationClient: core.AgentMuxClient
declare const createInput: core.AgentMuxAgentCreateInput
declare const hostCreateInput: core.AgentMuxHostAgentCreateInput
declare const terminalInput: core.AgentMuxTerminalCreateInput
declare const promptInput: core.AgentMuxAgentPromptInput
declare const questionInput: core.AgentMuxSessionQuestionReplyInput
declare const messageSubmission: core.AgentMuxAgentMessageSubmission
const messageInput: core.AgentMuxAgentMessageInput = { ...messageSubmission, agentSessionId: 'original-session' }
declare const interactionInput: core.AgentMuxAgentInteractionInput
declare const postureInput: core.AgentMuxAgentPostureInput
declare const respawnInput: core.AgentMuxAgentRespawnInput
declare const options: core.AgentMuxClientOptions
const constructorOptions: ConstructorParameters<typeof core.AgentMuxClient>[0] = options
void constructorOptions
void operationClient.createAgent(createInput)
void operationClient.createHostAgentWithDelivery(hostCreateInput)
void operationClient.createTerminal(terminalInput)
void operationClient.submitAgentPrompt(promptInput)
void operationClient.replySessionQuestion(questionInput)
void operationClient.submitAgentMessage(messageInput)
void operationClient.respondAgentInteraction(interactionInput)
void operationClient.setAgentPosture(postureInput, { actor: { kind: 'user', id: 'typed-host' } })
void operationClient.respawnAgent(respawnInput)
const attachment: Promise<core.AgentMuxAgentAttachment> = operationClient.reattachAgent('original-session')
const runtimeStatus: Promise<core.AgentMuxAgentRuntimeStatus> = operationClient.statusAgent('original-session')
void attachment
void runtimeStatus

declare const interactionWithoutRun: Omit<core.AgentMuxAgentInteractionInput, 'expectedRun'>
// @ts-expect-error interaction requires the original expected Run
const interactionMustKeepRun: core.AgentMuxAgentInteractionInput = interactionWithoutRun
const directed = { agentSessionId: 'original-session', operationId: 'original-operation', expectedRun: { runId: 'original-run' },
  admissionIntent: { kind: 'session-conversation' as const }, execution: 'immediate' as const, prompt: 'Original request' }
const directedInput: core.AgentMuxAgentPromptInput = directed
void directedInput
// @ts-expect-error directed input cannot borrow a conditional predecessor
const directedMustNotBorrowPredecessor: core.AgentMuxAgentPromptInput = { ...directed, afterSubmissionId: 'another-input' }
// @ts-expect-error directed input requires immediate execution
const directedMustStayImmediate: core.AgentMuxAgentPromptInput = { ...directed, execution: 'default' }
// @ts-expect-error private prompt support is not a public root type
type PrivatePromptContent = core.AgentMuxAgentPromptContent
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
