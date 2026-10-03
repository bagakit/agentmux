import { describe, expect, it } from 'vitest'
import { openNativeProcessImage } from '../src/agent-native-process.js'
describe('OS-mapped native process image', () => {
  it('opens the real entry image and revalidates the held identity on this Host', async () => {
    const image = await openNativeProcessImage(process.pid, AbortSignal.timeout(5000))
    try {
      const stat = await image.file.stat({ bigint: true })
      expect(stat.isFile()).toBe(true); expect(stat.size).toBeGreaterThan(0n)
      expect(JSON.parse(image.identity)).toEqual([stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].map(String))
      await image.assertCurrent()
    } finally { await image.file.close() }
  })
  it('does not substitute PATH for a missing or invalid process image', async () => {
    await expect(openNativeProcessImage(0, AbortSignal.timeout(5000))).rejects.toMatchObject({ code: 'AGENT_SESSION_HISTORY_IDENTITY_UNAVAILABLE' })
    await expect(openNativeProcessImage(99999999, AbortSignal.timeout(5000))).rejects.toBeDefined()
  })
})
