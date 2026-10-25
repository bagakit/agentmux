import { useEffect, useRef, useState, type ReactNode } from 'react'
import { TextInput } from '@agentmux/client-ui/input'
import { presentError } from '@agentmux/client-ui/error-presentation'
import { mintObjectId } from '@agentmux/core/object-id'
import { formatAmuxObjectLink } from '@agentmux/core/sharing'
import type { CapsuleConfig, CapsuleInspection, CapsuleRecord, CapsuleInteraction } from '@agentmux/core/capsule'
import type { CapsuleRuntimeObservation } from '@agentmux/core'
import { api } from '../../lib/api'
import { useCapsuleDraft, useCapsuleMutation } from './capsule-settings-draft'
import { CapsuleRuntimeSettings } from './CapsuleRuntimeSettings'
import { CapsuleIntroduction } from './SettingsConceptIntro'
import '../../styles/settings-capsule.css'

const configFields = ({ contentRoot, defaultStorageMode, defaultMode, defaultTheme }: CapsuleConfig) => ({ contentRoot, defaultStorageMode, defaultMode, defaultTheme })
const pageFields = (page: CapsuleRecord) => ({ title: page.title, sourcePath: page.sourcePath, mode: page.mode, theme: page.theme, entry: page.entry, routing: page.routing })

function Field({ label, hint, children, id }: { label: string; hint?: string; children: ReactNode; id?: string }) {
  return <label className="capsule-settings__field" {...(id ? { 'data-settings-field': id } : {})}>
    <span><strong>{label}</strong>{hint ? <small>{hint}</small> : null}</span>{children}
  </label>
}

function ResultNotice({ state }: { state: { attempt: { params: { operationId: string }; phase: string; message: string } | null; validation: string; inspect(): Promise<void> } }) {
  const { attempt } = state
  return <>{state.validation ? <p role="alert" className="capsule-settings__issue">{state.validation}</p> : null}
    {attempt ? <div className="capsule-settings__receipt" role={attempt.phase === 'unknown' || attempt.phase === 'failed' ? 'alert' : 'status'}>
      <span>{attempt.phase === 'pending' ? 'Waiting for the original operation…' : attempt.message}</span>
      {attempt.phase === 'unknown' ? <button type="button" className="small-button" onClick={() => void state.inspect()}>Check original operation</button> : null}
      {attempt.phase === 'unknown' || attempt.phase === 'failed' ? <small>Operation <code>{attempt.params.operationId}</code></small> : null}
    </div> : null}</>
}

function ModeSelect({ value, change, label }: { value: 'isolated' | 'injected'; change(value: 'isolated' | 'injected'): void; label: string }) {
  return <select aria-label={label} value={value} onChange={event => change(event.target.value as 'isolated' | 'injected')}>
    <option value="isolated">Isolated</option><option value="injected">Injected</option>
  </select>
}

function CapsuleDefaults({ config, onConfirmed, refresh }: { config: CapsuleConfig; onConfirmed(config: CapsuleConfig): void; refresh(): void }) {
  const draft = useCapsuleDraft(configFields(config), config.revision)
  const edit = useRef(0), choosing = useRef(false)
  const [directoryIssue, setDirectoryIssue] = useState('')
  const submitted = useRef(draft.value)
  const mutation = useCapsuleMutation('capsule.config.update', result => {
    draft.confirm(submitted.current, configFields(result.config), result.config.revision)
    onConfirmed(result.config)
  })
  async function choose() {
    if (choosing.current) return
    choosing.current = true
    const version = edit.current
    try {
      const selected = await api.ui.chooseDirectory(draft.value.contentRoot ? { defaultPath: draft.value.contentRoot } : undefined)
      if (selected && edit.current === version) { ++edit.current; setDirectoryIssue(''); draft.set('contentRoot', selected) }
    } catch (error) { if (edit.current === version) setDirectoryIssue(presentError(error)) }
    finally { choosing.current = false }
  }
  function save() {
    const changes = Object.fromEntries(Object.entries(draft.value).filter(([key, value]) => value !== draft.base[key as keyof typeof draft.base]))
    submitted.current = draft.value
    void mutation.submit({ operationId: mintObjectId(), expectedRevision: draft.revision, changes })
  }
  return <section className="settings-group capsule-settings__defaults" aria-label="Capsule defaults">
    <header><span>New page defaults</span><small>Existing pages keep their modes, permissions and locations.</small></header>
    <Field label="Content management" id="capsule-storage"><select aria-label="Default Capsule content management" value={draft.value.defaultStorageMode} onChange={event => draft.set('defaultStorageMode', event.target.value as 'managed' | 'path')}><option value="managed">Managed by AgentMux</option><option value="path">Use a configured path</option></select></Field>
    <Field label="Run mode" hint="Injected pages can use explicitly granted App capabilities." id="capsule-mode"><ModeSelect label="Default Capsule run mode" value={draft.value.defaultMode} change={value => draft.set('defaultMode', value)} /></Field>
    <Field label="Follow App theme" hint="Applies to new injected pages with theme access; this does not grant messaging." id="capsule-theme"><input aria-label="Follow App theme for new Capsules" type="checkbox" checked={draft.value.defaultTheme === 'follow'} onChange={event => draft.set('defaultTheme', event.target.checked ? 'follow' : 'none')} /></Field>
    <div className="capsule-settings__root" data-settings-field="capsule-root"><Field label="New managed content location" hint="Changing this location keeps existing pages at their original absolute paths."><TextInput aria-label="New Capsule content root" value={draft.value.contentRoot} onChange={event => { ++edit.current; draft.set('contentRoot', event.target.value) }} /></Field>
      <div className="capsule-settings__actions"><button type="button" className="small-button" onClick={() => void choose()}>Choose directory</button><span className="capsule-settings__path" title={config.contentRoot}>Saved: {config.contentRoot}</span></div>
      {directoryIssue ? <p role="alert" className="capsule-settings__issue">{directoryIssue}</p> : null}
    </div>
    {draft.changed ? <p className="capsule-settings__receipt" role="status">Saved defaults changed. Your edits still use revision {draft.revision}. <button type="button" className="small-button" onClick={draft.rebase}>Keep edits on current revision</button></p> : null}
    <div className="capsule-settings__actions"><span role="status">{draft.dirty ? 'Unsaved defaults' : 'Saved defaults'}</span><button type="button" className="small-button" onClick={refresh}>Read current defaults</button><button type="button" className="primary-button" disabled={!draft.dirty || mutation.locked} onClick={save}>{mutation.pending ? 'Saving…' : 'Save defaults'}</button></div>
    <ResultNotice state={mutation} />
  </section>
}

function CapsuleImport({ config, created }: { config: CapsuleConfig; created(page: CapsuleInspection): void }) {
  const [value, setValue] = useState({ title: '', sourcePath: '', storageMode: config.defaultStorageMode, mode: config.defaultMode, theme: config.defaultTheme, entry: 'index.html', routing: 'file' as 'file' | 'spa' })
  const [directoryIssue, setDirectoryIssue] = useState(''), generation = useRef(0)
  const mutation = useCapsuleMutation('capsule.create', (result, input) => {
    created(result)
    setValue(current => ({ ...current, title: current.title === (input.title ?? '') ? '' : current.title, sourcePath: current.sourcePath === input.sourcePath ? '' : current.sourcePath }))
  })
  async function choose() {
    const token = ++generation.current
    try {
      const sourcePath = await api.ui.chooseDirectory(value.sourcePath ? { defaultPath: value.sourcePath } : undefined)
      if (sourcePath && token === generation.current) { setDirectoryIssue(''); setValue(current => ({ ...current, sourcePath })) }
    } catch (error) { if (token === generation.current) setDirectoryIssue(presentError(error)) }
  }
  return <details className="capsule-settings__import" data-settings-field="capsule-import"><summary>Import a page directory</summary>
    <div className="capsule-settings__import-fields">
      <Field label="Page name" hint="Optional; the directory name is used when empty."><TextInput aria-label="New Capsule name" value={value.title} onChange={event => setValue(current => ({ ...current, title: event.target.value }))} /></Field>
      <Field label="Source directory"><TextInput aria-label="Capsule source directory" value={value.sourcePath} onChange={event => { ++generation.current; setValue(current => ({ ...current, sourcePath: event.target.value })) }} /></Field>
      <button type="button" className="small-button" onClick={() => void choose()}>Choose source directory</button>
      <Field label="Content management"><select aria-label="New Capsule content management" value={value.storageMode} onChange={event => setValue(current => ({ ...current, storageMode: event.target.value as 'managed' | 'path' }))}><option value="managed">Managed copy</option><option value="path">Keep source path</option></select></Field>
      <Field label="Run mode"><ModeSelect label="New Capsule run mode" value={value.mode} change={mode => setValue(current => ({ ...current, mode }))} /></Field>
      <Field label="Follow App theme" hint="Only used by injected pages with theme access."><input aria-label="New Capsule follows App theme" type="checkbox" checked={value.theme === 'follow'} onChange={event => setValue(current => ({ ...current, theme: event.target.checked ? 'follow' : 'none' }))} /></Field>
      <Field label="Entry file"><TextInput aria-label="New Capsule entry file" value={value.entry} onChange={event => setValue(current => ({ ...current, entry: event.target.value }))} /></Field>
      <Field label="Client-side routing"><input aria-label="New Capsule is a SPA" type="checkbox" checked={value.routing === 'spa'} onChange={event => setValue(current => ({ ...current, routing: event.target.checked ? 'spa' : 'file' }))} /></Field>
      <p className="capsule-settings__hint">Serves HTML, static assets and existing builds. Importing does not run a build or start a backend.</p>
      {directoryIssue ? <p className="capsule-settings__issue" role="alert">{directoryIssue}</p> : null}
      <div className="capsule-settings__actions"><button type="button" className="primary-button" disabled={!value.sourcePath.trim() || mutation.locked} onClick={() => { const { title, ...content } = value; void mutation.submit({ operationId: mintObjectId(), ...content, ...(title.trim() ? { title } : {}) }) }}>Import page</button></div>
      <ResultNotice state={mutation} />
    </div>
  </details>
}

function CapsuleOpen({ page }: { page: CapsuleInspection }) {
  const [outcome, setOutcome] = useState('')
  const mutation = useCapsuleMutation('capsule.open', result => setOutcome(result.rendering.status === 'available' ? 'Opened in the original Browser workface.' : result.rendering.reason))
  return <><button type="button" className="small-button" disabled={mutation.locked} onClick={() => void mutation.submit({ capsuleId: page.record.capsuleId, operationId: mintObjectId() })}>{mutation.pending ? 'Opening…' : 'Open page'}</button>
    {outcome ? <span role="status" className="capsule-settings__hint">{outcome}</span> : null}<ResultNotice state={mutation} /></>
}

function CapsuleDetails({ page, update, refresh, active }: { page: CapsuleInspection; update(page: CapsuleInspection): void; refresh(): void; active: boolean }) {
  const record = page.record, draft = useCapsuleDraft(pageFields(record), record.revision)
  const submitted = useRef(draft.value)
  const [requests, setRequests] = useState<CapsuleInteraction[] | null>(null), [requestIssue, setRequestIssue] = useState(''), [copyNotice, setCopyNotice] = useState('')
  const mutation = useCapsuleMutation('capsule.update', result => {
    draft.confirm(submitted.current, pageFields(result.record), result.record.revision)
    update(result)
  })
  useEffect(() => {
    if (!active) return
    let current = true
    void api.capsules.call('capsule.interaction.ls', { capsuleId: record.capsuleId }).then(result => { if (current) { setRequests(result.interactions); setRequestIssue(result.issues.map(issue => issue.message).join(' ')) } }).catch(error => { if (current) setRequestIssue(presentError(error)) })
    return () => { current = false }
  }, [active, record.capsuleId, record.revision])
  return <section className="capsule-settings__detail" aria-label="Selected Capsule">
    <header><div><h3>{record.title}</h3><small>{record.storageMode === 'managed' ? 'Managed content' : 'Configured path'} · {record.mode === 'isolated' ? 'Isolated' : 'Injected'}</small></div><CapsuleOpen page={page} /><button type="button" className="small-button" onClick={() => { void api.ui.writeClipboardText(formatAmuxObjectLink({ kind: 'capsule', capsuleId: record.capsuleId })).then(() => setCopyNotice('Capsule link copied.'), error => setCopyNotice(presentError(error))) }}>Copy Capsule link</button></header>
    {copyNotice ? <p role="status" className="capsule-settings__hint">{copyNotice}</p> : null}
    <Field label="Page name"><TextInput aria-label="Capsule page name" value={draft.value.title} onChange={event => draft.set('title', event.target.value)} /></Field>
    <Field label="Run mode" hint="Changing mode keeps the page and original requests; it does not authorize arbitrary App access."><ModeSelect label="Capsule page run mode" value={draft.value.mode} change={value => draft.set('mode', value)} /></Field>
    <Field label="Follow App theme"><input aria-label="Capsule page follows App theme" type="checkbox" checked={draft.value.theme === 'follow'} onChange={event => draft.set('theme', event.target.checked ? 'follow' : 'none')} /></Field>
    <details><summary>Content and source</summary><dl><dt>Page ID</dt><dd><code>{record.capsuleId}</code></dd><dt>Published content</dt><dd>{record.contentRoot}</dd><dt>Source</dt><dd>{record.sourcePath}</dd><dt>Service</dt><dd>{page.endpoint.status === 'available' ? page.endpoint.url : page.endpoint.issue.message}</dd>{record.source ? <><dt>Original tool / execution</dt><dd>{record.source.toolId ?? 'Not supplied'} / {record.source.executionId ?? 'Not supplied'}</dd></> : null}</dl>
      <Field label="Source directory" hint={record.storageMode === 'managed' ? 'Publishing a new source copies it into this page’s managed content.' : 'A new source changes this page’s configured content path.'}><TextInput aria-label="Capsule page source directory" value={draft.value.sourcePath} onChange={event => draft.set('sourcePath', event.target.value)} /></Field>
      <Field label="Entry file"><TextInput aria-label="Capsule page entry file" value={draft.value.entry} onChange={event => draft.set('entry', event.target.value)} /></Field>
      <Field label="Client-side routing"><input aria-label="Capsule page is a SPA" type="checkbox" checked={draft.value.routing === 'spa'} onChange={event => draft.set('routing', event.target.checked ? 'spa' : 'file')} /></Field>
    </details>
    {draft.changed ? <p role="status" className="capsule-settings__receipt">The saved page changed; your edits are kept. <button type="button" className="small-button" onClick={draft.rebase}>Keep edits on current revision</button></p> : null}
    <div className="capsule-settings__actions"><span>{draft.dirty ? 'Unsaved page changes' : 'Saved page settings'}</span><button type="button" className="small-button" onClick={refresh}>Read current page</button><button type="button" className="primary-button" disabled={!draft.dirty || mutation.locked} onClick={() => { submitted.current = draft.value; void mutation.submit({ capsuleId: record.capsuleId, operationId: mintObjectId(), expectedRevision: draft.revision, changes: Object.fromEntries(Object.entries(draft.value).filter(([key, value]) => value !== draft.base[key as keyof typeof draft.base])) }) }}>Save page</button></div>
    <ResultNotice state={mutation} />
    {page.issues.length ? <div className="capsule-settings__issue" role="status">{page.issues.map((issue, index) => <p key={index}>{issue.message} {issue.recovery}</p>)}</div> : null}
    {requests?.some(request => request.status === 'pending') ? <div className="capsule-settings__requests"><strong>Needs a reply</strong>{requests.filter(request => request.status === 'pending').map(request => <p key={request.interactionId}>{request.question}</p>)}<small>Open this page to answer through trusted App controls.</small></div> : null}
    {requestIssue ? <p role="status" className="capsule-settings__hint">Requests could not be fully read: {requestIssue}</p> : null}
  </section>
}

export function CapsuleSettingsPane({ active = true }: { active?: boolean }) {
  const [runtime, setRuntime] = useState<CapsuleRuntimeObservation | null>(null)
  const [config, setConfig] = useState<CapsuleConfig | null>(null), [pages, setPages] = useState<CapsuleInspection[]>([])
  const [configIssue, setConfigIssue] = useState(''), [pagesIssue, setPagesIssue] = useState(''), [readPages, setReadPages] = useState(false)
  const [selected, setSelected] = useState<string | null>(null), [filter, setFilter] = useState('')
  const [visited, setVisited] = useState<string[]>([])
  function select(id: string) { setSelected(id); setVisited(current => current.includes(id) ? current : [...current, id]) }
  const configGeneration = useRef(0), pagesGeneration = useRef(0)
  function confirmedConfig(value: CapsuleConfig) { ++configGeneration.current; setConfig(current => !current || value.revision >= current.revision ? value : current); setConfigIssue('') }
  function confirmedPage(value: CapsuleInspection) { ++pagesGeneration.current; setPages(current => current.some(page => page.record.capsuleId === value.record.capsuleId) ? current.map(page => page.record.capsuleId === value.record.capsuleId && value.record.revision >= page.record.revision ? value : page) : [...current, value]) }
  async function loadConfig() {
    const token = ++configGeneration.current
    try { const result = await api.capsules.call('capsule.config.inspect', {}); if (token === configGeneration.current) { setConfig(current => !current || result.config.revision >= current.revision ? result.config : current); setConfigIssue('') } }
    catch (error) { if (token === configGeneration.current) setConfigIssue(presentError(error)) }
  }
  async function loadPages() {
    const token = ++pagesGeneration.current
    try {
      const result = await api.capsules.call('capsule.ls', {})
      if (token !== pagesGeneration.current) return
      setPages(current => {
        const observed = result.capsules.map(page => current.find(previous => previous.record.capsuleId === page.record.capsuleId && previous.record.revision > page.record.revision) ?? page)
        return result.issues.length ? [...observed, ...current.filter(page => !observed.some(item => item.record.capsuleId === page.record.capsuleId))] : observed
      })
      setReadPages(true); setPagesIssue(result.issues.map(issue => issue.message).join(' '))
    } catch (error) { if (token === pagesGeneration.current) setPagesIssue(presentError(error)) }
  }
  useEffect(() => {
    if (active && runtime?.phase === 'running') { void loadConfig(); void loadPages() }
    return () => { ++configGeneration.current; ++pagesGeneration.current }
  }, [active, runtime?.phase])
  const visible = pages.filter(item => `${item.record.title} ${item.record.capsuleId} ${item.record.sourcePath}`.toLowerCase().includes(filter.toLowerCase()))
  return <div className="settings-pane-stack capsule-settings">
    <CapsuleIntroduction />
    <CapsuleRuntimeSettings active={active} observed={setRuntime} />
    {configIssue ? <p role="alert" className="capsule-settings__issue">Defaults could not be confirmed: {configIssue} <button type="button" className="small-button" onClick={() => void loadConfig()}>Read defaults</button></p> : null}
    {config ? <CapsuleDefaults config={config} onConfirmed={confirmedConfig} refresh={() => void loadConfig()} /> : !configIssue ? <p role="status">{runtime?.phase === 'running' ? 'Reading Capsule defaults…' : runtime?.desired === 'stopped' || runtime?.desired === 'unconfigured' ? 'Start the service to read page defaults and content.' : 'Page defaults remain with the original service. Read service status to reconnect.'}</p> : null}
    <section className="settings-group" data-settings-field="capsule-pages" aria-label="Capsule pages"><header><span>Pages</span><button type="button" className="small-button" onClick={() => void loadPages()}>Refresh pages</button></header>
      {config ? <CapsuleImport config={config} created={value => { confirmedPage(value); select(value.record.capsuleId) }} /> : null}
      {pagesIssue ? <p role="alert" className="capsule-settings__issue">Page directory is incomplete: {pagesIssue}</p> : null}
      {pages.length ? <><TextInput aria-label="Find Capsule pages" placeholder="Find a page" value={filter} onChange={event => setFilter(event.target.value)} />
        <ul className="capsule-settings__pages">{visible.map(item => <li key={item.record.capsuleId}><button type="button" aria-pressed={selected === item.record.capsuleId} onClick={() => select(item.record.capsuleId)}><span><strong>{item.record.title}</strong><small>{item.record.storageMode === 'managed' ? 'Managed' : 'Path'} · {item.record.mode === 'isolated' ? 'Isolated' : 'Injected'}</small></span><span>{runtime?.phase === 'running' ? item.content.status === 'available' && item.endpoint.status === 'available' ? 'Available' : 'Needs attention' : runtime?.desired === 'stopped' ? 'Service stopped' : 'Last observed'}</span></button></li>)}</ul>
        {!visible.length ? <p className="capsule-settings__hint">No pages match this search.</p> : null}</> : <p className="capsule-settings__hint">{pagesIssue ? 'Your last known pages are kept; retry the original directory.' : runtime?.phase !== 'running' ? 'Read the original service to view its retained page directory.' : readPages ? 'No registered pages. Import a directory or use amux capsule --skill to create a persistent page.' : 'Reading registered pages…'}</p>}
    </section>
    {pages.filter(page => visited.includes(page.record.capsuleId)).map(page => <div key={page.record.capsuleId} hidden={selected !== page.record.capsuleId}><CapsuleDetails page={page} active={active && selected === page.record.capsuleId} update={confirmedPage} refresh={() => { void api.capsules.call('capsule.inspect', { capsuleId: page.record.capsuleId }).then(confirmedPage, error => setPagesIssue(presentError(error))) }} /></div>)}
  </div>
}
