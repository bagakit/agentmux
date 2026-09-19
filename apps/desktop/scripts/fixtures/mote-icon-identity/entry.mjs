import { createElement as h, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { createWorkspaceLayout } from '@agentmux/layout'
import { MoteIcon } from '../../../src/renderer/src/components/MoteIcon'
import { SpaceTopicsTree } from '../../../src/renderer/src/components/SpaceTopicsTree'
import { SpaceCreateMenu } from '../../../src/renderer/src/components/SpaceCreateMenu'
import { AgentAvatar } from '../../../src/renderer/src/components/AgentAvatar'
import { WorkbenchTabMarks } from '../../../src/renderer/src/components/WorkbenchTabMarks'
import { QuickSwitcher } from '../../../src/renderer/src/components/QuickSwitcher'
import { SemanticIcon } from '../../../src/renderer/src/components/semantic-icons'
import { useAppStore } from '../../../src/renderer/src/store'
import { api } from '../../../src/renderer/src/lib/api'
import { createWorkbenchTab } from '../../../src/renderer/src/lib/workbench-tabs'
import { SCRATCH_WORKSPACE_ID } from '../../../src/shared/scratch-topics'
import '../../../src/renderer/src/styles/index.css'

const config = await api.config.get()
const workspace = { id: SCRATCH_WORKSPACE_ID, hostId: 'local', name: 'Topics', path: '/topics', kind: 'folder' }
const tab = createWorkbenchTab('review-new-tab', { regionId: 'review-new-region', kind: 'launcher', workspaceId: workspace.id })
api.scratch.listTopics = async () => []
useAppStore.setState({ config: { ...config, workspaces: [workspace] }, sessions: [],
  tabs: { [tab.id]: tab }, layouts: { [workspace.id]: createWorkspaceLayout('review-group', [tab.id]) },
  activeWorkspaceId: workspace.id, collapsedProjectGroups: {}, pinnedItems: {}, scratchTopicOrder: [] })

const css = document.createElement('style')
css.textContent = `
  body { margin: 0; background: #161a20; color: #e6e7e5; font-family: -apple-system, sans-serif; }
  .review { padding: 32px; display: grid; grid-template-columns: 1fr 240px; gap: 28px; }
  .review h1 { margin: 0 0 24px; font-size: 20px; font-weight: 550; letter-spacing: -.3px; }
  .specimens { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  .specimen { padding: 24px; border-radius: 10px; background: #232931; color: #e6e7e5; }
  .specimen.light { background: #e9e7df; color: #353a3a; }
  .large { height: 192px; display: grid; place-items: center; }
  .sizes { display: grid; grid-template-columns: repeat(3, 1fr); align-items: center; gap: 8px; }
  .sample { display: grid; place-items: center; gap: 14px; }
  .sample small { font-size: 11px; opacity: .6; }
  .contexts { display: flex; align-items: center; gap: 20px; margin-top: 28px; font-size: 12px; }
  .context { display: flex; align-items: center; gap: 6px; }
  .review-rail { padding: 18px 8px; background: #20252b; border-radius: 10px; min-height: 260px; }
  .review-rail .heading { padding: 0 8px 12px; display: flex; justify-content: space-between; align-items: center; font-size: 12px; color: #a4abb2; }
  .review-caption { color: #8f969d; font-size: 11px; line-height: 1.7; margin-top: 22px; }
  #open-switcher { margin-top: 18px; }
`
document.head.append(css)

function Review() {
  const [switcher, setSwitcher] = useState(false)
  return h('main', { className: 'review' },
    h('section', null,
      h('h1', null, 'Mote'),
      h('div', { className: 'specimens' }, ...['dark', 'light'].map(tone =>
        h('div', { key: tone, className: `specimen ${tone}` },
          h('div', { className: 'large' }, h(MoteIcon, { size: 160 })),
          h('div', { className: 'sizes' }, ...[12, 16, 24].map(size =>
            h('div', { className: 'sample', key: size, 'data-sample': `${tone}-${size}` },
              h(MoteIcon, { size }), h('small', null, `${size}px`))))))),
      h('div', { className: 'contexts' },
        h('span', { className: 'context' }, h(WorkbenchTabMarks, { marks: [{ kind: 'launcher', regionId: 'review-launcher' }] }), 'New Tab'),
        h('span', { className: 'context' }, h(SemanticIcon, { name: 'skill', size: 14 }), 'Skill'),
        h('span', { className: 'context' }, h(AgentAvatar, { providerId: 'codex', appearance: { badge: 'spark' }, size: 24 }), 'Executor badge')),
      h('p', { className: 'review-caption' }, 'Actual vector and production consumers. Private fixture; preview data.')),
    h('aside', { className: 'review-rail project-rail', 'data-rail-density': 'default' },
      h('div', { className: 'heading' }, 'Space', h(SpaceCreateMenu, { onOpenFolder: async () => {} })),
      h(SpaceTopicsTree, { workspace }),
      h('button', { id: 'open-switcher', className: 'small-button', onClick: () => setSwitcher(true) }, 'Review quick switcher')),
    h(QuickSwitcher, { open: switcher, onClose: () => setSwitcher(false) }))
}

window.moteReviewSVG = renderToStaticMarkup(h(MoteIcon, { size: 24 }))
window.moteReviewFacts = () => {
  const mark = document.querySelector('.large svg path')
  const box = mark?.getBBox()
  return {
    samples: [...document.querySelectorAll('[data-sample]')].map(node => {
      const svg = node.querySelector('svg')
      const rect = svg.getBoundingClientRect()
      const style = getComputedStyle(svg)
      return { sample: node.dataset.sample, width: rect.width, height: rect.height,
        fill: style.fill, filter: style.filter, path: svg.querySelector('path').getAttribute('d') }
    }),
    contourBounds: box && { x: box.x, y: box.y, width: box.width, height: box.height },
    treePath: document.querySelector('[aria-label="Open Mote"] svg path')?.getAttribute('d'),
    creationPath: [...document.querySelectorAll('[role="menuitem"]')].find(node => node.textContent === 'Create Mote')?.querySelector('svg path')?.getAttribute('d'),
    switcherLauncher: !!document.querySelector('.quick-switch__row .lucide-panels-top-left')
  }
}
createRoot(document.getElementById('root')).render(h(Review))
