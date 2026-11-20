import { AgentMuxError, type AgentExecutionBindingObservation, type AgentExecutionBindingService, type AgentMuxRpcCallContext } from '@agentmux/core'
import type { RuntimeController } from './runtime-controller'

/** Desktop carries original Core operations and reader custody only. It never
 * opens execution state, owns a Coordinator or restores/closes helper bridges. */
export function createCoreExecutionBindingClient(runtime: Pick<RuntimeController, 'callOriginalCore' | 'subscribeOriginalCore'>):
  Pick<AgentExecutionBindingService, 'admit' | 'create' | 'inspect' | 'rejoin' | 'continueOriginal' | 'watch'> {
  const context = (value?: AgentMuxRpcCallContext) => value ?? { transport: 'unix' as const }
  return {
    admit: (input, original) => runtime.callOriginalCore('local', 'agent.execution.admit', input, context(original)),
    create: (input, original) => runtime.callOriginalCore('local', 'agent.execution.create', input, context(original)),
    inspect: (bindingId, view, original?: AgentMuxRpcCallContext) => runtime.callOriginalCore('local', 'agent.execution.binding', { bindingId, ...(view ? { view } : {}) }, context(original)),
    rejoin: (bindingId, original, recoverProject) => runtime.callOriginalCore('local', 'agent.execution.rejoin', { bindingId, ...(recoverProject ? { recoverProject: true } : {}) }, context(original)),
    continueOriginal: (input, original) => runtime.callOriginalCore('local', 'agent.execution.continue', input, context(original)),
    watch: async (bindingId, onSnapshot, original = {}) => {
      let initial: AgentExecutionBindingObservation | undefined, pending: AgentExecutionBindingObservation | undefined
      let active = true, started = false, emitting = false
      let subscription: Awaited<ReturnType<RuntimeController['subscribeOriginalCore']>> | undefined
      const dispose = async () => { active = false; pending = undefined; await subscription?.dispose() }
      const failed = (error: unknown) => { if (!active) return; void dispose().catch(() => {}); try { original.onError?.(error) } catch { /* Observation never changes its Core owner. */ } }
      const drain = () => {
        if (!active || !started || emitting || !pending) return
        const value = pending; pending = undefined; emitting = true
        void Promise.resolve().then(() => { if (active) return onSnapshot(value.inspection) }).catch(failed).finally(() => { emitting = false; drain() })
      }
      subscription = await runtime.subscribeOriginalCore('local', 'agent.execution.watch', { bindingId }, {
        onInitial: value => { initial = value }, onEvent: event => {
          if (!active) return
          if (event.type === 'snapshot') { pending = event.data; drain() }
          else failed(event.type === 'error' ? new AgentMuxError(event.error.message, event.error.code) : new AgentMuxError('The original Core execution observation ended. Its bindings and Runs are retained.', 'EXECUTION_READER_UNAVAILABLE'))
        }, onEnd: error => failed(error ?? new AgentMuxError('The original Core execution observation ended.', 'EXECUTION_READER_UNAVAILABLE')),
      }, context(original))
      if (!active || !initial || initial.bindingId !== bindingId) {
        await dispose(); throw new AgentMuxError('The original Core did not confirm this binding reader.', 'EXECUTION_READER_UNAVAILABLE')
      }
      return { initial, start: () => { started = true; drain() }, dispose }
    },
  }
}
