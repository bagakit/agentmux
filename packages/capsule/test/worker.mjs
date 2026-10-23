import { NodeCapsuleOwner } from '../dist/node.js'
const owner = await NodeCapsuleOwner.open({ stateDirectory: process.env.CAPSULE_TEST_STATE })
process.send({ ready: true })
process.on('message', async (message) => {
  try {
    if (message.method === 'close') {
      await owner.close()
      process.send({ id: message.id, closed: true }, () => process.exit(0))
      return
    }
    const result = await owner.call(message.method, message.params, message.context)
    process.send({ id: message.id, result })
  } catch (error) {
    process.send({ id: message.id, error: { code: error.code, message: error.message } })
  }
})
