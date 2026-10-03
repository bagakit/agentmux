import { vi } from 'vitest'

/** The track boundary is a real EventTarget; production consumes its standard ended event. */
export function previewMedia(id = 'preview-track') {
  const track = Object.assign(new EventTarget(), { id, stop: vi.fn() }) as unknown as MediaStreamTrack
  const stream = new MediaStream()
  Object.defineProperty(stream, 'getTracks', { value: () => [track] })
  return { track, stream }
}
export function previewFrame(video: HTMLVideoElement) {
  // happy-dom does not implement the standard HTMLMediaElement ready-state constants.
  Object.defineProperty(HTMLMediaElement, 'HAVE_CURRENT_DATA', { configurable: true, value: 2 })
  Object.defineProperties(video, {
    readyState: { configurable: true, value: 2 },
    videoWidth: { configurable: true, value: 640 }, videoHeight: { configurable: true, value: 320 }
  })
  video.dispatchEvent(new Event('loadeddata'))
}
