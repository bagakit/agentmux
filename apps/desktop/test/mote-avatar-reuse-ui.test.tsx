// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { DEFAULT_MOTE_FACE } from '@agentmux/core/mote-face'
import { moteBotUi } from './fixtures/mote-bot-ui'
import { imageInput } from './fixtures/mote-identity-image'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import type { SpaceIconChoice } from '../src/shared/space-object-appearance'

let f: Awaited<ReturnType<typeof moteBotUi>> | undefined
afterEach(async () => { await f?.close(); f = undefined })
async function open(choice: SpaceIconChoice | null, renderAvatar = async (_svg: string) => ({ dataUrl: imageInput().dataUrl, width: 256, height: 256 })) {
  f = await moteBotUi({ avatarChoice: choice, renderAvatar })
  vi.spyOn(api.scratch, 'listTopics').mockImplementation(async () => f!.topics.list(f!.workspace))
  await act(async () => { await useAppStore.getState().refreshScratchTopics(f!.workspace.id, true) })
  await f.render(0, true)
  await vi.waitFor(async () => { await f!.settle(); expect(document.querySelector('[data-mote-card-action="create"]')).not.toBeNull() })
  return document.querySelector<HTMLElement>(`[data-mote-identity="${f.scopes[0]!.topic.id}"]`)!
}

it.each([null, { ...DEFAULT_MOTE_FACE, palette: 'rose' }] as Array<SpaceIconChoice | null>)(
  'starts the original setup for current Mote appearance %j without preparing or saving another avatar', async choice => {
    const card = await open(choice)
    await act(async () => card.querySelector<HTMLButtonElement>('[data-mote-card-action="create"]')!.click())
    await vi.waitFor(async () => { await f!.settle(); expect(f!.beginCount).toBe(1) }, { timeout: 3500 })
    expect(document.body.textContent).not.toContain('Prepare avatar')
    expect(document.querySelector('.space-icon-picker')).toBeNull()
    const input = f!.parentCalls.mock.calls.find(([method]) => method === 'space.mote.connection.create')![1] as any
    expect(input.source.target).toEqual(f!.target()); expect(input.desired.avatar.pngDataUrl).toBe(imageInput().dataUrl)
    expect(input.source.preparedFrom.avatarRevision).toMatch(/^sha256:[a-f0-9]{64}$/)
    const operation = (await f!.client.call('space.mote.connection.inspect', { operationId: input.operationId })).operation!
    expect(operation.snapshot.avatarSha256).toMatch(/^[a-f0-9]{64}$/)
    const read = await f!.client.call('space.mote.avatar.read', { target: { workspaceId: f!.workspace.id, topicId: f!.motes[0]!.id, objectKey: f!.target().spaceId } })
    expect(read.choice).toEqual(choice); expect(read.revision).toBe(input.source.preparedFrom.avatarRevision)
    expect(f!.creationCount).toBe(0)
  }
)

it('reports the exact export failure and refreshes the same profile without asking the user to replace its avatar', async () => {
  const render = vi.fn(async (_svg: string) => ({ dataUrl: imageInput().dataUrl, width: 256, height: 256 }))
  render.mockRejectedValue(Error('Original vector export unavailable'))
  const card = await open('rocket', render)
  await act(async () => card.querySelector<HTMLButtonElement>('.connector-mote-card__identity')!.click())
  await vi.waitFor(async () => { await f!.settle(); expect(document.body.textContent).toContain('Original vector export unavailable') })
  expect(document.body.textContent).not.toContain('Prepare avatar')
  expect(document.querySelector<HTMLButtonElement>('[data-mote-bot-create]')!.disabled).toBe(true)
  expect(f!.beginCount).toBe(0)
  render.mockResolvedValue({ dataUrl: imageInput().dataUrl, width: 256, height: 256 })
  await f!.click('Refresh saved profile')
  await vi.waitFor(async () => { await f!.settle(); expect(document.querySelector<HTMLButtonElement>('[data-mote-bot-create]')!.disabled).toBe(false) })
  expect(document.body.textContent).not.toContain('Original vector export unavailable')
})
