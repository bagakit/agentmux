import { useDeferredValue, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type ComponentPropsWithRef } from 'react'
import type { getMarkdownSourceHighlights } from '../lib/markdown-source-highlight.js'

export type TextareaProps = ComponentPropsWithRef<'textarea'> & {
  /** Colors Markdown source while the original textarea owns input, selection and undo. */
  syntax?: 'markdown'
}

export function Textarea({ syntax, className = '', ...props }: TextareaProps) {
  const inputClass = `ui-input ${className}`
  return syntax === 'markdown' ? <MarkdownTextarea {...props} className={inputClass} /> : <textarea {...props} className={inputClass} />
}

const textLayoutProperties = [
  'font-family', 'font-size', 'font-style', 'font-weight', 'font-stretch', 'font-variant', 'font-feature-settings',
  'font-variation-settings', 'line-height', 'letter-spacing', 'word-spacing', 'text-align', 'text-indent', 'text-transform',
  'white-space', 'overflow-wrap', 'word-break', 'tab-size', 'direction', 'unicode-bidi', 'writing-mode',
  'padding-top', 'padding-right', 'padding-bottom', 'padding-left'
] as const

function MarkdownTextarea({ ref, value, defaultValue, form, onInput, onScroll, onCompositionStart, onCompositionEnd, ...props }: ComponentPropsWithRef<'textarea'>) {
  const field = useRef<HTMLTextAreaElement>(null)
  const preview = useRef<HTMLSpanElement>(null)
  const paintedSource = useRef<string | null>(null)
  const [composing, setComposing] = useState(false)
  const [source, setSource] = useState('')
  const [highlight, setHighlight] = useState<typeof getMarkdownSourceHighlights>()
  const deferredSource = useDeferredValue(source)
  const ranges = useMemo(() => highlight?.(deferredSource) ?? [], [highlight, deferredSource])
  useImperativeHandle(ref, () => field.current!, [])

  useEffect(() => {
    let mounted = true
    void import('../lib/markdown-source-highlight.js').then(module => {
      if (mounted) setHighlight(() => module.getMarkdownSourceHighlights)
    }, () => { /* A missing decoration must leave the editable native text visible. */ })
    return () => { mounted = false }
  }, [])

  function syncText(input: HTMLTextAreaElement) {
    if (input.value !== paintedSource.current) input.removeAttribute('data-ui-markdown-painted')
    setSource(input.value)
  }

  function syncScroll(input: HTMLTextAreaElement) {
    const layer = preview.current
    if (!layer) return
    layer.scrollTop = input.scrollTop
    layer.scrollLeft = input.scrollLeft
  }

  useLayoutEffect(() => {
    const input = field.current
    const layer = preview.current
    if (!input || !layer) return
    const measure = () => {
      const style = input.ownerDocument.defaultView?.getComputedStyle(input)
      if (!style) return
      for (const property of textLayoutProperties) layer.style.setProperty(property, style.getPropertyValue(property))
      layer.style.top = `${input.offsetTop + input.clientTop}px`
      layer.style.left = `${input.offsetLeft + input.clientLeft}px`
      layer.style.width = `${input.clientWidth}px`
      layer.style.height = `${input.clientHeight}px`
      syncScroll(input)
    }
    measure()
    const resize = new ResizeObserver(measure)
    resize.observe(input)
    return () => resize.disconnect()
  }, [props.className, props.dir, props.style, props.wrap])

  useLayoutEffect(() => {
    const input = field.current
    if (input) syncText(input)
  }, [value, defaultValue])

  useEffect(() => {
    const input = field.current
    const owner = input?.form
    if (!input || !owner) return
    const readReset = () => queueMicrotask(() => { if (input.isConnected) syncText(input) })
    owner.addEventListener('reset', readReset)
    return () => owner.removeEventListener('reset', readReset)
  }, [form])

  // The browser remains the text painter whenever its live value differs from the decoration,
  // including while the platform owns the IME composition.
  useLayoutEffect(() => {
    const input = field.current
    if (!input) return
    const exact = !composing && ranges.length > 0 && input.value === deferredSource
    paintedSource.current = exact ? deferredSource : null
    input.toggleAttribute('data-ui-markdown-painted', exact)
    if (exact) syncScroll(input)
  })

  const contents = []
  let offset = 0
  for (const { start, end, kind } of ranges) {
    if (start > offset) contents.push(deferredSource.slice(offset, start))
    contents.push(<span key={start} data-markdown-token={kind}>{deferredSource.slice(start, end)}</span>)
    offset = end
  }
  if (ranges.length) contents.push(deferredSource.slice(offset))

  return <span className="ui-textarea-source">
    <textarea {...props} ref={field} value={value} defaultValue={defaultValue} form={form}
      onInput={event => { syncText(event.currentTarget); onInput?.(event) }}
      onScroll={event => { syncScroll(event.currentTarget); onScroll?.(event) }}
      onCompositionStart={event => {
        setComposing(true)
        event.currentTarget.removeAttribute('data-ui-markdown-painted')
        onCompositionStart?.(event)
      }}
      onCompositionEnd={event => {
        setComposing(false)
        syncText(event.currentTarget)
        onCompositionEnd?.(event)
      }} />
    <span className="ui-textarea-source__preview" ref={preview} aria-hidden="true" data-ui-markdown-preview
      data-trailing-line={deferredSource.endsWith('\n') || undefined}>{contents}</span>
  </span>
}
