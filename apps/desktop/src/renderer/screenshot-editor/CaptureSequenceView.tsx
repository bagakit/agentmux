import { useEffect, useMemo, useRef, useState } from 'react'
import { Notice } from '@agentmux/client-ui/components/Notice'
import { BROWSER_PNG_MAX_BYTES, BROWSER_PNG_MAX_DIMENSION, BROWSER_PNG_MAX_PIXELS } from '@agentmux/browser/model/page'
import type { BrowserPng } from '../../shared/contracts'
import type { CaptureSequenceApi, CaptureSequenceInput, GifKeyframe, SequenceFrame, SequenceSnapshot } from '../../shared/capture-sequence'
import { inspectGif, writeGifMetadata } from '../../shared/gif-metadata'
import { matchScroll, type PixelFrame } from '../../shared/scroll-stitch'
import '@agentmux/client-ui/styles/notice.css'
import './capture-sequence.css'

async function pixels(image: BrowserPng) {
  const bitmap = await createImageBitmap(new Blob([Uint8Array.from(atob(image.dataUrl.split(',')[1]!), char => char.charCodeAt(0))], { type: 'image/png' }))
  const canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height
  const context = canvas.getContext('2d')!
  context.drawImage(bitmap, 0, 0); bitmap.close()
  return { canvas, pixels: context.getImageData(0, 0, canvas.width, canvas.height) as PixelFrame }
}
function png(canvas: HTMLCanvasElement): BrowserPng {
  const dataUrl = canvas.toDataURL('image/png')
  return { mimeType: 'image/png', dataUrl, width: canvas.width, height: canvas.height, byteLength: atob(dataUrl.split(',')[1]!).length }
}
/** Compose only confirmed overlaps; no guessed join is exported. */
export async function stitchFrames(frames: SequenceFrame[]): Promise<BrowserPng> {
  if (!frames.length) throw new Error('Capture at least one frame.')
  const width = frames[0]!.image.width
  const parts: HTMLCanvasElement[] = []
  let previous: PixelFrame | undefined
  let height = 0
  for (const frame of frames) {
    const next = await pixels(frame.image)
    const shift = previous ? matchScroll(previous, next.pixels).shift : next.canvas.height
    previous = next.pixels
    height += shift
    if (width > BROWSER_PNG_MAX_DIMENSION || height > BROWSER_PNG_MAX_DIMENSION || width * height > BROWSER_PNG_MAX_PIXELS)
      throw new Error('This screenshot exceeds the PNG dimension limit. Undo the last frame or retake a smaller region.')
    if (shift === next.canvas.height) parts.push(next.canvas)
    else {
      // Keep only the new rows of overlapping viewports until the final height is known.
      if (shift > 0) {
        const strip = document.createElement('canvas')
        strip.width = width; strip.height = shift
        strip.getContext('2d')!.drawImage(next.canvas, 0, shift - next.canvas.height)
        parts.push(strip)
      }
      next.canvas.width = 0
    }
  }
  const canvas = document.createElement('canvas')
  canvas.width = width; canvas.height = height
  const context = canvas.getContext('2d')!
  let y = 0
  for (const part of parts) {
    context.drawImage(part, 0, y)
    y += part.height
    part.width = 0
  }
  const result = png(canvas)
  if (result.byteLength > BROWSER_PNG_MAX_BYTES) throw new Error('This screenshot exceeds the PNG file size limit. Undo the last frame or retake a smaller region.')
  return result
}

type Decoder = { tracks: { ready: Promise<void>; selectedTrack: { frameCount: number } }; decode(input: { frameIndex: number }): Promise<{ image: VideoFrame }>; close(): void }
async function decodeGif(bytes: Uint8Array): Promise<SequenceFrame[]> {
  const info = inspectGif(bytes)
  if (info.width * info.height > 64 * 1024 * 1024) throw new Error('This GIF exceeds the 64 megapixel review budget. Your current recording is kept.')
  let frameBytes = 0
  const NativeDecoder = (globalThis as unknown as { ImageDecoder?: new (input: { data: Uint8Array; type: string }) => Decoder }).ImageDecoder
  if (!NativeDecoder) throw new Error('This Chromium cannot decode GIF frames. Your current recording is kept.')
  const decoder = new NativeDecoder({ data: bytes, type: 'image/gif' })
  try {
    await decoder.tracks.ready
    if (decoder.tracks.selectedTrack.frameCount !== info.delays.length) throw new Error('GIF decoder and file frame counts differ.')
    const frames: SequenceFrame[] = []; let time = 0
    for (let i = 0; i < info.delays.length; i++) {
      const { image } = await decoder.decode({ frameIndex: i })
      try {
        const canvas = document.createElement('canvas'); canvas.width = info.width; canvas.height = info.height
        canvas.getContext('2d')!.drawImage(image, 0, 0)
        const encoded = png(canvas); frameBytes += encoded.byteLength
        if (frameBytes > 64 * 1024 * 1024) throw new Error('Decoded GIF frames exceed the 64 MB review budget. Your current recording is kept.')
        frames.push({ image: encoded, capturedAt: time, delayMs: info.delays[i]! }); time += info.delays[i]!
      } finally { image.close() }
    }
    return frames
  } finally { decoder.close() }
}
export function CaptureSequenceView({ input, api }: { input: CaptureSequenceInput; api: CaptureSequenceApi }) {
  const [snapshot, setSnapshot] = useState<SequenceSnapshot>(input), [index, setIndex] = useState(0), [playing, setPlaying] = useState(false)
  const [keyframes, setKeyframes] = useState<GifKeyframe[]>([]), [busy, setBusy] = useState(false), [issue, setIssue] = useState<string | null>(null)
  const [fps, setFps] = useState(5), [progress, setProgress] = useState(0), [longImage, setLongImage] = useState<BrowserPng | null>(null)
  const [preparing, setPreparing] = useState(false), [discarding, setDiscarding] = useState(false)
  const keepReview = useRef<HTMLButtonElement>(null)
  const originalGif = useRef<Uint8Array | null>(null), worker = useRef<Worker | null>(null), current = useRef(snapshot)
  current.current = snapshot
  const recording = snapshot.state === 'recording' || snapshot.state === 'stopping', gif = input.mode === 'gif'
  const frames = snapshot.frames, frame = frames[Math.min(index, frames.length - 1)], keyframe = keyframes.find(k => k.frameIndex === index)
  const times = useMemo(() => { let sum = 0; return frames.map(frame => { const time = sum; sum += frame.delayMs; return time }) }, [frames])
  const time = times[index] ?? 0
  function merge(next: SequenceSnapshot) {
    setSnapshot(old => {
      const combined = next.frameOffset ? [...old.frames.slice(0, next.frameOffset), ...next.frames] : next.frames
      if (next.state === old.state && next.issue === old.issue && combined.length === old.frames.length && combined.at(-1)?.capturedAt === old.frames.at(-1)?.capturedAt && combined.at(-1)?.delayMs === old.frames.at(-1)?.delayMs && combined.at(-1)?.image.dataUrl === old.frames.at(-1)?.image.dataUrl) return old
      return { ...next, frames: combined }
    })
  }
  useEffect(() => {
    if (!recording) return
    let disposed = false, timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      try {
        const next = await api.inspect(input.requestId, current.current.frames.length)
        if (!disposed) { merge(next); if (next.frames.length) setIndex((next.frameOffset ?? 0) + next.frames.length - 1) }
      } catch (error) { if (!disposed) setIssue(String(error)) }
      if (!disposed) timer = setTimeout(() => void poll(), 400)
    }
    void poll()
    return () => { disposed = true; clearTimeout(timer) }
  }, [recording, api, input.requestId])
  useEffect(() => {
    if (!playing || !frames.length) return
    const timer = setTimeout(() => setIndex(value => (value + 1) % frames.length), frames[index]!.delayMs)
    return () => clearTimeout(timer)
  }, [playing, index, frames])
  useEffect(() => () => { worker.current?.terminate() }, [])
  useEffect(() => {
    if (gif || recording) return
    let disposed = false
    setPreparing(true); setLongImage(null)
    void stitchFrames(frames).then(image => { if (!disposed) setLongImage(image) }, error => { if (!disposed) setIssue(error instanceof Error ? error.message : String(error)) })
      .finally(() => { if (!disposed) setPreparing(false) })
    return () => { disposed = true }
  }, [gif, recording, frames])
  useEffect(() => gif ? undefined : api.onCloseRequested(() => setDiscarding(true)), [api, gif])
  useEffect(() => { if (discarding) keepReview.current?.focus() }, [discarding])
  async function action(operation: () => Promise<void>) {
    setBusy(true); setIssue(null)
    try { await operation() } catch (error) { setIssue(error instanceof Error ? error.message : String(error)) }
    finally { setBusy(false) }
  }
  async function sample() {
    const next = await api.sample(input.requestId)
    merge(next)
    setIndex(next.frames.length - 1)
  }
  async function encode(): Promise<Uint8Array> {
    setPlaying(false)
    if (originalGif.current) {
      const info = inspectGif(originalGif.current)
      return writeGifMetadata(originalGif.current, { schema: 'agentmux.gif.v1', width: info.width, height: info.height, delays: info.delays, keyframes })
    }
    return await new Promise((resolve, reject) => {
      const encoder = new Worker(new URL('./gif-encode.worker.ts', import.meta.url), { type: 'module' })
      worker.current = encoder; setProgress(0)
      encoder.onerror = error => { encoder.terminate(); worker.current = null; reject(new Error(error.message)) }
      encoder.onmessage = (event: MessageEvent<{ progress?: number; bytes?: Uint8Array; error?: string }>) => {
        if (event.data.progress) setProgress(event.data.progress)
        if (event.data.bytes || event.data.error) {
          encoder.terminate(); worker.current = null
          if (event.data.bytes) resolve(event.data.bytes); else reject(new Error(event.data.error))
        }
      }
      encoder.postMessage({ frames, keyframes })
    })
  }
  function select(next: number) { setPlaying(false); setIndex(next) }
  if (!gif && recording) return <main className="capture-live-controls">
    <header><h1>Scrolling screenshot</h1><button aria-label="Cancel scrolling capture" onClick={() => void api.cancel(input.requestId)}>Cancel</button></header>
    <p>Scroll or click in the outlined app.</p>
    <div className="capture-live-controls__preview">{frame ? <img src={frame.image.dataUrl} alt="Latest captured frame" /> : null}</div>
    <footer><span role="status">{frames.length} {frames.length === 1 ? 'frame' : 'frames'}</span><button className="primary-button" disabled={snapshot.state === 'stopping'} onClick={() => void action(async () => { merge(await api.stop(input.requestId)) })}>{snapshot.state === 'stopping' ? 'Finishing...' : 'Stop scrolling capture'}</button></footer>
    {issue || snapshot.issue ? <p role="status">{issue ?? snapshot.issue}</p> : null}
  </main>
  if (!gif) return <main className="capture-sequence capture-sequence--scroll-review" onKeyDown={event => {
    if (event.key === 'Escape') { event.preventDefault(); setDiscarding(value => !value) }
  }}>
    <header className="capture-review__header" inert={discarding}>
      <div><h1>Review screenshot</h1><p>{longImage ? `${longImage.width} × ${longImage.height} px` : 'Scrolling screenshot'}<span aria-hidden="true"> · </span>{frames.length} {frames.length === 1 ? 'frame' : 'frames'}</p></div>
      <button className="capture-review__close" aria-label="Close review" onClick={() => setDiscarding(true)}><svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="m4 4 8 8M12 4l-8 8" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg></button>
    </header>
    <div className="capture-sequence__preview capture-review__canvas" aria-label="Long screenshot preview" aria-busy={preparing}>
      {longImage ? <img src={longImage.dataUrl} alt="Scrolling capture preview" style={{ maxWidth: longImage.width }} /> : <p role="status">{preparing ? 'Preparing preview…' : 'Preview could not be composed. Adjust the last frame or retake the screenshot.'}</p>}
    </div>
    {issue || snapshot.issue ? <Notice className="capture-sequence__issue" messageRole="status" tone="warning" density="compact"><p>{issue ?? snapshot.issue}</p></Notice> : null}
    <footer className="capture-review__footer" inert={discarding}>
      <div className="capture-review__secondary">
        <button className="capture-review__text-button" disabled={busy || preparing} onClick={() => void action(() => api.retake(input.requestId))}>Retake</button>
        <details className="capture-review__adjust"><summary>Adjust frames</summary><div>
          {snapshot.state === 'ready' ? <button disabled={busy || preparing} onClick={() => void action(async () => { merge(await api.start(input.requestId, 2)) })}>Start scrolling capture</button> : null}
          <button disabled={busy || preparing} onClick={() => void action(sample)}>Capture next</button>
          <button disabled={busy || preparing || frames.length < 2} onClick={() => void action(async () => { merge(await api.undo(input.requestId)) })}>Undo last frame</button>
        </div></details>
      </div>
      <button className="primary-button capture-review__confirm" disabled={busy || preparing || !longImage} onClick={() => void action(async () => { await api.finishScroll(input.requestId, longImage!) })}>{busy ? 'Working…' : 'Confirm'}</button>
    </footer>
    {discarding ? <section role="alertdialog" aria-modal="true" aria-labelledby="capture-discard-title" aria-describedby="capture-discard-description" className="capture-review__discard">
      <h2 id="capture-discard-title">Discard this screenshot?</h2><p id="capture-discard-description">It has not been confirmed yet.</p>
      <div><button disabled={busy} onClick={() => void action(() => api.cancel(input.requestId))}>Discard</button><button ref={keepReview} onClick={() => setDiscarding(false)}>Continue review</button></div>
    </section> : null}
  </main>
  return <main className={`capture-sequence${gif ? ' capture-sequence--gif' : ''}${recording ? ' capture-sequence--recording' : ''}`} >
    <header><div><h1>{gif ? 'Record GIF' : 'Scrolling screenshot'}</h1><p>{gif ? 'Record the selected region, then review and mark keyframes.' : 'Scroll the source yourself, leaving an overlap between captures.'}</p></div>
      <button type="button" onClick={() => void api.cancel(input.requestId)}>Close</button></header>
    <div className="capture-sequence__controls">
      {<>{snapshot.state === 'ready' ? <><label>Sampling <select value={fps} disabled={busy} onChange={e => setFps(Number(e.target.value))}>{[2, 5, 10].map(v => <option key={v} value={v}>{v} fps</option>)}</select></label><button className="primary-button" disabled={busy} onClick={() => void action(async () => { originalGif.current = null; setKeyframes([]); setIndex(0); merge(await api.start(input.requestId, fps)) })}>Start recording</button></> : recording ? <button className="primary-button" disabled={snapshot.state === 'stopping'} onClick={() => void action(async () => { merge(await api.stop(input.requestId)); setPlaying(false) })}>{snapshot.state === 'stopping' ? 'Finishing frame…' : 'Stop recording'}</button> : <span>Ready to review</span>}
        <button disabled={busy || recording} onClick={() => void action(async () => {
          const bytes = await api.openGif(input.requestId); if (!bytes) return
          const info = inspectGif(bytes), decoded = await decodeGif(bytes)
          originalGif.current = bytes; setKeyframes(info.metadata?.keyframes ?? []); setIndex(0); setPlaying(false)
          setSnapshot(old => ({ ...old, state: 'review', frames: decoded }))
        })}>Open GIF…</button></>}
      <span className="capture-sequence__count" role="status">{recording ? '● ' : ''}{frames.length} {frames.length === 1 ? 'frame' : 'frames'}{busy && progress ? ` · Encoding ${progress}/${frames.length}` : ''}</span>
    </div>
    <div className="capture-sequence__body">
      <div className="capture-sequence__preview">{(longImage ?? frame?.image) ? <img src={(longImage ?? frame!.image).dataUrl} alt={gif ? `Frame ${index + 1}` : 'Scrolling capture preview'} /> : <p>Waiting for the first frame…</p>}</div>
      {gif && snapshot.state === 'review' && frames.length > 0 ? <aside aria-label="Keyframe notes"><div className="capture-sequence__note-heading"><h2>Keyframes</h2>
        <button disabled={busy} aria-pressed={!!keyframe} onClick={() => { setPlaying(false); setKeyframes(old => keyframe ? old.filter(k => k.frameIndex !== index) : [...old, { frameIndex: index, note: '' }].sort((a, b) => a.frameIndex - b.frameIndex)) }}>{keyframe ? 'Remove keyframe' : 'Mark current frame'}</button></div><div className="capture-sequence__notes-body"><div className="capture-sequence__note-editor">
        {keyframe ? <label>Note for frame {index + 1}<textarea value={keyframe.note} disabled={busy} placeholder="What should the viewer notice?" onChange={e => setKeyframes(old => old.map(k => k.frameIndex === index ? { ...k, note: e.target.value } : k))} /></label> : <p>Pause on a frame to add a note.</p>}
        </div><div className="capture-sequence__marked-list"><h3>Marked frames</h3><nav aria-label="Marked frames">{keyframes.map(k => <button key={k.frameIndex} onClick={() => select(k.frameIndex)} aria-current={k.frameIndex === index ? 'true' : undefined}><strong>Frame {k.frameIndex + 1}</strong><span>{k.note || 'No note yet'}</span></button>)}</nav></div></div>
        <p className="capture-sequence__hint">Frame numbers and notes travel inside the GIF file.</p>
      </aside> : null}
    </div>
    {gif && snapshot.state === 'review' && frames.length > 0 ? <footer>
      <div className="capture-sequence__playback"><button disabled={busy} onClick={() => setPlaying(v => !v)}>{playing ? 'Pause' : 'Play'}</button><button disabled={busy || index <= 0} aria-label="Previous frame" onClick={() => select(index - 1)}>‹</button><div className="capture-sequence__track"><input type="range" aria-label="Current frame" min={0} max={frames.length - 1} value={index} disabled={busy} onChange={e => select(Number(e.target.value))} /><div className="capture-sequence__markers">{keyframes.map(k => <button key={k.frameIndex} aria-label={`Go to keyframe ${k.frameIndex + 1}`} title={`Frame ${k.frameIndex + 1}: ${k.note}`} style={{ left: `${frames.length > 1 ? k.frameIndex / (frames.length - 1) * 100 : 0}%` }} onClick={() => select(k.frameIndex)} />)}</div></div><button aria-label="Next frame" disabled={busy || index >= frames.length - 1} onClick={() => select(index + 1)}>›</button><output>{index + 1} / {frames.length} · {(time / 1000).toFixed(2)} s</output></div>
      <div className="capture-sequence__export"><button disabled={busy} onClick={() => void action(async () => { const result = await api.saveGif(input.requestId, await encode()); if (result.status === 'saved') setIssue('GIF saved with keyframe notes.') })}>Save GIF…</button><button className="primary-button" disabled={busy} onClick={() => void action(async () => { await api.attachGif(input.requestId, await encode()) })}>Use GIF</button></div>
    </footer> : null}
    {issue || snapshot.issue ? <Notice className="capture-sequence__issue" messageRole="status" tone="warning" density="compact"><p>{issue ?? snapshot.issue}</p></Notice> : null}
  </main>
}
