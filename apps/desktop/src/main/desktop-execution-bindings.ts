import { createCoreExecutionBindingClient } from './execution-binding-client'
import { ExecutionBindingReaders } from './execution-binding-readers'
import type { RuntimeController } from './runtime-controller'

/** Main owns only its renderer readers. The original Core owns execution state. */
export function createDesktopExecutionBindings(runtime: Pick<RuntimeController, 'callOriginalCore' | 'subscribeOriginalCore'>) {
  const bindings = createCoreExecutionBindingClient(runtime)
  const readers = new ExecutionBindingReaders(bindings)
  return { bindings, readers, dispose: () => readers.dispose() }
}
