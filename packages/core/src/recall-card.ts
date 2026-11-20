import { parseConversationLandmark } from './conversation-landmarks.js'
import type { ConversationItemRef } from './conversation.js'

/** A portable reference in Note Markdown. Opening it still requires the original route. */
export type RecallCard = { id: string; title: string; reference: ConversationItemRef; routeHostId: string }

export function recallCardHref(card: RecallCard): string {
  const point = parseConversationLandmark({ id: card.id, name: card.title, reference: card.reference, routeHostId: card.routeHostId })
  const url = new URL('amux://recall-card')
  url.pathname = '/' + encodeURIComponent(point.id)
  url.searchParams.set('record', JSON.stringify(point.reference))
  url.searchParams.set('route', point.routeHostId!)
  return url.href
}

export function readRecallCard(href: string, title: string): RecallCard | null {
  if (!href.startsWith('amux://recall-card/') || href.length > 16000) return null
  try {
    const url = new URL(href)
    if (url.hash || url.username || url.password || url.port || url.hostname !== 'recall-card' || [...url.searchParams.keys()].length !== 2) return null
    const id = decodeURIComponent(url.pathname.slice(1))
    const routeHostId = url.searchParams.get('route')
    const reference = JSON.parse(url.searchParams.get('record') ?? 'null')
    const point = parseConversationLandmark({ id, name: title, reference, routeHostId })
    return { id: point.id, title: point.name, reference: point.reference, routeHostId: point.routeHostId! }
  } catch { return null }
}

type CardBlock = {
  type?: string | undefined
  attrs?: Record<string, unknown> | undefined
  text?: string | undefined
  marks?: readonly { type?: string | undefined; attrs?: Record<string, unknown> | undefined }[] | undefined
  content?: readonly CardBlock[] | undefined
}

/** Project only explicitly marked paragraphs, keeping code and pasted lookalikes as ordinary text. */
export function recallCardBlocks(node: CardBlock): { blockId: string; card: RecallCard }[] {
  const cards: { blockId: string; card: RecallCard }[] = []
  function visit(block: CardBlock): void {
    const blockId = block.attrs?.blockId
    if (block.type === 'paragraph' && typeof blockId === 'string' && block.content?.length) {
      const fragments = block.content
      const href = fragments[0]?.marks?.find(mark => mark.type === 'link')?.attrs?.href
      if (typeof href === 'string' && href.startsWith('amux://recall-card/') &&
        fragments.every(fragment => fragment.type === 'text' && typeof fragment.text === 'string' &&
          fragment.marks?.find(mark => mark.type === 'link')?.attrs?.href === href)) {
        const card = readRecallCard(href, fragments.map(fragment => fragment.text).join(''))
        if (card) cards.push({ blockId, card })
      }
    }
    block.content?.forEach(visit)
  }
  visit(node)
  return cards
}

export function recallDailyDate(now: Date): string {
  return [String(now.getFullYear()).padStart(4, '0'), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0')].join('-')
}
