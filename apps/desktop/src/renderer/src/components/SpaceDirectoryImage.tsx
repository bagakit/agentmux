import { useEffect, useState, type ReactNode } from 'react'
import type { ObjectAvatarRef, SpaceObjectImageTarget } from '../../../shared/object-avatars'
import { api } from '../lib/api'
import { presentError } from '@agentmux/client-ui/error-presentation'
import { useAppStore } from '../store'

type Result = { url: string | null; issue?: string; notice?: string }
type Read = { listeners: Set<(result: Result) => void>; pending: boolean; result: Result | null }
// Only mounted consumers share a directory read. Reopening a failed image retries those same consumers.
const reads = new Map<string, Read>()
function retain(target: SpaceObjectImageTarget, ref: ObjectAvatarRef | null, listener: (result: Result) => void) {
  const key = JSON.stringify([target, ref?.fileName ?? null])
  const entry = reads.get(key) ?? { listeners: new Set<(result: Result) => void>(), pending: false, result: null }
  reads.set(key, entry); entry.listeners.add(listener)
  if (entry.result) listener(entry.result)
  if (!entry.pending && (!entry.result || entry.result.issue)) {
    entry.pending = true
    const request = ref ? api.spaceObjects.readAvatar(target, ref).then(image => ({ url: image.dataUrl }))
      : api.spaceObjects.appearance(target).then(appearance => ({ url: appearance.icon,
          ...(appearance.local ? {} : { notice: 'Local image recognition is unavailable for this remote object.' }) }))
    void request.then(result => { entry.result = result }).catch(cause => {
      const issue = 'This avatar could not be read. Its saved choice and workface are retained. Reopen Change avatar to retry. ' + presentError(cause)
      entry.result = { url: null, issue }
      if (entry.listeners.size) useAppStore.getState().reportError(new Error(issue))
    }).finally(() => {
      entry.pending = false
      if (entry.result) for (const consumer of entry.listeners) consumer(entry.result)
    })
  }
  return () => {
    entry.listeners.delete(listener)
    if (!entry.listeners.size && reads.get(key) === entry) reads.delete(key)
  }
}

function rejectDisplayedImage(target: SpaceObjectImageTarget, ref: ObjectAvatarRef | null, issue: string) {
  const entry = reads.get(JSON.stringify([target, ref?.fileName ?? null]))
  if (!entry || entry.result?.issue === issue) return
  entry.result = { url: null, issue }
  for (const listener of entry.listeners) listener(entry.result)
  useAppStore.getState().reportError(new Error(issue))
}

export function SpaceDirectoryImage({ target, choice, fallback }: {
  target: SpaceObjectImageTarget; choice: ObjectAvatarRef | null; fallback: ReactNode
}) {
  const identity = JSON.stringify([target, choice?.fileName ?? null])
  const [result, setResult] = useState<(Result & { identity: string }) | null>(null)
  useEffect(() => retain(target, choice, result => setResult({ identity, ...result })), [identity, choice])
  const observed = result?.identity === identity ? result : null
  return <span className="project-rail-row__icon space-object-icon" data-space-icon-kind={target.kind}
    data-space-icon-source={choice ? 'image' : 'automatic'} data-space-avatar={choice?.fileName}
    title={observed?.issue ?? observed?.notice ?? (choice ? 'Uploaded avatar' : 'Local directory avatar')} aria-hidden="true">
    {observed?.url ? <img className="space-object-icon__avatar" src={observed.url} alt="" draggable={false}
      onError={() => {
        const issue = 'This local image could not be displayed. Its saved choice is retained; reopen Change avatar to retry.'
        rejectDisplayedImage(target, choice, issue)
      }} /> : observed ? fallback : null}
  </span>
}
