import { useMemo } from 'react'
import { useClientUiOwnerDocument } from '@agentmux/client-ui/overlay-host'
import { DiagramFilePreview as Diagram, type DiagramHost } from '@agentmux/editor-extensions/ui/DiagramFilePreview'
import { DrawioFilePreview as Drawio } from '@agentmux/editor-extensions/ui/DrawioFilePreview'
import { PlantUmlFilePreview as PlantUml } from '@agentmux/editor-extensions/ui/PlantUmlFilePreview'
import { api } from '../../lib/api'
import { APP_APPEARANCE_DATASET_KEY } from '../../lib/theme-contract'
import type { ComponentProps } from 'react'

/** The Desktop supplies its current theme and original isolated Main render operations. */
function useDiagramHost(): DiagramHost {
  const owner = useClientUiOwnerDocument() ?? document
  return useMemo(() => ({
    readTheme: () => owner.documentElement.dataset[APP_APPEARANCE_DATASET_KEY] === 'light' ? 'light' : 'dark',
    subscribeTheme(listener) {
      const Observer = owner.defaultView?.MutationObserver
      if (!Observer) return () => {}
      const observer = new Observer(listener)
      observer.observe(owner.documentElement, { attributes: true, attributeFilter: [`data-${APP_APPEARANCE_DATASET_KEY}`] })
      return () => observer.disconnect()
    },
    render: api.files.renderDiagram, cancel: api.files.cancelDiagram
  }), [owner])
}
export function DiagramFilePreview(props: Omit<ComponentProps<typeof Diagram>, 'host'>) {
  return <Diagram {...props} host={useDiagramHost()} />
}
export function DrawioFilePreview(props: Omit<ComponentProps<typeof Drawio>, 'host'>) {
  return <Drawio {...props} host={useDiagramHost()} />
}
export function PlantUmlFilePreview(props: Omit<ComponentProps<typeof PlantUml>, 'host'>) {
  return <PlantUml {...props} host={useDiagramHost()} />
}
