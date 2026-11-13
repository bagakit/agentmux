import { describe, expect, it, vi } from 'vitest'
import { createInterfacePortLabels } from '../src/mobile-link-candidates.js'

const wifi = 'Hardware Port: Wi-Fi\nDevice: en0\nEthernet Address: 00:00:00:00:00:01\n'
const wired = '\nHardware Port: Thunderbolt Ethernet\nDevice: en7\nEthernet Address: 00:00:00:00:00:02\n'

describe.runIf(process.platform === 'darwin')('hardware labels alongside virtual phone-link candidates', () => {
  it('does not launch another OS query for a virtual interface already checked, but reads a new adapter', async () => {
    const read = vi.fn<() => Promise<string>>().mockResolvedValue(wifi)
    const labels = createInterfacePortLabels(read)
    const original = await labels(['en0', 'utun4'])
    expect(original.get('en0')).toBe('Wi-Fi'); expect(original.has('utun4')).toBe(false)
    expect(await labels(['utun4', 'en0'])).toBe(original)
    expect(await labels(['en0', 'utun4'])).toBe(original)
    expect(read).toHaveBeenCalledTimes(1)
    read.mockResolvedValue(wifi + wired)
    expect((await labels(['en0', 'utun4', 'en7'])).get('en7')).toBe('Thunderbolt Ethernet')
    expect(read).toHaveBeenCalledTimes(2)
  })

  it('keeps absent labels absent, retries a failed read for new hardware, and checks a reappearing unlabeled adapter', async () => {
    const read = vi.fn<() => Promise<string>>().mockResolvedValue('')
    const labels = createInterfacePortLabels(read)
    expect((await labels(['utun4'])).size).toBe(0)
    expect((await labels(['utun4'])).size).toBe(0)
    expect(read).toHaveBeenCalledTimes(1)
    read.mockRejectedValueOnce(new Error('OS read failed')).mockResolvedValue(wifi)
    expect((await labels(['en0', 'utun4'])).size).toBe(0)
    expect((await labels(['en0', 'utun4'])).get('en0')).toBe('Wi-Fi')
    expect(read).toHaveBeenCalledTimes(3)
    await labels(['en0'])
    await labels(['en0', 'utun4'])
    expect(read).toHaveBeenCalledTimes(4)
  })
})
