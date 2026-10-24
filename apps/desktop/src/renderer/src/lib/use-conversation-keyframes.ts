import { useEffect, useMemo, useState } from 'react'
import type { RulerRecord } from './conversation-ruler'

type Media = HTMLImageElement | HTMLVideoElement | HTMLCanvasElement
type Frame = { version: unknown; src: string }
const EMPTY = new Map<string, Frame>()
// Only authored visual content, never avatars or a second rendering of an unloaded page.
const selector = '.md-diagram-image__thumb, .md-conversation-image__thumb, [data-conversation-keyframe] video, [data-conversation-keyframe] canvas'

/** A reading surface retains tiny decoded observations, not source bytes, DOM or page owners. */
export function useConversationKeyframes(feed: HTMLElement | null, sessionId: string, active: boolean, records: readonly RulerRecord[]): ReadonlyMap<string, string> {
  const scope = useMemo(() => ({}), [feed, sessionId])
  // Weak keys preserve paint admission across a record refresh or visibility handoff without
  // retaining the original media/DOM. A new record array is not evidence of a new video frame.
  const paints = useMemo(() => new WeakMap<Media, { token: string; ready: boolean }>(), [scope])
  const sources = useMemo(() => new Map(records.flatMap(record => record.sourceKey ? [[record.sourceKey, {
    id: record.id, version: record.revision ?? ('contentParts' in record.record ? record.record.contentParts : record.record.content)
  }] as const] : [])), [records])
  const [state, setState] = useState<{ scope: object; frames: Map<string, Frame> }>({ scope, frames: EMPTY })
  const frames = state.scope === scope ? state.frames : EMPTY
  const versions = new Map([...sources.values()].map(record => [record.id, record.version]))
  const current = new Map([...frames].flatMap(([id, frame]) => versions.has(id) && versions.get(id) === frame.version ? [[id, frame.src] as const] : []))

  useEffect(() => {
    setState(previous => ({ scope, frames: new Map([...(previous.scope === scope ? previous.frames : EMPTY)]
      .filter(([id, frame]) => versions.has(id) && versions.get(id) === frame.version)) }))
    if (!active || !feed) return
    let alive = true
    const visible = new Set<Media>(), registered = new Set<Media>()
    const token = (media: Media) => JSON.stringify([media.getAttribute('src'), 'currentSrc' in media ? media.currentSrc : null,
      media.closest('[data-conversation-keyframe]')?.getAttribute('data-conversation-keyframe')])
    const source = (media: Media) => {
      const key = media.closest<HTMLElement>('[data-message-source-key]')?.dataset.messageSourceKey
      return key ? sources.get(key) : undefined
    }
    const forget = (media: Media) => {
      const record = source(media)
      if (record) setState(previous => {
        if (previous.scope !== scope || !previous.frames.has(record.id)) return previous
        const next = new Map(previous.frames); next.delete(record.id)
        return { scope, frames: next }
      })
    }
    const capture = (media: Media) => {
      if (!alive || !feed.contains(media) || feed.ownerDocument.hidden || !media.getClientRects().length ||
          media.closest('[hidden], [inert], details:not([open])')) return
      const paint = paints.get(media)
      if (!paint?.ready || paint.token !== token(media)) return
      const record = source(media)
      if (!record) return
      // Retained workfaces can belong to another Window document with different DOM constructors.
      const image = media.tagName === 'IMG' ? media as HTMLImageElement : null
      const video = media.tagName === 'VIDEO' ? media as HTMLVideoElement : null
      const width = image ? image.complete ? image.naturalWidth : 0 : video ? video.readyState >= 2 ? video.videoWidth : 0 : (media as HTMLCanvasElement).width
      const height = image ? image.naturalHeight : video ? video.videoHeight : (media as HTMLCanvasElement).height
      if (width <= 0 || height <= 0) return
      try {
        const canvas = feed.ownerDocument.createElement('canvas')
        const ratio = Math.min(1, 128 / width, 80 / height)
        canvas.width = Math.max(1, Math.round(width * ratio)); canvas.height = Math.max(1, Math.round(height * ratio))
        const context = canvas.getContext('2d')
        if (!context) return
        context.drawImage(media, 0, 0, canvas.width, canvas.height)
        const src = canvas.toDataURL('image/webp', .65)
        if (!src.startsWith('data:image/')) return
        setState(previous => {
          const next = new Map(previous.scope === scope ? previous.frames : EMPTY)
          next.set(record.id, { version: record.version, src })
          return { scope, frames: next }
        })
      } catch { /* A missing or tainted visual observation never affects the original message. */ }
    }
    const observer = new IntersectionObserver(entries => {
      for (const entry of entries) {
        const media = entry.target as Media
        if (entry.isIntersecting) { visible.add(media); capture(media) }
        else if (visible.delete(media)) capture(media)
      }
    }, { root: feed, threshold: 0 })
    const observe = (media: Media) => {
      if (registered.has(media)) return
      const currentToken = token(media), previous = paints.get(media)
      if (!previous) paints.set(media, { token: currentToken, ready: true })
      else if (previous.token !== currentToken) { paints.set(media, { token: currentToken, ready: false }); forget(media) }
      registered.add(media); observer.observe(media)
    }
    const register = (element: Element) => {
      if (element.matches(selector) && !registered.has(element as Media)) {
        observe(element as Media)
      }
      element.querySelectorAll<Media>(selector).forEach(observe)
    }
    const loaded = (event: Event) => {
      const media = event.target as Media
      if (registered.has(media)) {
        paints.set(media, { token: token(media), ready: true })
        if (visible.has(media)) capture(media)
      }
    }
    feed.addEventListener('load', loaded, true); feed.addEventListener('loadeddata', loaded, true)
    register(feed)
    const mutations = new MutationObserver(entries => {
      for (const entry of entries) {
        if (entry.type === 'attributes') {
          const target = entry.target as Element
          // A new URL/navigation invalidates the old frame; metadata alone does not prove a new paint.
          const invalidate = (media: Media) => { paints.set(media, { token: token(media), ready: false }); forget(media) }
          if (registered.has(target as Media)) invalidate(target as Media)
          else target.querySelectorAll<Media>(selector).forEach(invalidate)
        }
        for (const added of entry.addedNodes) if (added.nodeType === 1) register(added as Element)
        for (const removed of entry.removedNodes) if (removed.nodeType === 1) {
          for (const media of registered) if (removed === media || removed.contains(media)) {
            observer.unobserve(media); registered.delete(media); visible.delete(media)
          }
        }
      }
    })
    mutations.observe(feed, { subtree: true, childList: true, attributes: true, attributeFilter: ['src', 'data-conversation-keyframe'] })
    return () => { alive = false; mutations.disconnect(); observer.disconnect(); visible.clear(); registered.clear()
      feed.removeEventListener('load', loaded, true); feed.removeEventListener('loadeddata', loaded, true) }
  }, [feed, scope, active, sources])
  return current
}
