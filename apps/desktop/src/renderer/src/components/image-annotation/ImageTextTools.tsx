import { isSensitiveImageText } from '@agentmux/core/image-text'
import { presentError } from '@agentmux/client-ui/error-presentation'
import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import type { BrowserPng } from '../../../../shared/contracts'
import type { NativeRecognizedText } from '@agentmux/native-desktop'
import type { NormalizedRect } from '@agentmux/client-ui/image-annotation'

export type ImageTextPort = {
  unavailableReason?: string | undefined
  recognize(image: BrowserPng): Promise<NativeRecognizedText>
  copy(text: string): Promise<void>
}
export function ExplainedButton({ reason, children, onClick }: { reason?: string | undefined; children: ReactNode; onClick(): void }) {
  const id = useId()
  return <span className="image-text-tools__explain" tabIndex={reason ? 0 : undefined} aria-label={reason ? `${children}: ${reason}` : undefined} aria-describedby={reason ? id : undefined}>
    <button type="button" disabled={!!reason} aria-describedby={reason ? id : undefined} onClick={onClick}>{children}</button>
    {reason ? <span id={id} role="tooltip">{reason}</span> : null}
  </span>
}
export function ImageTextTools({ port, loaded, busy, revision, image, apply }: {
  port: ImageTextPort; loaded: boolean; busy: boolean; revision: unknown
  image(): Promise<{ image: BrowserPng; origin: { x: number; y: number } }>
  apply(rects: NormalizedRect[]): void
}) {
  const [pending, setPending] = useState(false), [message, setMessage] = useState<string | null>(null)
  const [result, setResult] = useState<{ mode: 'ocr' | 'sensitive'; text: string; lines: NativeRecognizedText['lines']; origin: { x: number; y: number }; revision: unknown } | null>(null)
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const current = useRef(revision), mounted = useRef(true); current.current = revision
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useEffect(() => { setResult(null); setSelected(new Set()); setMessage(null) }, [revision])
  const reason = port.unavailableReason || (!loaded ? 'The image is not loaded. Wait for it to finish loading, or open another image.' : busy ? 'The current image output is in progress. Wait for it to finish.' : pending ? 'Text recognition is running for this image. Wait for the result.' : undefined)
  async function scan(mode: 'ocr' | 'sensitive') {
    if (reason) return
    const version = revision
    setPending(true); setMessage(null); setResult(null)
    try {
      const input = await image(), recognized = await port.recognize(input.image)
      if (!mounted.current) return
      if (current.current !== version) { setMessage('The image changed during recognition. Run it again on the current image.'); return }
      const lines = mode === 'sensitive' ? recognized.lines.filter(line => isSensitiveImageText(line.text)) : recognized.lines
      setResult({ mode, text: lines.map(line => line.text).join('\n'), lines, origin: input.origin, revision: version })
      setSelected(new Set(lines.map((_, index) => index)))
      if (!lines.length) setMessage(mode === 'ocr' ? 'No text recognized. You can try another crop or image.' : 'No matching sensitive text found. Check the image yourself; detection can miss information.')
    } catch (error) { if (mounted.current) setMessage('Text recognition failed. ' + presentError(error) + ' You can retry; your image and editing are kept.') }
    finally { if (mounted.current) setPending(false) }
  }
  const valid = result?.revision === revision
  return <section className="image-text-tools" aria-label="Image text tools">
    <div className="image-text-tools__actions"><ExplainedButton reason={reason} onClick={() => void scan('ocr')}>Extract text</ExplainedButton><ExplainedButton reason={reason} onClick={() => void scan('sensitive')}>Find sensitive text</ExplainedButton><small>{pending ? 'Recognizing locally...' : 'On-device recognition'}</small></div>
    {message ? <p role="status">{message}</p> : null}
    {result && valid && result.lines.length ? <div className="image-text-tools__results">
      {result.mode === 'ocr' ? <><textarea aria-label="Recognized text" readOnly value={result.text} /><button type="button" onClick={() => void port.copy(result.text).then(() => setMessage('Recognized text copied.'), error => setMessage(presentError(error)))}>Copy text</button></> : <>
        <p>Select the lines to cover. Each cover includes its entire line. Detection can miss sensitive information.</p>
        <div className="image-text-tools__candidates">{result.lines.map((line, index) => <label key={index}><input type="checkbox" checked={selected.has(index)} onChange={() => setSelected(old => { const next = new Set(old); if (!next.delete(index)) next.add(index); return next })} /><span>{line.text}</span></label>)}</div>
        <ExplainedButton reason={busy ? 'Wait for the current image output to finish.' : !selected.size ? 'Select at least one line to cover.' : undefined} onClick={() => { if (current.current !== result.revision) return; apply(result.lines.filter((_, i) => selected.has(i)).map(line => ({ x: Math.max(0, line.rect.x - 2) + result.origin.x, y: Math.max(0, line.rect.y - 2) + result.origin.y, width: line.rect.width + 4, height: line.rect.height + 4 }))); }}>Cover selected lines</ExplainedButton>
      </>}
      <button type="button" aria-label="Close text results" onClick={() => setResult(null)}>Close</button>
    </div> : null}
  </section>
}
