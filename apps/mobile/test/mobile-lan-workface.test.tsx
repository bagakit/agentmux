import './mobile-lan-crypto.setup'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it } from 'vitest'
import { MobileApp } from '../src/MobileApp'
import { createBrowserPlatform } from '../src/platform/browser'
import { emptyDeviceWorkface, getDeviceWorkface } from '../src/recovery/device-workface'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

it('mounts the actual LAN workface without secure-context randomUUID and retains all five original navigation choices', async () => {
  localStorage.clear(); await getDeviceWorkface().replaceBackup({ ...emptyDeviceWorkface(), presentation: {
    primary: 'focus', showSession: false, showGoalWork: false, identity: null, profile: null
  } })
  const element = document.createElement('div'); document.body.append(element)
  let failure: unknown = null
  const root = createRoot(element, { onUncaughtError: error => { failure = error } })
  try {
    try { await act(async () => root.render(<MobileApp client={null} connection={{ state: 'disconnected', message: '原 Host 尚未连接' }} platform={createBrowserPlatform()} />)) }
    catch (error) { failure = error }
    expect(failure, 'LAN must mount the actual product instead of failing during Back ownership').toBeNull()
    expect([...element.querySelectorAll('.mobile-navigation button')].map(value => value.textContent)).toEqual(['Goals', 'Topics', 'Mote', 'Focus', 'Space'])
    expect(getDeviceWorkface().snapshot().record.presentation?.primary).toBe('focus')
  } finally { await act(async () => root.unmount()); element.remove() }
})
