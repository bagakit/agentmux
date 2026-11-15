import { expect, vi } from 'vitest'
import type { BrowserBounds } from '../../src/shared/contracts'
import type { WorkbenchBrowserPresentation } from '../../src/renderer/src/components/BrowserPresentationStage'
import { api } from '../../src/renderer/src/lib/api'

export function observeScreenshotPresentation(page: { browserId: string; workspaceId: string; regionId: string }) {
  const leaseId = `lease:${page.browserId}`
  const registration = vi.spyOn(api.browser, 'registerPresentation').mockResolvedValue({ leaseId })
  const update = vi.spyOn(api.browser, 'updatePresentation').mockResolvedValue(undefined)
  vi.spyOn(api.browser, 'removePresentation').mockResolvedValue(undefined)
  vi.spyOn(api.browser, 'activatePresentation').mockResolvedValue({ outcome: 'selected' })

  function stage(visible: boolean): WorkbenchBrowserPresentation {
    return {
      occurrence: { presentationId: page.regionId, layoutHost: 'sole', location: {
        displayWorkspaceId: page.workspaceId, groupId: 'screenshot-group', tabId: 'screenshot-tab', regionId: page.regionId
      } },
      stageHostId: 'screenshot-stage', visible, active: true, yieldToFocusRing: false,
      target: { hostId: 'screenshot-stage', active: true, surface: 'space' }
    }
  }

  return {
    stage,
    expectBounds(bounds: BrowserBounds | null) {
      expect(registration).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
        browserId: page.browserId, occurrence: stage(true).occurrence
      }))
      expect(update).toHaveBeenLastCalledWith(leaseId, bounds ? { visible: true, bounds } : { visible: false })
    },
    expectOriginalLease() {
      expect(registration).toHaveBeenCalledOnce()
      expect(new Set(update.mock.calls.map(([id]) => id))).toEqual(new Set([leaseId]))
    }
  }
}
