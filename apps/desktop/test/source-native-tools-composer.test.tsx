// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { tmpdir } from 'node:os'
vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }))
// Native storage is production; unrelated Desktop service leaves use the existing
// preview port. Original Source tool calls below still cross the real IPC/Core chain.
await vi.hoisted(async () => {
  vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true)
  await import('../src/renderer/src/lib/api')
  vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', false)
})
import { AgentSessionComposer } from '../src/renderer/src/components/AgentSessionComposer'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { originalSourceInputOwnerKey } from '../src/renderer/src/lib/original-space-navigation'
import { sourceMemberImageRetention, sourceMemberProgress } from '../src/renderer/src/lib/source-member-tools'
import { WorkbenchUserStateStore } from '../src/main/workbench-user-state'
import { initializeLauncherState, useLauncherState, type LauncherDraft } from '../src/renderer/src/lib/launcher-state'
import { desktopUserDocument } from '../src/renderer/src/lib/desktop-user-state'
import { join } from 'node:path'
import { expandComposerInput } from '@agentmux/client-ui/composer-semantic-reference'
import { composerConfig, composerDOM, composerSession } from './helpers/composer-dom-fixture'
import { createSourceNativeMemberFixture } from './helpers/source-native-member-fixture'
import type { SpaceMountMemberTarget } from '../src/shared/space-mount'

const dom = composerDOM(), cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn()
  vi.spyOn(api.continuousProgress, 'pauseForInput').mockResolvedValue(undefined)
  vi.spyOn(api.sessions, 'notifyInputOccupation').mockResolvedValue(undefined)
})
const bytes = new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+i8egAAAAASUVORK5CYII=', 'base64'))
async function pasteImage() {
  const file = new File([bytes], 'original.png', { type: 'image/png' }), paste = new Event('paste', { bubbles: true, cancelable: true })
  Object.defineProperty(paste, 'clipboardData', { value: { types: ['Files'], files: [file], items: [{ kind: 'file', type: 'image/png', getAsFile: () => file }], getData: () => '' } })
  await act(async () => dom.container.querySelector<HTMLElement>('[aria-label="Message Agent"]')!.dispatchEvent(paste))
}
async function fixture() {
  const f = await createSourceNativeMemberFixture(cleanup), original = (await f.selected.owner.store.readMetadata('recipient'))!
  const { kind: _purpose, ...identity } = f.selected.target, target: SpaceMountMemberTarget = { hostId: 'original-progress-source', target: { ...identity, expectedRun: original.run } }
  const owner = originalSourceInputOwnerKey(target.target.runtimeId, 'recipient'), observerDraft = 'Keep the observer same SID draft'
  useAppStore.setState({ config: { ...composerConfig, messageToolInitialLayout: 'two-line' }, sessions: [composerSession('recipient')], timelines: {},
    noticeReadReceipts: {}, agentComposerDrafts: { [owner]: 'Keep the original Source draft', recipient: observerDraft }, agentSteerQueues: {} })
  vi.spyOn(api.ui, 'savePastedImage').mockResolvedValue('/private/observer/image.png')
  const observerUpload = vi.spyOn(api.ui, 'retainInputImage')
  return { ...f, original, target, owner, observerDraft, observerUpload }
}

it('a real Source Composer paste reaches the original image owner through Main and keeps the observer same SID untouched', async () => {
  const f = await fixture(), retainImage = sourceMemberImageRetention(f.main.api, f.target)
  await dom.render(<AgentSessionComposer sessionId={f.owner} source={{ target: f.target, retainImage }} visible />)
  await pasteImage()
  await vi.waitFor(() => expect(expandComposerInput(dom.draft(f.owner) ?? '').inputImages).toHaveLength(1))
  const input = expandComposerInput(dom.draft(f.owner)!), upload = input.inputImages[0]!.upload
  expect(input.text).toContain('[Selected image]'); expect(input.text).not.toContain('/private/observer/image.png')
  expect(upload).toMatchObject({ hostId: 'local', agentSessionId: 'recipient', expectedRun: f.original.run, mimeType: 'image/png', byteLength: bytes.byteLength })
  expect(await f.filesD.inspect(upload)).toMatchObject({ ...upload, status: 'uploaded' })
  expect(f.calls.filter(method => method === 'file.upload')).toHaveLength(1)
  expect(f.observerUpload).not.toHaveBeenCalled(); expect(dom.draft('recipient')).toBe(f.observerDraft)
  expect(f.selected.owner.inner.kernel.input).not.toHaveBeenCalled()
})

it('a same-SID Source Run change retains the original upload ACK but cannot insert it into the newly selected Run draft', async () => {
  const f = await fixture()
  let captured!: () => void, release!: () => void
  const started = new Promise<void>(resolve => { captured = resolve }), gate = new Promise<void>(resolve => { release = resolve })
  cleanup.push(async () => release())
  f.afterReply(async method => { if (method === 'file.upload') { captured(); await gate } })
  let delivered: Awaited<ReturnType<ReturnType<typeof sourceMemberImageRetention>>> | undefined
  const originalPort = sourceMemberImageRetention(f.main.api, f.target)
  await dom.render(<AgentSessionComposer sessionId={f.owner} source={{ target: f.target, retainImage: async (...args) => { delivered = await originalPort(...args); return delivered } }} visible />)
  await pasteImage(); await started
  const before = dom.draft(f.owner), current = (await f.selected.owner.store.readMetadata('recipient'))!
  await f.selected.owner.store.compareAndSwap(current, { ...current, run: { runId: 'new-selected-original-run' }, updatedAt: current.updatedAt + 1 })
  await f.selected.owner.inner.registry.refresh('recipient', { runId: 'new-selected-original-run' })
  const next = { ...f.target, target: { ...f.target.target, expectedRun: { runId: 'new-selected-original-run' } } }
  await dom.render(<AgentSessionComposer sessionId={f.owner} source={{ target: next, retainImage: sourceMemberImageRetention(f.main.api, next) }} visible />)
  release()
  await vi.waitFor(() => expect(delivered).toBeDefined())
  expect(delivered).toMatchObject({ observation: 'confirmed', upload: { expectedRun: f.original.run } })
  expect(dom.draft(f.owner)).toBe(before)
  expect(expandComposerInput(dom.draft(f.owner)!).inputImages).toEqual([])
  expect(f.calls.filter(method => method === 'file.upload')).toHaveLength(1)
  expect(f.observerUpload).not.toHaveBeenCalled(); expect(dom.draft('recipient')).toBe(f.observerDraft)
})

it('the real Source Automation entry uses the shared control and original Session port with a native retained request', async () => {
  const f = await fixture(), user = new WorkbenchUserStateStore(join(f.selected.owner.root, 'workbench-user-state.json'))
  vi.spyOn(api.ui, 'readWorkbenchState').mockImplementation(() => user.read())
  vi.spyOn(api.ui, 'importWorkbenchState').mockImplementation(raw => user.importIfAbsent(raw))
  vi.spyOn(api.ui, 'writeWorkbenchState').mockImplementation(raw => user.write(raw))
  vi.spyOn(api.ui, 'requestStorageFlush').mockResolvedValue(undefined)
  await initializeLauncherState()
  cleanup.push(async () => { await desktopUserDocument.persistent.flush() })
  const originalProgress = sourceMemberProgress(f.main.api, { hostId: f.target.hostId, target: f.selected.target },
    { providerId: 'codex', workspacePath: f.selected.owner.root })
  const observerCreate = vi.spyOn(api.continuousProgress, 'create'), observerList = vi.spyOn(api.continuousProgress, 'list')
  const create = originalProgress.port.create.bind(originalProgress.port)
  let retainedBeforeDispatch: unknown
  vi.spyOn(originalProgress.port, 'create').mockImplementation(async input => {
    const saved = JSON.parse(await user.read() ?? '{}'), launcher = JSON.parse(saved.desktopFragments.launcher) as { state: { drafts: Record<string, LauncherDraft> } }
    retainedBeforeDispatch = Object.values(launcher.state.drafts).find(value => value.progressRequest)?.progressRequest
    expect(retainedBeforeDispatch).toMatchObject({ kind: 'create', dispatch: 'started', input })
    return await create(input)
  })
  await dom.render(<AgentSessionComposer sessionId={f.owner} source={{ target: f.target, originalProgress }} visible />)
  const mailbox = dom.container.querySelector<HTMLElement>('.composer-mailbox')!, opened = new Event('toggle')
  Object.defineProperty(opened, 'newState', { value: 'open' })
  await act(async () => mailbox.dispatchEvent(opened))
  const entry = mailbox.querySelector<HTMLButtonElement>('[aria-label="Automation"]')
  expect(entry, 'The original Source retains its shared Automation entry without borrowing an observer Session.').not.toBeNull()
  await act(async () => entry!.click())
  const form = dom.container.querySelector<HTMLFormElement>('form[aria-label="Continuous progress setup"]')!
  expect(form).not.toBeNull()
  await act(async () => {
    const prompt = form.querySelector<HTMLTextAreaElement>('textarea')!
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(prompt, 'Continue only the original Source work')
    prompt.dispatchEvent(new Event('input', { bubbles: true }))
  })
  const submit = form.querySelector<HTMLButtonElement>('button[type="submit"]')!
  await vi.waitFor(() => expect(submit.disabled, dom.container.textContent ?? '').toBe(false))
  await act(async () => submit.click())
  await vi.waitFor(() => expect(f.selected.progress.list(), JSON.stringify({ ui: dom.container.textContent, calls: f.calls, retainedBeforeDispatch })).toHaveLength(1))
  expect(f.selected.progress.list()[0]).toMatchObject({ ...originalProgress.target, prompt: 'Continue only the original Source work' })
  expect(retainedBeforeDispatch).toBeDefined()
  await vi.waitFor(() => expect(Object.values(useLauncherState.getState().drafts).some(value => value.progressRequest)).toBe(false))
  expect(observerCreate).not.toHaveBeenCalled(); expect(observerList).not.toHaveBeenCalled()
  expect(dom.draft('recipient')).toBe(f.observerDraft); expect(dom.draft(f.owner)).toBe('Keep the original Source draft')
  expect(f.selected.owner.inner.kernel.input).not.toHaveBeenCalled(); expect(f.tick).not.toHaveBeenCalled()
})
