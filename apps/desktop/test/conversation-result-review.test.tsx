// @vitest-environment happy-dom
import { act } from 'react'
import { expect, it, vi } from 'vitest'
import { recordedToolEdit } from '../../../packages/core/test/fixtures/recorded-tool-edits'
import { fixturePath } from '../scripts/lib/fixture-values.mjs'
import { SessionResultReviewContent } from '../src/renderer/src/components/SessionResultReviewContent'
import { useAppStore } from '../src/renderer/src/store'
import { composerDOM, composerSession } from './helpers/composer-dom-fixture'

const dom = composerDOM()
const sessionId = 'agent-1'

it('opens the exact file from the recorded Provider edit in result review', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(window, 'agentmux')
  const git = vi.fn(async () => ({ kind: 'git-repository', hostId: 'local', repoPath: fixturePath('repo'),
    repoRelativePrefix: '', branch: 'main', changes: [] }))
  Object.defineProperty(window, 'agentmux', { configurable: true, value: { git: { status: git } } })
  const openFileDiff = vi.spyOn(useAppStore.getState(), 'openFileDiff').mockResolvedValue()
  const item = recordedToolEdit(sessionId)
  const reviewButton = () => [...dom.container.querySelectorAll<HTMLButtonElement>('.session-result-review__details-actions button')]
    .find(button => button.textContent?.trim() === 'Review changes')
  try {
    const { conversation: _source, ...withoutSource } = item
    useAppStore.setState({
      sessions: [{ ...composerSession(sessionId, 'claude'), status: { state: 'done', source: 'native-hook', observedAt: Date.now() } }],
      timelines: { [sessionId]: { revision: 1, items: [withoutSource] } }
    })
    await dom.render(<SessionResultReviewContent sessionId={sessionId} origin={{ workspaceId: 'workspace', tabGroupId: 'status-prompt-group' }} />)
    await vi.waitFor(() => expect(dom.container.querySelector('.session-result-review__hint')?.textContent).toBe('No Git changes were found in this Session workspace.'))
    expect(reviewButton()).toBeUndefined()
    await act(async () => useAppStore.setState({ timelines: { [sessionId]: { revision: 2, items: [item] } } }))
    const review = reviewButton()
    expect(review).toBeDefined()
    await act(async () => review!.click())
    expect(openFileDiff).toHaveBeenCalledExactlyOnceWith('src/answer.ts', 'workspace')
  } finally {
    openFileDiff.mockRestore()
    if (descriptor) Object.defineProperty(window, 'agentmux', descriptor)
    else Reflect.deleteProperty(window, 'agentmux')
  }
})
