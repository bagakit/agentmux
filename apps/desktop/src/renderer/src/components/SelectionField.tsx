import { useMemo } from 'react'
import { ClientUiOverlayProvider } from '@agentmux/client-ui/overlay-host'
import { SelectionField as SharedSelectionField, type SelectionFieldProps } from '@agentmux/client-ui/components/SelectionField'
import { useWorkbenchDocument } from '../lib/workbench-document'
import { resolveOverlayContainer } from './WindowOverlayHost'

export type { SelectionOption } from '@agentmux/client-ui/components/SelectionField'

/** A Desktop selection belongs to its original workbench window and attached dialog. */
export function SelectionField(props: SelectionFieldProps) {
  const document = useWorkbenchDocument()
  const host = useMemo(() => ({ ownerDocument: document, overlayContainer: () => resolveOverlayContainer(undefined, document) }), [document])
  return <ClientUiOverlayProvider host={host}><SharedSelectionField {...props} /></ClientUiOverlayProvider>
}
