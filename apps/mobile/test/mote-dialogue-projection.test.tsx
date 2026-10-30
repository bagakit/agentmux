import { act } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { useMoteDialogue, type MoteDialogueReader } from '@agentmux/client-ui/use-mote-dialogue'
import type { MoteDialoguePage } from '@agentmux/core/mote-dialogue'
import { button, click, deferred, mount, mounted } from './conversation-fixture'
import { fixturePath } from '../../../test/fixture-values.mjs'

const resource = { hostId: 'original-resource-host', workspaceId: 'original-workspace', workspacePath: fixturePath('dialogue-shared-projection') }
const target = { spaceId: 'original-mote', zoneId: 'original-zone', expectedResource: resource }
function page(role = 'original-role'): MoteDialoguePage {
  return { main: { target, identity: { hostId: resource.hostId, moteId: target.spaceId }, status: 'ready', roleRevision: role, current: null,
    resource: { ...resource, zoneId: target.zoneId, zonePath: resource.workspacePath, path: 'MOTE.md' }, documentRevision: 'original-file-version', issue: null },
    links: [], incarnation: 'original-journal', throughSequence: 0, next: null, sourceStatus: 'read', sourceIssue: null, coverage: 'linked-sources-only' }
}
const seen = new Map<string, ReturnType<typeof useMoteDialogue>>()
function Consumer({ name, read, active, originalTarget = target }: { name: string; read: MoteDialogueReader; active: boolean; originalTarget?: typeof target }) {
  const value = useMoteDialogue(read, originalTarget, active); seen.set(name, value)
  return <section data-reader={name}><span>{value.page?.main.roleRevision ?? 'unread'}</span><button type="button" onClick={value.refresh}>刷新 {name}</button></section>
}
afterEach(async () => {
  for (const item of mounted.splice(0)) { await act(async () => item.root.unmount()); item.element.remove() }
  document.body.replaceChildren(); seen.clear(); vi.restoreAllMocks()
})
async function wait(check: () => void) { await vi.waitFor(async () => { await act(async () => {}); check() }) }

it('shares one exact original projection with a retained hidden consumer and coalesces explicit refresh during a pending original read', async () => {
  const initial = deferred<MoteDialoguePage>(), next = deferred<MoteDialoguePage>()
  const read = vi.fn<MoteDialogueReader>().mockReturnValueOnce(initial.promise).mockReturnValueOnce(next.promise)
  const view = await mount(<><Consumer name="header" read={read} active /><Consumer name="retained-reader" read={read} active={false} /></>)
  await wait(() => expect(read).toHaveBeenCalledTimes(1))
  await click(button(view.element, '刷新 retained-reader')); await click(button(view.element, '刷新 header'))
  await act(async () => initial.resolve(page()))
  await wait(() => expect(read).toHaveBeenCalledTimes(2))
  await act(async () => next.resolve(page('new-role')))
  await wait(() => expect(seen.get('retained-reader')?.page?.main.roleRevision).toBe('new-role'))
  expect(seen.get('header')?.page).toBe(seen.get('retained-reader')?.page)
  expect(read).toHaveBeenCalledTimes(2)
})

it('isolates a new reader owner and exact resource while preserving the original owner projection after a late read', async () => {
  const old = deferred<MoteDialoguePage>(), readA = vi.fn<MoteDialogueReader>().mockReturnValue(old.promise), readB = vi.fn<MoteDialogueReader>().mockResolvedValue(page('new-owner-role'))
  const render = (read: MoteDialogueReader) => <><Consumer name="original-header" read={readA} active /><Consumer name="current-reader" read={read} active /></>
  const view = await mount(render(readA)); await view.render(render(readB))
  await wait(() => expect(seen.get('current-reader')?.page?.main.roleRevision).toBe('new-owner-role'))
  await act(async () => old.resolve(page('old-owner-role')))
  expect(seen.get('current-reader')?.page?.main.roleRevision).toBe('new-owner-role')
  expect(seen.get('original-header')?.page?.main.roleRevision).toBe('old-owner-role')
  const another = { ...target, expectedResource: { ...resource, workspacePath: fixturePath('another-original-resource') } }
  await view.render(<Consumer name="other-resource" read={readB} active={false} originalTarget={another} />)
  expect(seen.get('other-resource')?.page).toBeNull()
})
