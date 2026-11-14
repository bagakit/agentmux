import { useState } from 'react'
import { Button } from '@agentmux/client-ui/components/Button'
import { TextInput } from '@agentmux/client-ui/input'
import { readMeshDeviceLink } from '../../../../shared/mesh-device-link'
import { api } from '../../lib/api'
import { checkpointMeshDeviceLinks, setAuthoredWorkbench, useAppStore } from '../../store'

export function MeshDeviceAccess() {
  const links = useAppStore(state => state.meshDeviceLinks)
  const [issue, setIssue] = useState(''), [opening, setOpening] = useState(false)
  const [newIdentity, setNewIdentity] = useState<string>()
  const saved = links.saved.map(url => {
    try { return readMeshDeviceLink(url) } catch { return null }
  })
  async function open(source: string, separateIdentity = false) {
    if (opening) return
    setOpening(true); setIssue('')
    try {
      const target = readMeshDeviceLink(source)
      const matches = saved.filter(link => link?.offer.serverId === target.offer.serverId)
      if (matches.length && !matches.some(link => link?.offer.daemonPublicKeyB64 === target.offer.daemonPublicKeyB64) && !separateIdentity) {
        setNewIdentity(source)
        throw new Error('This device ID has a different encryption key. Open a separate workspace to pair with its new identity.')
      }
      await api.ui.openMeshDevice(target.url)
      setNewIdentity(undefined)
      setAuthoredWorkbench(state => {
        const current = state.meshDeviceLinks
        return { meshDeviceLinks: { saved: [...new Set([...current.saved, target.url])], draft: current.draft === source ? '' : current.draft } }
      })
      await checkpointMeshDeviceLinks()
    } catch (cause) { setIssue(cause instanceof Error ? cause.message : String(cause)) }
    finally { setOpening(false) }
  }
  return <section className="mesh-network-section" aria-label="Use another device">
    <header><h4>Use another device</h4></header>
    <p className="field-hint">Open the access link from its gateway. On first use, share the workspace’s access key with the device owner.</p>
    <label className="mesh-form-field"><span>Device access link</span><TextInput aria-label="Device access link" value={links.draft}
      onChange={event => { const draft = event.target.value; setIssue(''); setNewIdentity(undefined); setAuthoredWorkbench(state => ({ meshDeviceLinks: { ...state.meshDeviceLinks, draft } })) }} /></label>
    <Button type="button" disabled={opening || !links.draft.trim()} onClick={() => void open(links.draft)}>{opening ? 'Opening…' : 'Open device workspace'}</Button>
    {issue && <p role="alert" className="settings-inline-error">{issue}</p>}
    {newIdentity && <Button type="button" disabled={opening} onClick={() => void open(newIdentity, true)}>Pair as a separate identity</Button>}
    {saved.map((link, index) => link
      ? <Button key={link.url} type="button" disabled={opening} title={link.offer.daemonPublicKeyB64} onClick={() => void open(link.url)}>
          Open {link.offer.serverId} via {link.offer.relay.endpoint}
        </Button>
      : <p key={links.saved[index]} role="status">A saved device link needs its original complete address.</p>)}
  </section>
}
