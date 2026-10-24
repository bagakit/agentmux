import { act, createRef } from 'react'
import { Blob as NodeBlob } from 'node:buffer'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { MobileApp } from '../src/MobileApp'
import { MobileConversationSurface } from '../src/conversation/MobileConversationSurface'
import { MobileAttachments, type MobileAttachmentControls } from '../src/conversation/MobileAttachments'
import { fileUploadRevision } from '@agentmux/core/files'
import { MobileWebUpdateSafetyProvider, useMobileWebUpdateSafety } from '../src/mobile-web/update-safety'
import { nativeDevicePorts } from '../src/platform/native/device'
import { createBrowserPlatform } from '../src/platform/browser'
import { emptyDeviceWorkface, getDeviceWorkface } from '../src/recovery/device-workface'
import { button, click, deferred, editor, fixture, mount, mounted, paste } from './conversation-fixture'

let apply: ReturnType<typeof useMobileWebUpdateSafety>['apply']
function Action() { apply = useMobileWebUpdateSafety().apply; return null }
const verifyConnection = async () => () => true
const picker = nativeDevicePorts.filePicker
const connected = { state: 'connected' as const, message: '原连接' }
const platform = createBrowserPlatform()
function originalFixture() {
  const f = fixture()
  Object.assign(f.client, { runtimeOwnerIdentity: () => ({ runtimeId: 'runtime-original' }),
    subscribeRpc: vi.fn().mockResolvedValue({ subscriptionId: 'appearance', dispose: async () => {} }),
    forwardRpc: vi.fn().mockImplementation(async (method: string) => {
      if (method === 'space.ls') return { catalog: { spaces: [], zones: [], tabs: [], regions: [], bindings: [], locations: [],
        agentPresentation: [{ agentSessionId: 'session-original', name: '原 Agent', project: '原项目', group: 'working', state: 'working', detail: '执行中', providerId: 'codex' }] } }
      if (method === 'app.snapshot') return { agents: [] }
      if (method === 'agent.inspect') return { session: f.client.agentSession('session-original'), displayName: { override: null, availability: 'observed' } }
      throw new Error('Observation unavailable: ' + method)
    }) })
  return f
}
async function pasteFiles(container: HTMLElement, files: any[]) {
  await act(async () => {
    const event = new MouseEvent('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'clipboardData', { value: { items: files.map(file => ({ kind: 'file', type: file.type ?? '', getAsFile: () => file })), getData: () => '' } })
    editor(container).dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
  })
}
function file(name: string, body = 'data') { return Object.assign(new NodeBlob([body], { type: 'image/png' }), { name }) }
beforeEach(async () => {
  localStorage.clear(); await getDeviceWorkface().replaceBackup(emptyDeviceWorkface())
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, url: location.origin + '/mobile/new-build/' + 'a'.repeat(64) + '/index.html' })))
})
afterEach(async () => {
  for (const item of mounted.splice(0)) { await act(async () => item.root.unmount()); item.element.remove() }
  nativeDevicePorts.filePicker = picker; vi.restoreAllMocks(); vi.unstubAllGlobals()
})

it('cancels repeated never-returning native pickers in the real App, preserves the draft and fences each late result', async () => {
  const f = originalFixture(), first = deferred<any>(), second = deferred<any>()
  nativeDevicePorts.filePicker = { pickFiles: vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise) } as any
  await getDeviceWorkface().updateNavigation({ selectedSessionId: 'session-original', hostUrl: '', panel: 'conversation' })
  const view = await mount(<MobileWebUpdateSafetyProvider verifyConnection={verifyConnection}><Action /><MobileApp client={f.client} connection={connected} platform={platform} /></MobileWebUpdateSafetyProvider>)
  await paste(view.element, '原正文')
  for (let i = 0; i < 2; i++) {
    await click(button(view.element, 'Reference files for the Agent to read'))
    expect(await apply()).toMatchObject({ status: 'blocked', message: expect.stringContaining('附件') })
    await click(button(view.element, '取消本次选择'))
    expect(await apply()).toEqual({ status: 'navigating' })
  }
  await act(async () => { first.resolve({ files: [{ name: 'old.png', mimeType: 'image/png', size: 4, blob: file('old.png') }] }); second.resolve({ files: [] }) })
  expect(view.element.querySelector('.mobile-attachment')).toBeNull()
  expect(editor(view.element).textContent).toBe('原正文')
  expect(f.submit).not.toHaveBeenCalled()
  expect(vi.mocked(f.client.forwardRpc!).mock.calls.some(call => call[0] === 'file.upload')).toBe(false)
  expect(await apply()).toEqual({ status: 'navigating' })
})

it('explicitly sends only the body while the original picker remains pending and adopts a later selection separately', async () => {
  const f = originalFixture(), gate = deferred<any>()
  nativeDevicePorts.filePicker = { pickFiles: vi.fn().mockReturnValue(gate.promise) } as any
  const view = await mount(<MobileWebUpdateSafetyProvider verifyConnection={verifyConnection}><Action /><MobileConversationSurface client={f.client} agentSessionId="session-original" connection={connected} platform={platform} /></MobileWebUpdateSafetyProvider>)
  await paste(view.element, '仅此正文'); await click(button(view.element, 'Reference files for the Agent to read'))
  await click(button(view.element, 'Send'))
  await vi.waitFor(() => expect(view.element.textContent).toContain('所选附件仍在读取'))
  expect(f.submit).not.toHaveBeenCalled()
  await click(button(view.element, '本次仅发送正文'))
  await vi.waitFor(() => expect(f.submit).toHaveBeenCalledOnce())
  expect(f.submit.mock.calls[0]![0].prompt).toBe('仅此正文')
  await act(async () => { gate.resolve({ files: [{ name: 'after.png', mimeType: 'image/png', size: 4, blob: file('after.png') }] }) })
  await vi.waitFor(() => expect(view.element.querySelector('.mobile-attachment')?.textContent).toContain('after.png'))
  expect(f.submit).toHaveBeenCalledOnce()
  expect(vi.mocked(f.client.forwardRpc!).mock.calls.some(call => call[0] === 'file.upload')).toBe(false)
})

it('never adopts a late custom picker result after explicit cancellation', async () => {
  const f = originalFixture(), gate = deferred<any>(), controls = createRef<MobileAttachmentControls>()
  const view = await mount(<MobileWebUpdateSafetyProvider verifyConnection={verifyConnection}><Action /><MobileAttachments client={f.client} session={f.sessions.get('session-original')!} connected
    promptOperationId={null} confirmedPrompt={null} controls={controls} insert={async () => {}} pickFile={() => gate.promise} /></MobileWebUpdateSafetyProvider>)
  let choosing!: Promise<void>
  await act(async () => { choosing = controls.current!.choose() })
  await click(button(view.element, '取消本次选择'))
  let completed = false
  void choosing.then(() => { completed = true })
  await vi.waitFor(() => expect(completed).toBe(true), { timeout: 500 })
  const bytes = Buffer.from('data')
  await act(async () => { gate.resolve({ id: 'late', name: 'late.png', mimeType: 'image/png', size: bytes.length, revision: fileUploadRevision(bytes), dataBase64: bytes.toString('base64') }) })
  expect(view.element.querySelector('.mobile-attachment')).toBeNull()
  expect(await apply()).toEqual({ status: 'navigating' })
})

it('keeps queue order when cancelling a middle read and releases the next batch only after the first is cancelled', async () => {
  const f = originalFixture(), first = deferred<void>(), firstCancel = deferred<void>()
  const slow = { name: 'first.png', type: 'image/png', size: 4, stream: () => new ReadableStream<Uint8Array>({
    async start(controller) { await first.promise; controller.enqueue(new Uint8Array([1, 2, 3, 4])); controller.close() },
    cancel() { return firstCancel.promise }
  }) }
  const view = await mount(<MobileWebUpdateSafetyProvider verifyConnection={verifyConnection}><Action /><MobileConversationSurface client={f.client} agentSessionId="session-original" connection={connected} platform={platform} /></MobileWebUpdateSafetyProvider>)
  await paste(view.element, '原正文'); await pasteFiles(view.element, [slow]); await pasteFiles(view.element, [file('middle.png')]); await pasteFiles(view.element, [file('last.png')])
  const row = (name: string) => [...view.element.querySelectorAll('.mobile-attachment-pending')].find(item => item.textContent?.includes(name))!
  await click(button(row('middle.png') as HTMLElement, '取消本次读取'))
  await act(async () => {})
  expect(view.element.querySelector('.mobile-attachment')).toBeNull()
  await click(button(row('first.png') as HTMLElement, '取消本次读取'))
  await vi.waitFor(() => expect(view.element.querySelector('.mobile-attachment')?.textContent).toContain('last.png'))
  expect(view.element.textContent).not.toContain('middle.png')
  await act(async () => { first.resolve(); firstCancel.resolve() })
  expect(view.element.querySelectorAll('.mobile-attachment')).toHaveLength(1)
  expect(editor(view.element).textContent).toBe('原正文'); expect(f.submit).not.toHaveBeenCalled()
  await click(button(view.element, '移除 last.png 本地引用'))
  expect(await apply()).toEqual({ status: 'navigating' })
})

it('removes a real browser chooser only on explicit cancellation and ignores its late change after returning to the original conversation', async () => {
  const f = originalFixture()
  vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => {})
  await getDeviceWorkface().updateNavigation({ selectedSessionId: 'session-original', hostUrl: '', panel: 'conversation' })
  const view = await mount(<MobileWebUpdateSafetyProvider verifyConnection={verifyConnection}><Action /><MobileApp client={f.client} connection={connected} platform={platform} /></MobileWebUpdateSafetyProvider>)
  await click(button(view.element, 'Reference files for the Agent to read'))
  const input = document.querySelector<HTMLInputElement>('input[type=file]')!
  expect(input).toBeTruthy()
  window.dispatchEvent(new Event('focus'))
  expect(button(view.element, '取消本次选择')).toBeDefined()
  await click(button(view.element.querySelector('nav.mobile-navigation')!, 'Space'))
  expect(await apply()).toMatchObject({ status: 'blocked', message: expect.stringContaining('session-original') })
  await click(button(view.element.querySelector('nav.mobile-navigation')!, 'Focus'))
  await click(view.element.querySelector('.mobile-session-list button')!)
  await click(button(view.element, '取消本次选择'))
  expect(input.isConnected).toBe(false)
  Object.defineProperty(input, 'files', { value: [file('late.png')] })
  await act(async () => input.dispatchEvent(new Event('change')))
  expect(view.element.querySelector('.mobile-attachment')).toBeNull()
  expect(await apply()).toEqual({ status: 'navigating' })
})

it('preserves a completed file when the rest of its batch stalls and is explicitly cancelled', async () => {
  const f = originalFixture(), stalled = deferred<void>()
  const slow = { name: 'second.png', type: 'image/png', size: 4, stream: () => new ReadableStream<Uint8Array>({
    async start(controller) { await stalled.promise; controller.enqueue(new Uint8Array([1, 2, 3, 4])); controller.close() }
  }) }
  const view = await mount(<MobileWebUpdateSafetyProvider verifyConnection={verifyConnection}><Action /><MobileConversationSurface client={f.client} agentSessionId="session-original" connection={connected} platform={platform} /></MobileWebUpdateSafetyProvider>)
  await paste(view.element, '原正文'); await pasteFiles(view.element, [file('saved.png'), slow])
  await vi.waitFor(() => expect(view.element.querySelector('.mobile-attachment')?.textContent).toContain('saved.png'))
  await click(button(view.element, '取消本次读取'))
  expect(view.element.querySelector('.mobile-attachment')?.textContent).toContain('saved.png')
  expect(await apply()).toMatchObject({ status: 'blocked', message: expect.stringContaining('所选附件') })
  await act(async () => stalled.resolve())
  expect(view.element.querySelectorAll('.mobile-attachment')).toHaveLength(1)
  expect(f.submit).not.toHaveBeenCalled(); expect(editor(view.element).textContent).toBe('原正文')
  await click(button(view.element, '移除 saved.png 本地引用'))
  expect(await apply()).toEqual({ status: 'navigating' })
})

it('keeps the original Host visible and lets a different Host with the same Session ID send its own body', async () => {
  const f = originalFixture(), gate = deferred<any>()
  nativeDevicePorts.filePicker = { pickFiles: vi.fn().mockReturnValue(gate.promise) } as any
  const originalHost = f.sessions.get('session-original')!.hostId
  const view = await mount(<MobileWebUpdateSafetyProvider verifyConnection={verifyConnection}><Action /><MobileConversationSurface client={f.client} agentSessionId="session-original" connection={connected} platform={platform} /></MobileWebUpdateSafetyProvider>)
  await click(button(view.element, 'Reference files for the Agent to read'))
  await act(async () => f.emit({ type: 'agent-session', session: { ...f.sessions.get('session-original')!, hostId: 'other-host' } }))
  await click(button(view.element, '附件选择的原目标'))
  expect(view.element.textContent).toContain(`原 Host ${originalHost} · Session session-original`)
  await paste(view.element, '另一 Host 的正文'); await click(button(view.element, 'Send'))
  await vi.waitFor(() => expect(f.submit).toHaveBeenCalledOnce())
  expect(f.submit.mock.calls[0]![0].prompt).toBe('另一 Host 的正文')
  await click(button(view.element, '取消本次选择'))
  await act(async () => gate.resolve({ files: [] }))
  expect(f.submit).toHaveBeenCalledOnce()
})

it('does not attach another Host’s completed file to a same-ID Session', async () => {
  const f = originalFixture()
  nativeDevicePorts.filePicker = { pickFiles: vi.fn().mockResolvedValue({ files: [{ name: 'original.png', mimeType: 'image/png', size: 4, blob: file('original.png') }] }) } as any
  const view = await mount(<MobileWebUpdateSafetyProvider verifyConnection={verifyConnection}><Action /><MobileConversationSurface client={f.client} agentSessionId="session-original" connection={connected} platform={platform} /></MobileWebUpdateSafetyProvider>)
  await click(button(view.element, 'Reference files for the Agent to read'))
  await vi.waitFor(() => expect(view.element.querySelector('.mobile-attachment')?.textContent).toContain('original.png'))
  await act(async () => f.emit({ type: 'agent-session', session: { ...f.sessions.get('session-original')!, hostId: 'other-host' } }))
  await paste(view.element, '当前 Host 的正文'); await click(button(view.element, 'Send'))
  await vi.waitFor(() => expect(f.submit).toHaveBeenCalledOnce())
  expect(f.submit.mock.calls[0]![0].prompt).toBe('当前 Host 的正文')
  expect(vi.mocked(f.client.forwardRpc!).mock.calls.some(call => call[0] === 'file.upload')).toBe(false)
  expect(view.element.querySelector('.mobile-attachment')).toBeNull()
  expect(await apply()).toMatchObject({ status: 'blocked', message: expect.stringContaining('Host host-original 的 Session session-original') })
  await act(async () => f.emit({ type: 'agent-session', session: { ...f.sessions.get('session-original')!, hostId: 'host-original' } }))
  expect(view.element.querySelector('.mobile-attachment')?.textContent).toContain('original.png')
  await click(button(view.element, '移除 original.png 本地引用'))
  expect(await apply()).toEqual({ status: 'navigating' })
})

it.each(['run', 'record'] as const)('does not silently drop a pending selection after the original %s changes', async change => {
  const f = originalFixture(), gate = deferred<any>()
  nativeDevicePorts.filePicker = { pickFiles: vi.fn().mockReturnValue(gate.promise) } as any
  const view = await mount(<MobileWebUpdateSafetyProvider verifyConnection={verifyConnection}><Action /><MobileConversationSurface client={f.client} agentSessionId="session-original" connection={connected} platform={platform} /></MobileWebUpdateSafetyProvider>)
  await paste(view.element, '原正文'); await click(button(view.element, 'Reference files for the Agent to read'))
  if (change === 'run') await act(async () => f.emit({ type: 'agent-session', session: { ...f.sessions.get('session-original')!, run: { runId: 'replacement-run' } } }))
  else await act(async () => { await getDeviceWorkface().replaceBackup(emptyDeviceWorkface()); f.emit({ type: 'agent-session', session: { ...f.sessions.get('session-original')! } }) })
  await click(button(view.element, 'Send'))
  await vi.waitFor(() => expect(view.element.textContent).toContain('所选附件仍在读取'))
  expect(f.submit).not.toHaveBeenCalled()
  await click(button(view.element, '取消本次选择'))
  await act(async () => gate.resolve({ files: [] }))
})

it.each(['run', 'record'] as const)('keeps Send available for a completed attachment when its original %s changes during a working Run', async change => {
  const f = originalFixture()
  f.sessions.set('session-original', { ...f.sessions.get('session-original')!, semanticStatus: { state: 'working', source: 'native-hook', observedAt: Date.now() } })
  nativeDevicePorts.filePicker = { pickFiles: vi.fn().mockResolvedValue({ files: [{ name: 'original.png', mimeType: 'image/png', size: 4, blob: file('original.png') }] }) } as any
  const view = await mount(<MobileWebUpdateSafetyProvider verifyConnection={verifyConnection}><Action /><MobileConversationSurface client={f.client} agentSessionId="session-original" connection={connected} platform={platform} /></MobileWebUpdateSafetyProvider>)
  await click(button(view.element, 'Reference files for the Agent to read'))
  await vi.waitFor(() => expect(view.element.querySelector('.mobile-attachment')?.textContent).toContain('original.png'))
  if (change === 'run') await act(async () => f.emit({ type: 'agent-session', session: { ...f.sessions.get('session-original')!, run: { runId: 'replacement-run' } } }))
  else await act(async () => { await getDeviceWorkface().replaceBackup(emptyDeviceWorkface()); f.emit({ type: 'agent-session', session: { ...f.sessions.get('session-original')! } }) })
  expect(button(view.element, 'Send')).toBeDefined()
  expect([...view.element.querySelectorAll('button')].some(item => item.getAttribute('aria-label') === 'Stop')).toBe(false)
  expect(f.submit).not.toHaveBeenCalled(); expect(f.signalAgent).not.toHaveBeenCalled()
})

it('labels an unconfirmed connection target while retaining the original attachment without upload', async () => {
  const f = originalFixture(), controls = createRef<MobileAttachmentControls>(), bytes = Buffer.from('data')
  const props = { client: f.client, session: f.sessions.get('session-original')!, agentSessionId: 'session-original', connected: true,
    promptOperationId: null, confirmedPrompt: null, controls, insert: async () => {}, pickFile: async () => ({ id: 'original-file', name: 'original.png', mimeType: 'image/png', size: 4, revision: fileUploadRevision(bytes), dataBase64: bytes.toString('base64') }) }
  const render = (client: typeof f.client | null, session: typeof props.session | null, connected: boolean) => <MobileWebUpdateSafetyProvider verifyConnection={verifyConnection}><Action /><MobileAttachments {...props} client={client} session={session} connected={connected} /></MobileWebUpdateSafetyProvider>
  const view = await mount(render(f.client, props.session, true))
  await act(async () => controls.current!.choose())
  await view.render(render(null, null, false))
  expect(view.element.textContent).toContain('当前连接目标尚未确认')
  expect(view.element.textContent).toContain('Host host-original · Session session-original')
  await click(button(view.element, '上传并加入 original.png'))
  expect(vi.mocked(f.client.forwardRpc!).mock.calls.some(call => call[0] === 'file.upload')).toBe(false)
  await view.render(render(f.client, props.session, true))
  expect(view.element.textContent).not.toContain('当前连接目标尚未确认')
  expect(view.element.querySelector('.mobile-attachment')?.textContent).toContain('original.png')
})

it('cancels an OS-granted path read that never returns without replaying its late native response', async () => {
  const f = originalFixture(), native = deferred<Response>()
  nativeDevicePorts.filePicker = { pickFiles: vi.fn().mockResolvedValue({ files: [{ name: 'native.png', mimeType: 'image/png', size: 4, path: 'private://original-file' }] }) } as any
  vi.mocked(fetch).mockImplementation(async input => String(input).includes('private://original-file') ? native.promise : ({ ok: true, url: location.origin + '/mobile/new-build/' + 'a'.repeat(64) + '/index.html' }) as Response)
  const view = await mount(<MobileWebUpdateSafetyProvider verifyConnection={verifyConnection}><Action /><MobileConversationSurface client={f.client} agentSessionId="session-original" connection={connected} platform={platform} /></MobileWebUpdateSafetyProvider>)
  await paste(view.element, '原正文'); await click(button(view.element, 'Reference files for the Agent to read'))
  await vi.waitFor(() => expect(vi.mocked(fetch).mock.calls.some(call => String(call[0]).includes('private://original-file'))).toBe(true))
  await click(button(view.element, '取消本次选择'))
  expect(await apply()).toEqual({ status: 'navigating' })
  await act(async () => native.resolve({ ok: true, body: file('native.png').stream() } as Response))
  expect(view.element.querySelector('.mobile-attachment')).toBeNull()
  expect(f.submit).not.toHaveBeenCalled(); expect(editor(view.element).textContent).toBe('原正文')
})

it('cancels only the selected Session batch and keeps the other original batch reachable', async () => {
  const f = originalFixture(), first = deferred<void>()
  const slow = { name: 'first.png', type: 'image/png', size: 4, stream: () => new ReadableStream<Uint8Array>({
    async start(controller) { await first.promise; controller.enqueue(new Uint8Array([1, 2, 3, 4])); controller.close() }
  }) }
  const render = (id: string) => <MobileWebUpdateSafetyProvider verifyConnection={verifyConnection}><Action /><MobileConversationSurface client={f.client} agentSessionId={id} connection={connected} platform={platform} /></MobileWebUpdateSafetyProvider>
  const view = await mount(render('session-original'))
  await pasteFiles(view.element, [slow])
  await view.render(render('other'))
  await pasteFiles(view.element, [file('other.png')])
  expect(view.element.textContent).toContain('other.png')
  await click(button(view.element, '取消本次读取'))
  expect(await apply()).toMatchObject({ status: 'blocked', message: expect.stringContaining('session-original') })
  await view.render(render('session-original'))
  expect(view.element.textContent).toContain('first.png')
  await click(button(view.element, '取消本次读取'))
  await act(async () => first.resolve())
  expect(view.element.querySelector('.mobile-attachment')).toBeNull()
  expect(await apply()).toEqual({ status: 'navigating' })
})
