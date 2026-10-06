import { createRoot } from 'react-dom/client'
import { useEffect, useState } from 'react'
import { SpaceIconPicker } from '../../../src/renderer/src/components/SpaceIconPicker'
import { useAppStore } from '../../../src/renderer/src/store'
import { PMO_TEAMS_TOPIC_ID } from '../../../src/shared/scratch-topics'
import type { SpaceIconTarget } from '../../../src/renderer/src/lib/space-object-appearance'
import { SpaceObjectIcon } from '../../../src/renderer/src/components/SpaceObjectIcon'
import { api } from '../../../src/renderer/src/lib/api'
import { readSpatialAppearance } from '../../../src/renderer/src/lib/mobile-presentation'
import { topicSpaceIconTarget } from '../../../src/renderer/src/lib/space-object-appearance'
import { readMoteAvatarSaveDraft } from '../../../src/renderer/src/lib/mote-avatar-save-draft'
import type { MoteAvatarTarget } from '@agentmux/core/mote-avatar-write'
import type { AgentMuxSpaceCatalog } from '@agentmux/core/control'
import '../../../src/renderer/src/styles/index.css'

const supplied = new URLSearchParams(location.search).get('targets')
if (!supplied) throw new Error('The isolated original Mote targets are required.')
const targets = JSON.parse(supplied) as Record<string, SpaceIconTarget>
const target = (topicId = PMO_TEAMS_TOPIC_ID) => {
  const original = targets[topicId]
  if (!original) throw new Error('The original fixture target is unavailable.')
  return original
}
function Scene() {
  const [current, setCurrent] = useState<SpaceIconTarget | null>(null)
  const [ready, setReady] = useState(false)
  const [pickerMounted, setPickerMounted] = useState(true)
  const choices = useAppStore(state => state.spaceObjectIcons)
  useEffect(() => {
    let live = true
    const release = api.config.onChange(config => { if (live) useAppStore.getState().setConfig(config) })
    void api.config.get().then(config => { if (live) { useAppStore.getState().setConfig(config); setReady(true) } })
    return () => { live = false; release() }
  }, [])
  Object.assign(window, { seriesEditorFixture: {
    theme: (light: boolean) => { document.documentElement.dataset.appearance = light ? 'light' : 'dark' },
    replaceTarget: (topicId: string) => setCurrent(target(topicId)),
    mountPicker: (mounted: boolean) => setPickerMounted(mounted),
    keptRequest: (original: MoteAvatarTarget) => readMoteAvatarSaveDraft(original),
    facts: () => ({ ready, currentTarget: current, originalChoices: useAppStore.getState().spaceObjectIcons }),
    mobileAppearance: async (withImage: boolean) => {
      const state = useAppStore.getState(), workspace = state.config?.workspaces.find(value => value.id === target().avatarTarget!.workspaceId)
      if (!workspace) throw new Error('The original fixture workspace is unavailable.')
      const original = await api.scratch.listTopics(workspace.id)
      const spaces = original.flatMap(topic => {
        const selected = topicSpaceIconTarget(workspace, topic, state.spaceZoneBindings)
        return selected ? [{ spaceId: selected.key, kind: selected.avatarTarget ? 'mote' as const : 'topic' as const, name: selected.name, hostId: workspace.hostId,
          directoryPath: topic.physicalDirectoryPath ?? topic.identityDirectoryPath!, projectId: null, topicId: topic.id }] : []
      })
      const catalog: AgentMuxSpaceCatalog = { spaces, zones: [], tabs: [], regions: [], bindings: [], locations: [] }
      return await readSpatialAppearance(state, catalog, withImage ? target().key : undefined, original,
        (selected, image) => api.scratch.readMoteAvatar(selected.workspaceId, selected.topicId, image, selected.objectKey))
    },
  } })
  return <main style={{ padding: 32 }}><button type="button" className="small-button" id="open-avatar" disabled={!ready} onClick={() => setCurrent(target())}>Change Mote avatar</button>
    <div id="saved-identities" style={{ display: 'flex', gap: 28, alignItems: 'center', marginTop: 24 }} aria-label="Original Mote avatar sizes">{[24, 34, 48, 104].map(size => <div key={size} data-saved-size={size}
      style={{ width: size, height: size, '--rail-icon': `${size}px` } as import('react').CSSProperties}>
      <SpaceObjectIcon kind="mote" name="Mote" manualIcon={choices[target().key] ?? null} avatarWorkspaceId={target().avatarTarget!.workspaceId} avatarTopicId={target().avatarTarget!.topicId} avatarObjectKey={target().key} />
    </div>)}</div>
    {pickerMounted ? <SpaceIconPicker target={current} onClose={() => setCurrent(null)} returnFocus={() => document.querySelector('#open-avatar')} /> : null}
  </main>
}
createRoot(document.getElementById('root')!).render(<Scene />)
