import { DEFAULT_MOTE_FACE } from '@agentmux/core/mote-face'
import type { MoteAvatarSave } from '@agentmux/core/mote-avatar-write'
import { DESKTOP_FRAGMENT_KEYS } from '../../src/renderer/src/lib/desktop-user-fragments'

export function auxiliaryUserValues(workspaceId = 'original-workspace') {
  const avatar: MoteAvatarSave = { target: { workspaceId, topicId: 'original-topic', objectKey: 'original-object' },
    operationId: 'original-avatar-operation', beforeRevision: 'sha256:' + '0'.repeat(64),
    source: { origin: 'user', seriesId: 'original-series', entryId: 'original-entry', revision: 'sha256:' + '1'.repeat(64) },
    definition: { kind: 'face2d', face: DEFAULT_MOTE_FACE }, parameters: { kind: 'face2d', face: DEFAULT_MOTE_FACE },
    pngDataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ1kAAAAASUVORK5CYII=' }
  const avatarKey = DESKTOP_FRAGMENT_KEYS.moteAvatarSaveDrafts + JSON.stringify([workspaceId, avatar.target.topicId, avatar.target.objectKey])
  const launcher = JSON.stringify({ version: 0, state: { sections: { [workspaceId]: { browser: 'expanded' } },
    drafts: { 'original-launcher': { browser: 'https://example.invalid/original', note: 'Original unsaved Note', prompt: 'Original unsent prompt',
      progressDraft: { interval: '7', prompt: 'Original continuation' }, unknownUserField: 'Retain original opaque user bytes' } },
    executors: { [workspaceId]: 'original-executor' }, moteTopicId: 'original-topic' } })
  const bookmarks = JSON.stringify({ version: 1, bookmarks: [{ key: JSON.stringify(['local', 'original-retained-agent']), hostId: 'local',
    agentSessionId: 'original-retained-agent', presentationId: 'original-agent-presentation', label: 'Original protected reading',
    workspaceName: 'Original project', excerpt: 'Original protected excerpt', bounds: { x: 24, y: 32, width: 420, height: 300 } }] })
  const floating = JSON.stringify({ open: false, targetTopicId: 'original-topic', focusChatTopicId: 'original-topic', railMode: 'avatars', size: { width: 680, height: 460 } })
  const fragments = { launcher, agentBookmarks: bookmarks, moteFloating: floating,
    moteAvatarSaveDrafts: { [avatarKey]: JSON.stringify(avatar) }, globalGoalPatrolOperation: 'original-patrol-operation' }
  const legacy = { [DESKTOP_FRAGMENT_KEYS.launcher]: launcher, [DESKTOP_FRAGMENT_KEYS.agentBookmarks]: bookmarks,
    [DESKTOP_FRAGMENT_KEYS.moteFloating]: floating, [avatarKey]: JSON.stringify(avatar),
    [DESKTOP_FRAGMENT_KEYS.globalGoalPatrolOperation]: fragments.globalGoalPatrolOperation }
  return { avatar, avatarKey, fragments, legacy }
}
