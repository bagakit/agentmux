import * as ContextMenu from '@radix-ui/react-context-menu'
import { useContext } from 'react'
import type { AgentProviderId } from '@agentmux/core/provider-id'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { copyTextToClipboard } from '../lib/clipboard-copy'
import { useAppStore } from '../store'
import { ExecutorIdentityContext, executorAvatarAppearance, ResolvedAgentAvatar } from './AgentAvatar'
import type { AgentNativeSourceReference } from './AgentNativeSourceControls'
import { moveAlongWorkbenchActionRow, WorkbenchActionRows } from './WorkbenchActionRows'
import type { CopyLinkAction } from './WorkbenchCopyLinkRow'

const UnknownProvider = semanticIconComponent('status.unknown')
type IdentityAction = CopyLinkAction & { native?: boolean; description?: string }

/** Read-only identity shortcuts. Core's adopted handle is not an observed candidate. */
export function AgentMenuIdentityActions({ links, session, providerId, executorId, executorLabel,
  Item, Group = ContextMenu.Group, Label = ContextMenu.Label }: {
  links: readonly CopyLinkAction[]
  session: AgentNativeSourceReference | null
  /** Provider of this Core Session, not its mutable Executor template. */
  providerId?: AgentProviderId | undefined
  executorId?: string | undefined
  executorLabel: string
  Item: typeof ContextMenu.Item
  Group?: typeof ContextMenu.Group
  Label?: typeof ContextMenu.Label
}) {
  const { config } = useContext(ExecutorIdentityContext)
  const executor = executorId ? config?.executors[executorId] : undefined
  const appearance = executorAvatarAppearance(config, executorId)
  const native = session?.nativeHandle
  const provider = providerId ?? (native?.kind === 'provider' ? native.providerId : undefined) ?? executor?.providerId
  const nativeAction: IdentityAction = {
    native: true,
    label: `Copy ${executorLabel} native Session ID`,
    description: 'The native conversation ID, separate from the AgentMux link.',
    icon: provider ? <ResolvedAgentAvatar label={executorLabel} providerId={provider} executorId={executorId} appearance={appearance} size={16} /> : <UnknownProvider size={16} />,
    async onSelect() {
      // This rejects only an unknown/wrong identity copy, never Agent control.
      // A retained adopted handle stays readable when Run/source observation is unknown.
      if (!session || (native?.kind !== 'provider' && native?.kind !== 'acp') || !native.sessionId ||
        (native.kind === 'provider' && providerId && native.providerId !== providerId)) {
        useAppStore.getState().reportError(new Error('This Agent’s native provider Session ID is not confirmed. Nothing was copied.'), {
          kind: 'indeterminate', ...(session ? { subject: session.control } : {}),
          summary: 'The Agent, original conversation and draft are kept. Check native source in Maintenance, then retry copying its native Session ID.'
        })
        return
      }
      await copyTextToClipboard(native.sessionId, error => useAppStore.getState().reportError(error, {
        kind: 'indeterminate', subject: session.control,
        summary: 'Copying this original native Session ID was not confirmed. The Agent and draft are kept; retry the same copy.'
      }))
    }
  }
  const actions = links.length > 0 ? [links[0]!, nativeAction, ...links.slice(1)] : [nativeAction]
  return <WorkbenchActionRows rows={[{ id: 'agent-identity', label: 'Copy', clusters: [actions] }]}
    Group={Group} Label={Label} labelPresentation="tooltip" itemKey={action => action.label}
    renderItem={(action: IdentityAction, attributes) => <Item {...attributes}
      className="tab-context-menu__item workbench-menu-row__item"
      data-native-session-copy={action.native ? '' : undefined}
      aria-label={action.label} aria-description={action.description} textValue={action.label}
      onSelect={() => { void action.onSelect() }} onKeyDown={moveAlongWorkbenchActionRow}>{action.icon}</Item>} />
}
