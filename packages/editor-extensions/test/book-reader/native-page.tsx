import { createRef } from 'react'
import { createRoot } from 'react-dom/client'
import { BookReader } from '../../src/book-reader/BookReader'
import { mountThemeRuntime, updateThemeSelection, readResolvedTheme, previewTheme } from '@agentmux/client-ui/theme'
import type { BookOpenRequest, BookReaderHost, BookReadingPosition } from '../../src/book-reader/protocol'

declare global { interface Window { bookTest: { invoke(method: string, args: unknown[]): Promise<any> }; [key: string]: any } }
mountThemeRuntime(window, {appAppearance: 'dark'})
let root = createRoot(document.getElementById('root')!), gate: (() => void) | null = null
const checkpoint = createRef<(() => void) | null>()
window.capturePositionCheckpoint = () => checkpoint.current?.()
window.proofPositions = []
window.renderBook = (request: BookOpenRequest, position?: BookReadingPosition) => {
  const host: BookReaderHost = {
    async open() { const value = await window.bookTest.invoke('open', [request]); window.proofOpened = value; return value },
    load: (...args) => window.bookTest.invoke('load', args), unload: (...args) => window.bookTest.invoke('unload', args),
    async resolve(...args) { if (window.deferLink) { window.deferLink = false; await new Promise<void>(resolve => { gate = resolve }) }; return window.bookTest.invoke('resolve', args) },
    close: (...args) => window.bookTest.invoke('close', args),
  }
  root.render(<BookReader positionCheckpoint={checkpoint} key={request.sourceId} host={host} name={request.name} {...(position ? {position} : {})} onPosition={value => {window.proofPositions.push(value)}} onRetry={() => {window.proofRetry = true}} />)
}
window.releaseLink = () => { gate?.(); gate = null }
window.closeBook = () => { root.unmount(); root = createRoot(document.getElementById('root')!) }
window.bookState = () => {
  const frame = document.querySelector('iframe'), doc = frame?.contentDocument
  return {state: document.querySelector('.book-reader')?.getAttribute('data-book-state'),section: document.querySelector<HTMLInputElement>('[aria-label="Book section"]')?.value,src:frame?.src,
    text:doc?.body?.textContent,notice:document.querySelector('.book-reader__notice')?.textContent, position:window.proofPositions.at(-1),positions:window.proofPositions.length,
    background:doc?.body ? getComputedStyle(doc.body).backgroundColor : null,color:doc?.body ? getComputedStyle(doc.body).color : null}
}
window.switchBookTheme = (mode: 'dark'|'light'|'custom') => {
  if (mode !== 'custom') { previewTheme(undefined); return updateThemeSelection({appAppearance: mode}) }
  const document = {...structuredClone(readResolvedTheme().value),id:'custom.book-test'}
  document.variants.light.colors.surface0 = '#f6efd9'; document.variants.light.colors.text = '#352615'
  return previewTheme(document,window,'light')
}
