import { expect, it } from 'vitest'
import { assertAppDocumentSender, isAppDocumentSender } from '../src/main/ipc-sender-trust'

it('requires the exact live root frame and a source named by the original loader', () => {
  const source = { mode: 'prod' as const, filePath: '/private/app/index.html' }
  const frame = { url: 'file:///private/app/index.html?renderer-update=original#anchor', detached: false, isDestroyed: () => false }
  const contents = { mainFrame: frame, isDestroyed: () => false }, event = { sender: contents, senderFrame: frame }
  expect(isAppDocumentSender(event, contents, { current: source, loading: null })).toBe(true)
  expect(isAppDocumentSender(event, contents, { current: null, loading: source })).toBe(true)
  expect(isAppDocumentSender(event, contents, { current: null, loading: null })).toBe(false)
  expect(isAppDocumentSender({ ...event, sender: { ...contents } }, contents, { current: source, loading: null })).toBe(false)
  expect(isAppDocumentSender({ ...event, senderFrame: { ...frame } }, contents, { current: source, loading: null })).toBe(false)
  expect(isAppDocumentSender({ ...event, senderFrame: null }, contents, { current: source, loading: null })).toBe(false)
  frame.detached = true
  expect(() => assertAppDocumentSender(event, contents, { current: source, loading: null })).toThrow('Untrusted application')
  frame.detached = false; frame.isDestroyed = () => true
  expect(isAppDocumentSender(event, contents, { current: source, loading: null })).toBe(false)
  frame.isDestroyed = () => false; contents.isDestroyed = () => true
  expect(isAppDocumentSender(event, contents, { current: source, loading: null })).toBe(false)
})
