import { useLayoutEffect, type ReactNode } from 'react'
import { useDndContext } from '@dnd-kit/core'
import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import type { AgentMuxSurveyPageReference as Page } from '@agentmux/core/control'
import { surveyPageOrderKey, type SurveyPageOrderDrop } from '../lib/survey-page-order'

const DragIcon = semanticIconComponent('action.drag')
/** The grip reorders references. The original page body remains a separate composition drag source. */
export function SortableSurveyPage({ page, order, title, enabled, children }: {
  page: Page; order: readonly Page[]; title: string; enabled: boolean; children(handle: ReactNode): ReactNode
}) {
  const { setNodeRef, attributes, listeners, transform, transition, isDragging, index, node } = useSortable({ id: surveyPageOrderKey(page),
    data: { kind: 'page-order', reference: page, order } satisfies SurveyPageOrderDrop, disabled: !enabled })
  // A keyboard drop keeps the original grip focused; reveal its row after the order commits.
  useLayoutEffect(() => {
    const element = node.current
    if (!element?.contains(document.activeElement)) return
    const frame = requestAnimationFrame(() => {
      if (element.contains(document.activeElement)) element.scrollIntoView({ block: 'nearest' })
    })
    return () => cancelAnimationFrame(frame)
  }, [index, node])
  const { active, over } = useDndContext(), from = active?.data.current as SurveyPageOrderDrop | undefined
  const edge = from?.kind === 'page-order' && over?.id === surveyPageOrderKey(page) && active?.id !== over.id
    ? from.order.findIndex(member => surveyPageOrderKey(member) === surveyPageOrderKey(from.reference)) < order.findIndex(member => surveyPageOrderKey(member) === surveyPageOrderKey(page)) ? 'after' : 'before' : undefined
  return <div ref={setNodeRef} className="survey-list-item survey-sortable-page" data-sort-edge={edge} data-dragging={isDragging || undefined}
    data-survey-page-order={page.regionId} style={{ transform: CSS.Translate.toString(transform), transition }}>
    {children(<button type="button" className="survey-drag-handle" {...attributes} {...listeners} aria-label={`Reorder survey page: ${title}`} title="Drag to reorder page"><DragIcon size={12} /></button>)}
  </div>
}
