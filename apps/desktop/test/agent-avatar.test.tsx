import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
vi.hoisted(() => { vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true) })
import { useAppStore } from '../src/renderer/src/store.js'

const avatarSource = readFileSync(
  new URL('../src/renderer/src/components/AgentAvatar.tsx', import.meta.url),
  'utf8'
)

describe('Agent avatar native-surface occlusion lease', () => {
  it('keeps leases counted and never releases below zero', () => {
    const initial = useAppStore.getState().nativeSurfaceOverlayCount
    useAppStore.setState({ nativeSurfaceOverlayCount: 0 })

    useAppStore.getState().acquireNativeSurfaceOverlay()
    useAppStore.getState().acquireNativeSurfaceOverlay()
    expect(useAppStore.getState().nativeSurfaceOverlayCount).toBe(2)
    useAppStore.getState().releaseNativeSurfaceOverlay()
    useAppStore.getState().releaseNativeSurfaceOverlay()
    useAppStore.getState().releaseNativeSurfaceOverlay()
    expect(useAppStore.getState().nativeSurfaceOverlayCount).toBe(0)

    useAppStore.setState({ nativeSurfaceOverlayCount: initial })
  })

  it('owns one idempotent lease for the AgentAvatar popover lifecycle', () => {
    expect(avatarSource).toContain('const overlayLeaseHeld = useRef(false)')
    expect(avatarSource).toContain('if (!overlayLeaseHeld.current)')
    expect(avatarSource).toContain('acquireNativeSurfaceOverlay()')
    expect(avatarSource).toContain('releaseNativeSurfaceOverlay()')
  })
})
