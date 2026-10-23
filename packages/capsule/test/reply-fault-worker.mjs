import { registerHooks } from 'node:module'
let failDispatchSave = false,
  nativeConfirmed = false,
  prepareCount = 0,
  submitCount = 0
const receipts = new Map()
globalThis.capsuleReplyFault = (path, value) => {
  if (
    failDispatchSave &&
    path.includes('/interactions/') &&
    value.interaction?.reply?.phase === 'dispatch-started'
  ) {
    throw Object.assign(new Error('injected pre-dispatch persistence failure'), { code: 'EIO' })
  }
}
registerHooks({
  load(url, context, nextLoad) {
    const result = nextLoad(url, context)
    if (!url.endsWith('/capsule/dist/storage.js')) return result
    return {
      ...result,
      source: String(result.source).replace(
        'await rename(temporary, path);',
        'globalThis.capsuleReplyFault(path, value); await rename(temporary, path);',
      ),
    }
  },
})
const { NodeCapsuleOwner } = await import('../dist/node.js')
const owner = await NodeCapsuleOwner.open({
  stateDirectory: process.env.CAPSULE_TEST_STATE,
  replies: {
    async prepare(input, context) {
      if (!nativeConfirmed)
        throw Object.assign(new Error('native confirmation required'), { code: 'CONTROL_PERMISSION_DENIED' })
      prepareCount++
      return {
        version: 1,
        operationId: input.operationId,
        capsuleId: input.interaction.capsuleId,
        interactionId: input.interaction.interactionId,
        target: input.interaction.target,
        expectedRun: { runId: 'original-run' },
        inputOperationId: input.inputOperationId,
        principal: context.principal,
        prompt: input.answer,
        adapterData: { sourceChannel: 'question-reply' },
      }
    },
    async submit(prepared) {
      if (!nativeConfirmed)
        throw Object.assign(new Error('native confirmation required'), { code: 'CONTROL_PERMISSION_DENIED' })
      submitCount++
      const receipt = {
        status: 'submitted',
        inputOperationId: prepared.inputOperationId,
        expectedRun: prepared.expectedRun,
        inputStatus: 'waiting',
      }
      receipts.set(prepared.inputOperationId, receipt)
      return receipt
    },
    async inspect(prepared) {
      return receipts.get(prepared.inputOperationId) ?? null
    },
  },
})
process.send({ ready: true })
process.on('message', async (message) => {
  try {
    if (message.method === 'fault') {
      failDispatchSave = message.params.enabled
      process.send({ id: message.id, result: true })
      return
    }
    if (message.method === 'confirm') {
      nativeConfirmed = true
      process.send({ id: message.id, result: true })
      return
    }
    if (message.method === 'counts') {
      process.send({ id: message.id, result: { prepareCount, submitCount } })
      return
    }
    if (message.method === 'close') {
      await owner.close()
      process.send({ id: message.id, result: true }, () => process.exit(0))
      return
    }
    const result = await owner.call(message.method, message.params, message.context)
    process.send({ id: message.id, result })
  } catch (error) {
    process.send({ id: message.id, error: { code: error.code, message: error.message } })
  } finally {
    if (message.method === 'capsule.interaction.reply') nativeConfirmed = false
  }
})
