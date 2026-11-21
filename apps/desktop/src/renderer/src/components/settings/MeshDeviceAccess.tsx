import { useRef, useState } from 'react'
import { Button } from '@agentmux/client-ui/components/Button'
import { TextInput } from '@agentmux/client-ui/input'
import meshArt from '@agentmux/client-ui/brand/illustrations/concepts/mesh-relay.jpg'
import { readMeshDeviceLink } from '../../../../shared/mesh-device-link'
import { api } from '../../lib/api'
import { checkpointMeshDeviceLinks, setAuthoredWorkbench, useAppStore } from '../../store'

export function MeshDeviceAccess() {
  const links = useAppStore(state => state.meshDeviceLinks)
  const [issue, setIssue] = useState(''), [opening, setOpening] = useState(false)
  const [newIdentity, setNewIdentity] = useState<string>()
  const [pasting, setPasting] = useState(false), [opened, setOpened] = useState<string>(), [saveIssue, setSaveIssue] = useState('')
  const field = useRef<HTMLInputElement>(null)
  const saved = links.saved.map(url => {
    try { return readMeshDeviceLink(url) } catch { return null }
  })
  let target: ReturnType<typeof readMeshDeviceLink> | undefined
  try { if (links.draft.trim()) target = readMeshDeviceLink(links.draft) } catch { /* The full link can still be pasted or entered. */ }
  function edit(draft: string) {
    setIssue(''); setNewIdentity(undefined)
    setAuthoredWorkbench(state => ({ meshDeviceLinks: { ...state.meshDeviceLinks, draft } }))
  }
  async function paste() {
    setPasting(true); setIssue('')
    try {
      const text = (await api.ui.readClipboardText()).trim()
      if (!text) setIssue('Clipboard is empty. Copy the access link from the device owner.')
      else if (useAppStore.getState().meshDeviceLinks.draft === links.draft) edit(text)
    } catch { setIssue('Couldn’t read the clipboard. Paste the access link into the field.') }
    finally { setPasting(false); field.current?.focus() }
  }
  async function saveLink() {
    try { await checkpointMeshDeviceLinks(); setSaveIssue('') }
    catch { setSaveIssue('The device opened. Its link is in this window and still needs to be saved.') }
  }
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
      setOpened(target.offer.serverId)
      setAuthoredWorkbench(state => {
        const current = state.meshDeviceLinks
        return { meshDeviceLinks: { saved: [...new Set([...current.saved, target.url])], draft: current.draft === source ? '' : current.draft } }
      })
      await saveLink()
    } catch (cause) { setIssue(cause instanceof Error ? cause.message : String(cause)) }
    finally { setOpening(false) }
  }
  return <section className="mesh-network-section" aria-label="Use another device">
    <div className="mesh-join-landing"><div className="mesh-join-lead"><h3>Open work on another device.</h3><p>{saved.length ? 'Choose a saved device or paste an access link from its owner.' : 'Paste the access link shared by the device owner.'}</p></div>
      <div className="mesh-join-art" aria-hidden="true"><img src={meshArt} alt="" width="1100" height="619" draggable={false} /></div></div>
    <label className="mesh-form-field"><span>Device access link</span><TextInput ref={field} aria-label="Device access link" value={links.draft}
      onChange={event => edit(event.target.value)} /></label>
    {target ? <div className="mesh-network-note"><strong>{target.offer.serverId}</strong><p>Via {target.offer.relay.endpoint}</p></div> : null}
    <div className="mesh-recovery-actions">
      {target && !newIdentity ? <Button type="button" variant="primary" disabled={opening} onClick={() => void open(links.draft)}>{opening ? 'Opening…' : 'Open device workspace'}</Button> : null}
      {!target ? <Button type="button" variant="primary" disabled={opening || pasting} onClick={() => void paste()}>{pasting ? 'Reading clipboard…' : 'Paste access link'}</Button> : null}
      {newIdentity && <Button type="button" variant="primary" disabled={opening} onClick={() => void open(newIdentity, true)}>Pair as a separate identity</Button>}
    </div>
    {!target && links.draft.trim() && !issue ? <p role="status" className="field-hint">A complete device access link is needed. Copy it from the device owner.</p> : null}
    {issue && <p role="alert" className="settings-inline-error">{issue}</p>}
    {opened && <p role="status" className="field-hint">Opened {opened}. If its window asks for approval, copy the access key there and send it to the device owner.</p>}
    {saveIssue && <div className="mesh-recovery-actions"><p role="status">{saveIssue}</p><Button type="button" onClick={() => void saveLink()}>Save device link again</Button></div>}
    {saved.map((link, index) => link
      ? <Button key={link.url} type="button" disabled={opening} title={link.offer.daemonPublicKeyB64} onClick={() => void open(link.url)}>
          Open {link.offer.serverId} via {link.offer.relay.endpoint}
        </Button>
      : <p key={links.saved[index]} role="status">A saved device link needs its original complete address.</p>)}
  </section>
}
