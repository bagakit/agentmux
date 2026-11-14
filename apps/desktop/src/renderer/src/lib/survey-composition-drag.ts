import type { ReactNode } from 'react'
import { useDraggable } from '@dnd-kit/core'
import type { AgentMuxSurveyPageReference } from '@agentmux/core/control'

/** Ephemeral UI addresses; only the original composition planner can change their topology. */
export type SurveyContentReference = { kind: 'research'; zoneId: string } | { kind: 'tab'; tabId: string } | ({ kind: 'page' } & AgentMuxSurveyPageReference)
export type SurveyCompositionDropTarget = Exclude<SurveyContentReference, { kind: 'tab' }>
export type SurveyContentDrag = { kind: 'content'; reference: SurveyContentReference; presentation?: { title: string; icon?: ReactNode } }
export type SurveyPageDrop = { kind: 'page-target'; reference: Extract<SurveyContentReference, { kind: 'page' }> }
export const surveyContentKey = (reference: SurveyContentReference) => reference.kind === 'page'
  ? JSON.stringify(['page', reference.regionId, reference.browserId]) : JSON.stringify([reference.kind, reference.kind === 'tab' ? reference.tabId : reference.zoneId])
export function useSurveyContentDrag(reference: SurveyContentReference, enabled: boolean, presentation?: SurveyContentDrag['presentation']) {
  const drag = useDraggable({ id: 'survey-content:' + surveyContentKey(reference), data: { kind: 'content', reference, ...(presentation ? { presentation } : {}) } satisfies SurveyContentDrag, disabled: !enabled })
  return { ...drag, attributes: enabled ? drag.attributes : {}, listeners: enabled ? drag.listeners : undefined }
}

export type SurveyCompositionSelectionControl = { checked: boolean; partial: boolean; toggle(checked: boolean): void }
