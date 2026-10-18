import { SemanticIcon, SEMANTIC_ICON_CATALOG, type SemanticIconProps } from '@agentmux/client-ui/icons'
import { TOOLKIT_ICON_OPTIONS, findToolkitIcon, type ToolkitIconId } from '../../../../shared/toolkit-preferences'

export const toolkitIconLabels = Object.fromEntries(TOOLKIT_ICON_OPTIONS.map(option =>
  [option.value, SEMANTIC_ICON_CATALOG[option.semanticId].label])) as Record<ToolkitIconId, string>

export function ToolkitIcon({ icon, ...props }: SemanticIconProps & { icon: string }) {
  const option = findToolkitIcon(icon)
  return option ? <SemanticIcon {...props} name={option.semanticId} /> : null
}
