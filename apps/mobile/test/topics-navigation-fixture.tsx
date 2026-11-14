import { useCallback, useLayoutEffect, useRef } from 'react'
import { MobileTopicsSurface, type MobileTopicsSurfaceProps } from '../src/topics/MobileTopicsSurface'
import { MobileTopicKnowledge, type MobileTopicKnowledgeProps } from '../src/topics/MobileTopicKnowledge'
import { useTopicsNavigation } from '../src/topics/use-topics-navigation'
import type { TopicsNavigationController, TopicsNavigationIntent, TopicsNavigationObservation } from '../src/topics/topics-navigation'
import type { MobileKnowledgeReference, MobileTopicsRoute } from '../src/recovery/presentation-route'

type Observation = { initialRoute?: MobileTopicsRoute; onController?(value: TopicsNavigationController): void;
  onProjection?(value: MobileTopicsRoute): void; onIntent?(value: TopicsNavigationIntent): void; onObservation?(value: TopicsNavigationObservation): void }
function useObservedNavigation(client: MobileTopicsSurfaceProps['client'], { initialRoute, onController, onProjection, onIntent, onObservation }: Observation) {
  const navigation = useTopicsNavigation(initialRoute, client)
  const callbacks = useRef({ onController, onProjection, onIntent, onObservation }); callbacks.current = { onController, onProjection, onIntent, onObservation }
  const send = useCallback((intent: TopicsNavigationIntent) => { callbacks.current.onIntent?.(intent); navigation.send(intent) }, [navigation.send])
  const observe = useCallback((value: TopicsNavigationObservation) => { callbacks.current.onObservation?.(value); navigation.observe(value) }, [navigation.observe])
  const observed = { ...navigation, send, observe }
  onController?.(observed)
  const bytes = JSON.stringify(navigation.route)
  useLayoutEffect(() => { callbacks.current.onProjection?.(navigation.route) }, [bytes])
  return observed
}
/** Test observation only: the product hook owns every transition and persistent projection. */
export function TopicsTestSurface({ initialRoute, onController, onProjection, onIntent, onObservation, ...props }: Omit<MobileTopicsSurfaceProps, 'navigation'> & Observation) {
  const navigation = useObservedNavigation(props.client, { ...(initialRoute ? { initialRoute } : {}), ...(onController ? { onController } : {}), ...(onProjection ? { onProjection } : {}), ...(onIntent ? { onIntent } : {}), ...(onObservation ? { onObservation } : {}) })
  return <MobileTopicsSurface {...props} navigation={navigation} />
}
export function KnowledgeTestSurface({ initialPosition, scopeTopicId = null, onController, onProjection, onIntent, onObservation, ...props }:
  Omit<MobileTopicKnowledgeProps, 'navigation' | 'scopeTopicId'> & Omit<Observation, 'initialRoute'> & { scopeTopicId?: string | null; initialPosition?: MobileKnowledgeReference }) {
  const initialRoute: MobileTopicsRoute = { context: { categoryId: null, topicId: scopeTopicId, mode: 'knowledge' }, sources: [], ...(initialPosition ? { knowledge: initialPosition } : {}) }
  const navigation = useObservedNavigation(props.client, { initialRoute, ...(onController ? { onController } : {}), ...(onProjection ? { onProjection } : {}), ...(onIntent ? { onIntent } : {}), ...(onObservation ? { onObservation } : {}) })
  return <MobileTopicKnowledge {...props} scopeTopicId={scopeTopicId} navigation={navigation} />
}
export const topicIntents = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls.map(([value]) => value as TopicsNavigationIntent).filter(value => value.type === 'topic')
