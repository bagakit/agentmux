import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { CapsuleSettingsPane } from '../CapsuleSettingsPane'
import type { SettingsModule } from '../settings-catalog'

const CapsuleIcon = semanticIconComponent('object.capsule')

export const capsuleSettingsModule = {
  id: 'capsule', group: 'browser-use', title: 'Capsule', icon: CapsuleIcon,
  description: 'Keep generated pages available, isolated or connected to your App.',
  keywords: 'capsule persistent pages html static spa managed storage root isolated injected theme hitl 页面 托管 隔离 注入',
  searchTargets: [
    { id: 'capsule-service', title: 'Page service', keywords: 'runtime start stop independent', kind: 'action' },
    { id: 'capsule-storage', title: 'Default content management', keywords: 'managed path storage' },
    { id: 'capsule-mode', title: 'Default run mode', keywords: 'isolated injected' },
    { id: 'capsule-theme', title: 'Follow App theme', keywords: 'style inheritance' },
    { id: 'capsule-root', title: 'New managed content location', keywords: 'directory root path' },
    { id: 'capsule-pages', title: 'Registered pages', keywords: 'open copy page identity', kind: 'info' },
    { id: 'capsule-import', title: 'Import a page directory', keywords: 'html build spa', kind: 'action' }
  ],
  savedSummary: () => 'Persistent pages, isolation and interaction',
  Pane({ active }) { return <CapsuleSettingsPane active={active} /> }
} as const satisfies SettingsModule
