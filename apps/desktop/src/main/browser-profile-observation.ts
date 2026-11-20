import type { WebContentsView } from 'electron'
import { mintObjectId } from '@agentmux/core/object-id'
import type { BrowserProfileActivityCheckpoint, BrowserProfileActivityGap } from './browser-profile-store.js'

export interface BrowserProfileActivityPorts {
  readonly activityObserverId?: string
  activitySource?(profileId: string): string | null
  recordActivity?(profileId: string, checkpoint: BrowserProfileActivityCheckpoint): Promise<void>
}

type ProfileObservation = {
  profileId: string
  previousObserverId: string | null
  sequence: number
  unionMs: number
  tick: number
  observedAt: number
  lastUsedAt: number
  markers: Set<NativeMarker>
  gaps: Map<string, BrowserProfileActivityGap>
  pending?: BrowserProfileActivityCheckpoint
  writing?: Promise<void>
  warning?: string
}

type NativeMarker = {
  view: WebContentsView
  observation: ProfileObservation
  observing: boolean
  gap?: BrowserProfileActivityGap
}

function isObserving(observation: ProfileObservation): boolean {
  for (const marker of observation.markers) if (marker.observing) return true
  return false
}

function advance(observation: ProfileObservation, monotonic: number): void {
  if (isObserving(observation)) observation.unionMs += Math.max(0, monotonic - observation.tick)
  observation.tick = monotonic
}

/** Native usage and its checkpoints follow the original view through closing and replacement. */
export class BrowserProfileActivity {
  private readonly markers = new WeakMap<WebContentsView, NativeMarker>()
  private readonly observations = new Map<string, ProfileObservation>()
  private readonly active = new Set<ProfileObservation>()
  // undefined is idle. null means the host has stopped sampling during teardown.
  private timer: ReturnType<typeof setInterval> | undefined | null
  private finalized = false

  constructor(
    private readonly ports: BrowserProfileActivityPorts,
    private readonly onWarningChanged: (profileId: string) => void
  ) {}

  private activityTime(): { monotonic: number; wall: number } {
    return { monotonic: performance.now(), wall: Date.now() }
  }

  warning(profileId: string): string | undefined { return this.observations.get(profileId)?.warning }

  begin(profileId: string, view: WebContentsView): void {
    if (!this.ports.recordActivity || !this.ports.activityObserverId || this.finalized || this.markers.has(view)) return
    const now = this.activityTime()
    let observation = this.observations.get(profileId)
    if (!observation) {
      observation = {
        profileId, previousObserverId: this.ports.activitySource?.(profileId) ?? null,
        sequence: 0, unionMs: 0, tick: now.monotonic, observedAt: now.wall, lastUsedAt: now.wall,
        markers: new Set(), gaps: new Map()
      }
      this.observations.set(profileId, observation)
    }
    advance(observation, now.monotonic)
    const marker = { view, observation, observing: true }
    this.markers.set(view, marker)
    observation.markers.add(marker)
    observation.lastUsedAt = Math.max(observation.lastUsedAt, now.wall)
    observation.observedAt = Math.max(observation.observedAt, now.wall)
    this.publish(observation)
  }

  interrupt(view: WebContentsView, now = this.activityTime()): void {
    const marker = this.markers.get(view)
    if (!marker?.observing || this.finalized) return
    const observation = marker.observation
    // A crash receipt cannot confirm the last unobserved suffix of this renderer.
    marker.observing = false
    advance(observation, now.monotonic)
    const gap: BrowserProfileActivityGap = { id: mintObjectId(), after: observation.observedAt, reason: 'renderer-gone' }
    marker.gap = gap
    observation.gaps.set(gap.id, gap)
    this.publish(observation)
  }

  resume(view: WebContentsView): void {
    const marker = this.markers.get(view)
    if (!marker || marker.observing || this.finalized || view.webContents.isDestroyed() || view.webContents.isCrashed()) return
    const observation = marker.observation, now = this.activityTime()
    advance(observation, now.monotonic)
    if (marker.gap) {
      marker.gap.until = now.wall
      delete marker.gap
    }
    marker.observing = true
    observation.lastUsedAt = Math.max(observation.lastUsedAt, now.wall)
    observation.observedAt = Math.max(observation.observedAt, now.wall)
    this.publish(observation)
  }

  end(view: WebContentsView): void {
    const marker = this.markers.get(view)
    if (!marker) return
    const observation = marker.observation, now = this.activityTime()
    advance(observation, now.monotonic)
    if (marker.gap) marker.gap.until = now.wall
    observation.markers.delete(marker)
    this.markers.delete(view)
    observation.observedAt = Math.max(observation.observedAt, now.wall)
    this.publish(observation)
  }

  checkpoint(): void {
    if (this.finalized) return
    const now = this.activityTime()
    for (const observation of this.active) {
      if (!observation.markers.size) {
        // An ended observation can retry its last checkpoint without inventing a later sample.
        this.write(observation)
        continue
      }
      for (const { view, observing } of observation.markers) {
        if (observing && (view.webContents.isDestroyed() || view.webContents.isCrashed())) this.interrupt(view, now)
      }
      advance(observation, now.monotonic)
      if (isObserving(observation)) observation.lastUsedAt = Math.max(observation.lastUsedAt, now.wall)
      observation.observedAt = Math.max(observation.observedAt, now.wall)
      this.publish(observation)
    }
  }

  /** An open native view still has an unknown suffix after shutdown. */
  async flush(finalize: boolean): Promise<void> {
    this.checkpoint()
    await Promise.all([...this.active].map(observation => observation.writing))
    if (finalize) {
      this.finalized = true
      this.stopSampling()
    }
  }

  stopSampling(): void {
    this.clearTimer()
    this.timer = null
  }

  private clearTimer(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = undefined
    }
  }

  private publish(observation: ProfileObservation): void {
    const observerId = this.ports.activityObserverId
    if (this.finalized || !observerId) return
    observation.pending = {
      observerId, previousObserverId: observation.previousObserverId, sequence: ++observation.sequence,
      unionMs: Math.floor(observation.unionMs), observedAt: observation.observedAt, lastUsedAt: observation.lastUsedAt,
      active: isObserving(observation), gaps: [...observation.gaps.values()].map(gap => ({ ...gap }))
    }
    this.active.add(observation)
    // Sampling cadence controls persistence only. Native pages retain their own lifecycle.
    if (this.timer === undefined) {
      this.timer = setInterval(() => this.checkpoint(), 5_000)
      this.timer.unref?.()
    }
    this.write(observation)
  }

  private write(observation: ProfileObservation): void {
    if (observation.writing) return
    observation.writing = this.persist(observation).finally(() => {
      delete observation.writing
      if (!observation.pending && !observation.markers.size) this.active.delete(observation)
      if (!this.active.size) this.clearTimer()
    })
  }

  private async persist(observation: ProfileObservation): Promise<void> {
    while (observation.pending) {
      const checkpoint = observation.pending
      delete observation.pending
      try {
        await this.ports.recordActivity!(observation.profileId, checkpoint)
      } catch {
        observation.pending ??= checkpoint
        observation.warning = 'Observed Browser time could not be saved. Confirmed history is kept and Browser controls remain available. Keep this page open to retry the original activity observation.'
        this.notifyWarning(observation.profileId, 'Browser activity notice delivery is unconfirmed; its original observation remains available.')
        break
      }
      if (observation.warning) {
        delete observation.warning
        this.notifyWarning(observation.profileId, 'Saved Browser activity notice delivery is unconfirmed; its confirmed checkpoint remains readable.')
      }
    }
  }

  private notifyWarning(profileId: string, fallback: string): void {
    try { this.onWarningChanged(profileId) } catch { console.warn(fallback) }
  }
}
