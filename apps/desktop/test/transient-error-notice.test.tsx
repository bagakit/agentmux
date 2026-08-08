// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TransientErrorNotice } from '../src/renderer/src/components/TransientErrorNotice.js'

vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)

describe('transient error notice', () => {
  let root: ReturnType<typeof createRoot> | null = null
  let host: HTMLDivElement | null = null

  afterEach(async () => {
    if (root) await act(async () => root!.unmount())
    host?.remove()
    root = null
    host = null
  })

  it('is a non-bottom surface with an explicit dismiss action', async () => {
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    const onDismiss = vi.fn()
    await act(async () => root!.render(<TransientErrorNotice error="Prompt could not be sent" dismissed={false} lastError="Prompt could not be sent" onDismiss={onDismiss} onReopen={vi.fn()} />))

    expect(host.querySelector('.error-notice')).not.toBeNull()
    expect(host.querySelector('.error-notice__close')?.getAttribute('aria-label')).toBe('Dismiss error')
    await act(async () => (host!.querySelector('.error-notice__close') as HTMLButtonElement).click())
    expect(onDismiss).toHaveBeenCalledOnce()
  })

  it('keeps a deliberate reopen path after dismissal instead of deleting the message', async () => {
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    const onReopen = vi.fn()
    await act(async () => root!.render(<TransientErrorNotice error="Prompt could not be sent" dismissed={true} lastError="Prompt could not be sent" onDismiss={vi.fn()} onReopen={onReopen} />))

    expect(host.querySelector('.error-notice')).toBeNull()
    const reopen = host.querySelector('.error-notice__reopen') as HTMLButtonElement
    expect(reopen.textContent).toContain('Show last error')
    await act(async () => reopen.click())
    expect(onReopen).toHaveBeenCalledOnce()
  })
})
