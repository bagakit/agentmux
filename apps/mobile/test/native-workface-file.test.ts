// @vitest-environment happy-dom
import './device-locks'
import { beforeEach, expect, it, vi } from 'vitest'
import { exportNativeWorkfaceFile } from '../src/platform/native/workface-file'
import { emptyDeviceWorkface, getDeviceWorkface } from '../src/recovery/device-workface'

beforeEach(async () => { localStorage.clear(); await getDeviceWorkface().replaceBackup(emptyDeviceWorkface()) })
it('passes a shared staging identity and the original validated backup to the actual native export port', async () => {
  const bytes = getDeviceWorkface().exportBackup(), save = vi.fn().mockResolvedValue(undefined)
  await exportNativeWorkfaceFile('agentmux-workface.json', bytes, { save })
  expect(save).toHaveBeenCalledOnce()
  const input = save.mock.calls[0]![0]
  expect(input).toEqual({ filename: 'agentmux-workface.json', bytes, stagingId: expect.stringMatching(/^[1-9A-HJ-NP-Za-km-z]{12}$/) })
  expect(getDeviceWorkface().parseBackup(input.bytes)).toEqual(getDeviceWorkface().parseBackup(bytes))
})
it('keeps invalid backups out of native export and preserves cancellation as an unconfirmed save', async () => {
  const save = vi.fn().mockResolvedValue(undefined)
  await expect(exportNativeWorkfaceFile('agentmux-workface.json', '{}', { save })).rejects.toThrow()
  expect(save).not.toHaveBeenCalled()
  const bytes = getDeviceWorkface().exportBackup(), cancelled = Error('Native picker cancelled')
  save.mockRejectedValue(cancelled)
  await expect(exportNativeWorkfaceFile('agentmux-workface.json', bytes, { save })).rejects.toBe(cancelled)
  expect(getDeviceWorkface().exportBackup()).toBe(bytes)
})
