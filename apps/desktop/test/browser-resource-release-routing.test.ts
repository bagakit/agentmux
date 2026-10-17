import { expect, it, vi } from 'vitest'
import { AGENTMUX_CONTROL_SCHEMA_VERSION } from '@agentmux/core/control'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'

it('keeps a misrouted native release at Main without opening or changing the workface', async () => {
  const original = useAppStore.getState()
  const create = vi.spyOn(api.browser, 'create'), release = vi.spyOn(api.browser, 'release')
  try {
    await expect(original.executeControl({ schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION,
      requestId: 'misrouted-native-release', operation: 'browser.release', browserId: 'original', navigationId: 'original-document'
    })).rejects.toMatchObject({ code: 'CONTROL_FAILED', message: 'Native Browser release belongs to the Main resource owner.' })
    expect(useAppStore.getState()).toBe(original)
    expect(create).not.toHaveBeenCalled(); expect(release).not.toHaveBeenCalled()
  } finally { vi.restoreAllMocks() }
})
