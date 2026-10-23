import { expect, it } from 'vitest'
import { api } from '../src/renderer/src/lib/api'

it('keeps Capsule preview unavailable without inventing content or operation receipts', async () => {
  await expect(api.capsules.call('capsule.ls', {})).rejects.toMatchObject({ code: 'CONTROL_UNAVAILABLE' })
  await expect(api.capsules.call('capsule.open', { capsuleId: '123456789ABC', operationId: 'original-open' })).rejects.toMatchObject({ code: 'CONTROL_UNAVAILABLE' })
})
