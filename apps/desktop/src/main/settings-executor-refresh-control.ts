import type {
  AgentMuxControlSettingsExecutorRefreshRequest,
  AgentMuxControlSettingsExecutorRefreshResult,
  AgentMuxControlSettingsResourceFields
} from '@agentmux/core'
import type { ConfigOwner } from './config-owner.js'
import type { RuntimeController } from './runtime-controller.js'
import type { ExecutorDetection } from '../shared/contracts.js'

/** Explicit IPC and public Refresh capture the same committed configuration owner. */
export async function refreshSettingsExecutor(
  executorId: string,
  hostId: string,
  owner: ConfigOwner,
  runtime: Pick<RuntimeController, 'detect'>
): Promise<ExecutorDetection> {
  if (typeof executorId !== 'string' || !executorId.length || typeof hostId !== 'string' || !hostId.length) {
    throw Object.assign(new Error('Refresh requires exact Executor and Host IDs.'), { code: 'INVALID_SETTING_VALUE' })
  }
  return await runtime.detect(executorId, hostId, owner.current)
}

export async function executeSettingsExecutorRefreshControl(
  request: AgentMuxControlSettingsExecutorRefreshRequest,
  owner: ConfigOwner,
  runtime: Pick<RuntimeController, 'detect'>
): Promise<AgentMuxControlSettingsExecutorRefreshResult> {
  const result = await refreshSettingsExecutor(request.executorId, request.hostId, owner, runtime)
  return {
    operation: request.operation,
    ...result,
    input: {
      ...result.input,
      host: structuredClone(result.input.host) as AgentMuxControlSettingsResourceFields
    }
  }
}
