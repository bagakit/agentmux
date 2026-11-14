// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { topicSpaceIconTarget } from '../src/renderer/src/lib/space-object-appearance'
import { SpaceObjectIcon } from '../src/renderer/src/components/SpaceObjectIcon'
import { createClientUiRoot as createRoot } from './helpers/client-ui-render'
import { moteTopics, scratchWorkspace } from './fixtures/mote-workface'

const target = topicSpaceIconTarget(scratchWorkspace, moteTopics[0]!)!
const manualIcon = { kind: 'image' as const, fileName: 'a'.repeat(64) + '.png' }
let root: ReturnType<typeof createRoot>, container: HTMLDivElement

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  vi.spyOn(useAppStore.getState(), 'reportError').mockImplementation(() => {})
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

async function mount(consumers: number) {
  await act(async () => root.render(<>{Array.from({ length: consumers }, (_, index) => <SpaceObjectIcon key={index}
    kind="mote" name="Saved Mote" manualIcon={manualIcon} visible={false}
    avatarWorkspaceId={target.avatarTarget!.workspaceId} avatarTopicId={target.avatarTarget!.topicId}
    avatarObjectKey={target.avatarTarget!.objectKey} />)}</>))
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)) })
}

it('a rejected static avatar read is retried by a newly mounted consumer while the old one stays mounted', async () => {
  let attempts = 0, rejectFirst!: (cause: Error) => void
  vi.spyOn(api.scratch, 'readMoteAvatar').mockImplementationOnce(() => {
    attempts++
    return new Promise((_, reject) => { rejectFirst = reject })
  }).mockImplementation(() => {
    attempts++
    return Promise.resolve({ width: 256, height: 256, dataUrl: 'data:image/png;base64,RECOVERED' })
  })
  await mount(1)
  rejectFirst(new Error('asset temporarily unavailable'))
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)) })
  await mount(2)
  expect(attempts).toBe(2)
  const images = [...container.querySelectorAll<HTMLImageElement>('[data-space-icon-source="image"] img')]
  expect(images.some(image => image.getAttribute('src')?.includes('RECOVERED'))).toBe(true)
})
