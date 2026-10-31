import { api } from './api'
import { createWorkbenchUserDocument } from './workbench-user-storage'
import { DESKTOP_FRAGMENT_KEYS, type DesktopFragmentName, type DesktopFragmentValues } from './desktop-user-fragments'

const preview = __AGENTMUX_WEB_PREVIEW__
export const desktopUserDocument = createWorkbenchUserDocument(api.ui, () => window.localStorage, error => {
  window.dispatchEvent(new CustomEvent('agentmux-workbench-save-error', { detail: error }))
})
const browserValue = <N extends DesktopFragmentName>(name: N): DesktopFragmentValues[N] => {
  if (typeof window === 'undefined') return (name === 'moteAvatarSaveDrafts' ? {} : null) as DesktopFragmentValues[N]
  if (name !== 'moteAvatarSaveDrafts') return localStorage.getItem(DESKTOP_FRAGMENT_KEYS[name]) as DesktopFragmentValues[N]
  const entries: Record<string, string> = {}
  for (let index = 0; index < localStorage.length; index++) {
    const key = localStorage.key(index)
    if (key?.startsWith(DESKTOP_FRAGMENT_KEYS.moteAvatarSaveDrafts)) entries[key] = localStorage.getItem(key)!
  }
  return entries as DesktopFragmentValues[N]
}
/** Web preview is a separate host. Shipping consumers only edit the original root cache. */
export const desktopUserFragments = {
  ready: (name: DesktopFragmentName) => preview || desktopUserDocument.isReady(name),
  read<N extends DesktopFragmentName>(name: N): DesktopFragmentValues[N] { return preview ? browserValue(name) : desktopUserDocument.read(name) },
  async load<N extends DesktopFragmentName>(name: N, validate: (value: DesktopFragmentValues[N]) => void) {
    if (!preview) return await desktopUserDocument.load(name, validate)
    const value = browserValue(name); validate(value); return value
  },
  write<N extends DesktopFragmentName>(name: N, value: DesktopFragmentValues[N]) {
    if (!preview) return desktopUserDocument.write(name, value)
    if (name === 'moteAvatarSaveDrafts') {
      const previous = browserValue(name) as Record<string, string>, next = value as Record<string, string>
      for (const key of Object.keys(previous)) if (!(key in next)) localStorage.removeItem(key)
      for (const [key, raw] of Object.entries(next)) localStorage.setItem(key, raw)
    } else if (value === null) localStorage.removeItem(DESKTOP_FRAGMENT_KEYS[name])
    else localStorage.setItem(DESKTOP_FRAGMENT_KEYS[name], value as string)
  },
  async checkpoint(name: DesktopFragmentName) { if (preview) await api.ui.requestStorageFlush(); else await desktopUserDocument.checkpoint(name) },
  subscribe: desktopUserDocument.subscribe
}
