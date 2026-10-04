/** Browser-safe SDK for a consumer of the original semantic Host. No local Runtime owner. */
export { connectHostedAgentMux } from './hosted-client.js'
export { AGENTMUX_HOSTED_METHODS } from './hosted-client-contract.js'
export type {
  AgentMuxHostExecutorDescriptor, AgentMuxHostExecutorInventory,
  AgentMuxHostExecutorConfigureInput, AgentMuxHostExecutorConfiguration
} from './executor-contract.js'
export type {
  AgentMuxHostedClient, AgentMuxHostedMethod, AgentMuxHostedInvocation,
  AgentMuxHostedBootstrap, AgentMuxHostedRpcPort, AgentMuxHostedStreamEvent,
  AgentMuxHostedSubscription, AgentMuxHostedOutputRpcPort, AgentMuxHostedOutputObservation
} from './hosted-client-contract.js'
