// @vitest-environment happy-dom
import { act } from 'react'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { expect, it, vi } from 'vitest'
import { fileUploadRevision } from '@agentmux/core/files'
import type { AgentInputImageReference } from '@agentmux/core'
import { AgentSessionComposer } from '../src/renderer/src/components/AgentSessionComposer'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { composerDOM, composerSession } from './helpers/composer-dom-fixture'

vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: () => null }))
const dom = composerDOM()

it('App selected image preserves paste bytes and typed membership through actual Composer serialization', async () => {
  const id = 'image-agent', source = '/__agentmux_test__/pasted/' + 'a'.repeat(64) + '.png'
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64')
  const upload = { hostId: 'local', agentSessionId: id, expectedRun: { runId: 'run-image-agent' }, operationId: 'app-selected-image', name: 'image', mimeType: 'image/png', byteLength: png.length, revision: fileUploadRevision(png) }
  useAppStore.setState({ sessions: [composerSession(id, 'claude')], agentComposerDrafts: { [id]: 'Before selected picture' }, agentSteerQueues: {} })
  vi.spyOn(api.ui, 'savePastedImage').mockResolvedValue(source)
  vi.spyOn(api.ui, 'readPastedImage').mockResolvedValue({ dataUrl: 'data:image/png;base64,' + png.toString('base64') })
  let retained: { upload: typeof upload; dataBase64: string } | undefined
  const retain = vi.spyOn(api.ui, 'retainInputImage').mockImplementation(async input => {
    expect(input.session).toEqual(composerSession(id, 'claude').control)
    expect(Buffer.from(input.bytes)).toEqual(png)
    retained = { upload, dataBase64: Buffer.from(input.bytes).toString('base64') }
    return { upload, observation: 'confirmed' }
  })
  let originalBody: string | undefined, originalImages: readonly AgentInputImageReference[] | undefined
  // Only the native IPC boundary is replaced. The next Node consumer uploads and
  // submits this exact artifact through the real Host without changing its metadata.
  vi.spyOn(useAppStore.getState(), 'send').mockImplementation((sessionId, body, _onRejected, origin, _note, options) => {
    expect(sessionId).toBe(id); expect(origin).toBe('manual')
    originalBody = body; originalImages = options?.inputImages
    return true
  })
  await dom.render(<AgentSessionComposer sessionId={id} />)
  const file = new File([new Uint8Array(png)], 'paste.png', { type: 'image/png' }), event = new Event('paste', { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'clipboardData', { value: { items: [{ kind: 'file', type: 'image/png', getAsFile: () => file }], getData: () => '' } })
  await act(async () => dom.container.querySelector('.tiptap')!.dispatchEvent(event))
  await vi.waitFor(() => expect(dom.draft(id)).toContain('agentmux-image:'))
  await act(async () => useAppStore.getState().setAgentComposerDraft(id, dom.draft(id)! + ' After selected picture'))
  await dom.click('.composer-send')
  expect(originalBody).toBeDefined(); expect(retain).toHaveBeenCalledTimes(1)
  const path = process.env.AGENTMUX_TEST_IMAGE_RECOVERY_ARTIFACT!
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify({ body: originalBody, inputImages: originalImages, source, retained }))
  expect(originalImages).toHaveLength(1)
  expect(originalImages![0]!.upload).toEqual(upload)
  expect(originalImages![0]!.bodyRevision).toBe(fileUploadRevision(new TextEncoder().encode(originalBody!)))
  expect(originalBody!.slice(originalImages![0]!.start, originalImages![0]!.end)).toContain(source)
})
