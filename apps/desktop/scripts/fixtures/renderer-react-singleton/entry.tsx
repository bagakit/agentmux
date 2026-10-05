import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { createPortal, version as domVersion } from 'react-dom'
import { createContext as createDependencyContext } from '@fixture/absolute-context'
import { LinkedBoundary, dependencyReact, dependencyPortal, dependencyDomVersion } from '@fixture/linked-overlay'
import { PaneSplitMenu } from '../../../src/renderer/src/components/PaneSplitMenu'
import { ConfirmationDialog } from '../../../src/renderer/src/components/ConfirmationDialog'

// Both boundaries use the installed, byte-identical Radix context implementation.
// The aliases and linked package change dependency ownership, never React's code.
const [AbsoluteBoundary] = createDependencyContext('AbsoluteDependency')
const proof = {
  trigger: new URL(location.href).searchParams.get('trigger'),
  identity: {
    react: React.useMemo === dependencyReact.useMemo,
    reactDom: createPortal === dependencyPortal,
    reactVersions: [React.version, dependencyReact.version],
    domVersions: [domVersion, dependencyDomVersion]
  },
  actions: { split: [] as string[], confirmed: 0 },
  errors: [] as Array<{ name: string; message: string; stack: string }>
}
Object.assign(window, { singletonProof: proof })
function error(error: unknown) {
  proof.errors.push(error instanceof Error
    ? { name: error.name, message: error.message, stack: error.stack ?? '' }
    : { name: 'NonError', message: String(error), stack: '' })
}
window.addEventListener('error', event => error(event.error ?? event.message))
window.addEventListener('unhandledrejection', event => error(event.reason))

function OriginalConsumers() {
  const [open, setOpen] = React.useState(false)
  return <>
    <input id="original-input" aria-label="Original input" defaultValue="retained input" />
    <PaneSplitMenu regionCount={2} onSplit={direction => proof.actions.split.push(direction)} onArrange={() => {}} />
    <button id="open-dialog" onClick={() => setOpen(true)}>Open original dialog</button>
    <ConfirmationDialog open={open} title="Shared React dialog" description="Original confirmation consumer"
      confirmLabel="Confirm once" intent="neutral" onCancel={() => setOpen(false)}
      onConfirm={() => { proof.actions.confirmed++; setOpen(false) }} />
  </>
}

const element = <OriginalConsumers />
const boundary = proof.trigger === 'absolute-entry'
  ? <AbsoluteBoundary owner="absolute-entry">{element}</AbsoluteBoundary>
  : <LinkedBoundary>{element}</LinkedBoundary>
createRoot(document.getElementById('root')!, { onUncaughtError: error }).render(boundary)
