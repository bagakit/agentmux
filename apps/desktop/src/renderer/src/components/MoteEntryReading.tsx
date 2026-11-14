import { useMemo } from 'react'
import { ComposerSource } from '@agentmux/client-ui/components/ComposerHost'
import { MoteConversationStart as StartScene, MoteConversationHistory } from '@agentmux/client-ui/components/MoteConversationStart'
import { MoteFirstMessage } from '@agentmux/client-ui/components/MoteFirstMessage'
import { SpaceObjectIcon } from './SpaceObjectIcon'
import { BrandIcon } from './BrandIcon'
import { topicSpaceIconTarget } from '../lib/space-object-appearance'
import { useAppStore } from '../store'
import { useLauncherState } from '../lib/launcher-state'
import { moteEntryDraftKey, type MoteHeldEntryInput } from '../lib/mote-entry-hold'
import type { MoteWorkfaceScope } from '../lib/mote-workface'

/**
 * While the original role owner is still being read, the person already sees this Mote: its portrait,
 * name and a Composer that edits the same Mote draft. Sending only holds the text on this device; the
 * workface delivers it once, through the Main it then confirms, or through the welcome's first message.
 * Nothing here can create, bind or send.
 */
export function MoteEntryReading({ scope, active, held, onHold, onRelease }: {
  scope: MoteWorkfaceScope; active: boolean
  held: MoteHeldEntryInput | null
  onHold(): void
  onRelease(): void
}) {
  const bindings = useAppStore(state => state.spaceZoneBindings)
  const iconTarget = useMemo(() => topicSpaceIconTarget(scope.workspace, scope.topic, bindings), [scope.workspace, scope.topic, bindings])
  const icon = useAppStore(state => iconTarget ? state.spaceObjectIcons[iconTarget.key] ?? null : null)
  const key = moteEntryDraftKey(scope)
  const draft = useLauncherState(state => state.drafts[key]?.prompt ?? '')
  return <StartScene name={scope.topic.title} active={active} mode="reading"
    portrait={<SpaceObjectIcon kind="mote" name={scope.topic.title} manualIcon={icon} avatarObjectKey={iconTarget?.key}
      avatarWorkspaceId={scope.workspace.id} avatarTopicId={scope.topic.id} visible={active} />}
    brand={<BrandIcon size={128} />}
    drafting={Boolean(draft.trim())}
    held={held ? <MoteFirstMessage messageId={'mote-held:' + held.operationId} prompt={held.prompt} name={scope.topic.title} stage="held"
      action={{ label: '撤回', onClick: onRelease }} /> : undefined}
    composer={<ComposerSource ownerKey={key} sourceKey="reading" value={draft} disabled={false} active={active} placeholder={held ? '接着写，下一条在这里' : '写下你想聊的事…'}
      onChange={value => useLauncherState.getState().setDraft(key, 'prompt', value)}
      {...(!held && draft.trim() ? { onSubmit: onHold } : {})} />}
    history={<MoteConversationHistory items={[]} reading onOpen={() => {}} />} />
}
