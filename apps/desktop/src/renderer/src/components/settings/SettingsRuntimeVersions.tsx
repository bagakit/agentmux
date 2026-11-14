import { useEffect, useState } from 'react'
import { Button } from '@agentmux/client-ui/components/Button'
import type { DesktopLoadedIdentity } from '../../../../shared/client-observation'
import { api } from '../../lib/api'

type RuntimeOwner = Awaited<ReturnType<typeof api.spatial.owner>>['owner']

/** This window and the original local Runtime are independent read-only sources. */
export function SettingsRuntimeVersions({ active }: { active: boolean }) {
  const [desktop, setDesktop] = useState<DesktopLoadedIdentity | null | undefined>()
  const [runtime, setRuntime] = useState<RuntimeOwner | null | undefined>()
  const [refresh, setRefresh] = useState(0)

  useEffect(() => {
    if (!active) return
    let current = true
    setDesktop(undefined)
    setRuntime(undefined)
    void api.ui.readLoadedIdentity().then(result => { if (current) setDesktop(result) }, () => { if (current) setDesktop(null) })
    void api.spatial.owner().then(({ owner }) => { if (current) setRuntime(owner) }, () => { if (current) setRuntime(null) })
    return () => { current = false }
  }, [active, refresh])

  const appVersion = desktop?.appVersion ?? desktop?.package?.appVersion
  const source = desktop?.package?.appVersion === appVersion ? desktop?.package?.sourceCommit : undefined
  const renderer = desktop?.renderer
  const kernel = runtime?.ctxmux
  const core = runtime?.availability === 'connected' ? runtime : undefined
  const desktopStatus = desktop === undefined && active ? 'Checking…' : 'Unconfirmed'
  const runtimeStatus = runtime === undefined && active ? 'Checking…' : 'Unconfirmed'

  return <section className="settings-group general-settings__versions" aria-label="App and kernel versions" data-settings-field="runtime-versions">
    <header><span>Versions</span><Button type="button" className="general-settings__version-refresh" aria-label="Refresh versions" disabled={active && desktop === undefined && runtime === undefined}
      onClick={() => setRefresh(value => value + 1)}>Refresh</Button></header>
    <dl>
      <div>
        <dt>App</dt>
        <dd>{appVersion ? <code>{appVersion}</code> : desktopStatus}
          {source ? <small>Source commit<code className="general-settings__version-digest">{source.slice(0, 20)}<wbr />{source.slice(20)}</code></small> : null}</dd>
      </div>
      <div>
        <dt>Kernel (ctxmux)</dt>
        <dd>{kernel ? <><code>{kernel.buildIdentity}</code><small>Protocol {kernel.protocolVersion}</small></> : runtimeStatus}</dd>
      </div>
      <div>
        <dt>Renderer build</dt>
        <dd>{renderer ? <><small>{renderer.kind === 'staged' ? 'Staged' : 'Bundled'}</small><code className="general-settings__version-digest">{renderer.id.slice(0, 32)}<wbr />{renderer.id.slice(32)}</code></> : desktopStatus}</dd>
      </div>
      <div>
        <dt>Core protocol</dt>
        <dd>{core ? <><code>{core.protocolVersion}</code><small>Instance <code>{core.ownerInstanceId}</code></small></> : runtimeStatus}</dd>
      </div>
    </dl>
  </section>
}
