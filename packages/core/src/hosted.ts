/** Browser-safe SDK for a consumer of the original semantic Host. No local Runtime owner. */
export { connectHostedAgentMux } from './hosted-client.js'
export { AGENTMUX_HOSTED_METHODS } from './hosted-client-contract.js'
export { isHostedAgentSessionSummary, hostedPromptAdmissionSummary } from './hosted-session-summary.js'
export type { AgentMuxHostedSessionObservation } from './types.js'
export type { AgentMuxHostEnvironment, AgentMuxHostEnvironmentSelector, AgentMuxAgentWorkspaceLocator, AgentMuxSelectedHostEnvironment } from './host-environment.js'
export type { AgentMuxHostedAgentSessionSummary, AgentMuxHostedSessionProjection, AgentMuxHostedPromptIntentSummary, AgentMuxHostedPromptAdmissionSummary } from './hosted-session-summary.js'
export type {
  AgentMuxHostExecutorDescriptor, AgentMuxHostExecutorInventory,
  AgentMuxHostExecutorConfigureInput, AgentMuxHostExecutorConfiguration
} from './executor-contract.js'
export type {
  AgentMuxHostedClient, AgentMuxHostedMethod, AgentMuxHostedInvocation,
  AgentMuxHostedBootstrap, AgentMuxHostedRpcPort, AgentMuxHostedStreamEvent,
  AgentMuxHostedSubscription, AgentMuxHostedOutputRpcPort, AgentMuxHostedOutputObservation, AgentMuxHostedSubscribeRpc
} from './hosted-client-contract.js'

export { parseAppearanceObservation } from './public-rpc-settings-observation.js'
export type { AgentMuxAppearanceObservation } from './public-rpc-settings-observation.js'
