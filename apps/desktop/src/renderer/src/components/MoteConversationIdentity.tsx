import { useMoteDialogueView } from '../lib/mote-dialogue-view'
import type { MoteWorkfaceScope } from '../lib/mote-workface'
import { topicSpaceIconTarget } from '../lib/space-object-appearance'
import { useAppStore } from '../store'
import { SpaceObjectIcon } from './SpaceObjectIcon'
import { MoteHeartbeatLamp } from './MoteHeartbeatLamp'

/** The Mote's own saved identity, outside the changing conversation body. */
export function MoteConversationIdentity({ scope, visible }: { scope: MoteWorkfaceScope; visible: boolean }) {
  const bindings = useAppStore(state => state.spaceZoneBindings)
  const target = topicSpaceIconTarget(scope.workspace, scope.topic, bindings)
  const appearance = useAppStore(state => target ? state.spaceObjectIcons[target.key] ?? null : null)
  const dialogue = useMoteDialogueView(), main = dialogue?.page?.main
  const confirmed = main?.status === 'ready' && !dialogue?.unavailable &&
    main.identity?.hostId === scope.workspace.hostId && main.identity.moteId === scope.topic.id
  const current = visible && confirmed ? main.current : null
  const name = target?.name ?? scope.topic.title
  return <><div className="mote-conversation-identity" data-mote-conversation-identity={scope.topic.id}>
    <span className="mote-conversation-identity__avatar">
      <SpaceObjectIcon kind="mote" name={name} manualIcon={appearance}
        avatarWorkspaceId={target?.avatarTarget?.workspaceId} avatarTopicId={target?.avatarTarget?.topicId} avatarObjectKey={target?.avatarTarget?.objectKey}
        visible={visible} moteSessionId={current?.sessionId} moteHostId={current?.hostId}
        moteAvailability={!visible ? 'static' : confirmed && !current ? 'no-agent' : 'restoring'} />
    </span>
    <span className="mote-conversation-identity__name mote-space-frame__name" title={name}>{name}</span>
  </div><MoteHeartbeatLamp key={JSON.stringify([scope.workspace.hostId, scope.topic.id, scope.rootPath])} scope={scope} visible={visible} /></>
}
