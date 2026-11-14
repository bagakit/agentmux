import { creationInputOwner } from '../../../packages/core/test/helpers/creation-input-owner.js'

/** Current complete prepared Start contract at the deterministic Native leaf. */
export async function learningCore(...args: Parameters<typeof creationInputOwner>) {
  const fixture = await creationInputOwner(...args), kernel = fixture.inner.kernel
  fixture.inner.hookServer.createBinding = (_sessionId: string, _providerId: string, bindingId: string) => ({ bindingId, endpoint: { url: 'http://127.0.0.1:0', token: 't'.repeat(43) }, bindRun: async () => {}, close: async () => {} })
  kernel.creationRuntimeIdentity = () => ({ runtimeId: 'learning-native', instanceId: 'learning-instance', protocolVersion: 18, buildIdentity: 'fixture' })
  kernel.startPrepared = async (request: any, operationKey: string) => kernel.start({ ...request, operationKey })
  kernel.inspectPreparedStart = async (request: any, operationKey: string) => {
    const index = fixture.started.findIndex(spec => spec.operationKey === operationKey)
    return index < 0 ? null : { ...fixture.run('fixture-run-' + index), program: request.program, args: request.args, workspacePath: request.cwd, lifecycleOperationId: operationKey }
  }
  return fixture
}
