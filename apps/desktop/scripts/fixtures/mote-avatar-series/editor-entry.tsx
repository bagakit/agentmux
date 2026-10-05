import { createRoot } from 'react-dom/client'
import { useState } from 'react'
import { SpaceIconPicker } from '../../../src/renderer/src/components/SpaceIconPicker'
import { useAppStore } from '../../../src/renderer/src/store'
import { directoryIdentity } from '../../../src/shared/space-addresses'
import { SCRATCH_WORKSPACE_ID, PMO_TEAMS_TOPIC_ID, scratchTopicDirectoryName } from '../../../src/shared/scratch-topics'
import type { SpaceIconTarget } from '../../../src/renderer/src/lib/space-object-appearance'
import '../../../src/renderer/src/styles/index.css'

const workspace = new URLSearchParams(location.search).get('workspace')
if (!workspace) throw new Error('The isolated original Mote directory is required.')
const target = (topicId = PMO_TEAMS_TOPIC_ID): SpaceIconTarget => {
  const key = directoryIdentity('local', workspace + '/' + scratchTopicDirectoryName(topicId))
  return { key, kind: 'mote', name: topicId === PMO_TEAMS_TOPIC_ID ? 'Mote' : 'Second Mote',
    avatarTarget: { workspaceId: SCRATCH_WORKSPACE_ID, topicId, objectKey: key } }
}
useAppStore.setState({ spaceObjectIcons: { [target().key]: 'rocket' } })
function Scene() {
  const [current, setCurrent] = useState<SpaceIconTarget | null>(null)
  Object.assign(window, { seriesEditorFixture: {
    theme: (light: boolean) => { document.documentElement.dataset.appearance = light ? 'light' : 'dark' },
    replaceTarget: (topicId: string) => setCurrent(target(topicId)),
    facts: () => ({ currentTarget: current, originalChoices: useAppStore.getState().spaceObjectIcons }),
  } })
  return <main style={{ padding: 32 }}><button type="button" className="small-button" id="open-avatar" onClick={() => setCurrent(target())}>Change Mote avatar</button>
    <SpaceIconPicker target={current} onClose={() => setCurrent(null)} returnFocus={() => document.querySelector('#open-avatar')} />
  </main>
}
createRoot(document.getElementById('root')!).render(<Scene />)
