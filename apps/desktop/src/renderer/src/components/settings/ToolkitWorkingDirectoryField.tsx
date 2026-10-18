import { AgentMuxError, DEFAULT_TOOLKIT_WORKSPACE_PATH, resolveToolkitWorkspacePath } from '@agentmux/core/control'
import { TextInput } from '@agentmux/client-ui/input'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { presentError } from '@agentmux/client-ui/error-presentation'
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { api } from '../../lib/api'
import { useWorkbenchWindowDocument } from '../../lib/workbench-document'
import { useAppStore } from '../../store'
import './toolkit-working-directory.css'

const ThemeObjectFolderIcon = semanticIconComponent('object.folder')

export function useToolkitWorkingDirectory(value: string) {
  const home = useAppStore(state => state.localHome)
  try {
    return { value, resolvedPath: resolveToolkitWorkspacePath(value, home), invalid: false, message: '' }
  } catch (cause) {
    const invalid = cause instanceof AgentMuxError && cause.code === 'INVALID_SETTING_VALUE'
    const message = cause instanceof AgentMuxError && cause.code === 'HOST_HOME_UNAVAILABLE'
      ? 'Path preview is unavailable until the local home directory is known. You can still save; the host will resolve this path.'
      : invalid ? presentError(cause) : `Path preview is unavailable: ${presentError(cause)} You can still save.`
    return { value, resolvedPath: null, invalid, message }
  }
}

export function ToolkitWorkingDirectoryField({ directory, saveError, active, onChange }: {
  directory: ReturnType<typeof useToolkitWorkingDirectory>
  saveError: string
  active: boolean
  onChange(value: string): void
}) {
  const id = useId(), windowDocument = useWorkbenchWindowDocument() ?? undefined
  const [choosing, setChoosing] = useState(false), [selectionError, setSelectionError] = useState('')
  const selectionGeneration = useRef(0), mounted = useRef(false)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useLayoutEffect(() => { ++selectionGeneration.current }, [directory.value, active, windowDocument?.windowId, windowDocument?.documentGeneration])

  function edit(value: string) {
    ++selectionGeneration.current
    setSelectionError('')
    onChange(value)
  }
  async function choose() {
    if (!active || choosing) return
    const request = ++selectionGeneration.current
    setChoosing(true); setSelectionError('')
    try {
      const selected = await api.ui.chooseDirectory(directory.resolvedPath ? { defaultPath: directory.resolvedPath } : {}, windowDocument)
      if (!mounted.current || request !== selectionGeneration.current || selected === null) return
      onChange(selected)
    } catch (cause) {
      if (mounted.current && request === selectionGeneration.current) setSelectionError(presentError(cause))
    } finally {
      if (mounted.current) setChoosing(false)
    }
  }

  return <div className="toolkit-editor__directory">
    <label htmlFor={id}><ThemeObjectFolderIcon size={13} /> Fixed working directory <small>Required</small></label>
    <div className="toolkit-directory__input">
      <TextInput id={id} aria-label="Fixed working directory" aria-required="true" aria-invalid={directory.invalid || undefined}
        aria-describedby={`${id}-help ${id}-preview${saveError ? ` ${id}-save` : ''}${selectionError ? ` ${id}-selection` : ''}`}
        value={directory.value} onChange={event => edit(event.target.value)} placeholder={DEFAULT_TOOLKIT_WORKSPACE_PATH} />
      <button type="button" className="small-button" aria-busy={choosing} disabled={choosing || !active} onClick={() => void choose()}>{choosing ? 'Choosing…' : 'Choose folder…'}</button>
    </div>
    <small id={`${id}-help`}>Use an absolute path, ~, $HOME or {'${HOME}'}. Stays fixed when you switch Agents or workspaces.</small>
    {directory.resolvedPath !== null
      ? <p id={`${id}-preview`} className="toolkit-directory__preview"><span>Expanded path</span><code>{directory.resolvedPath}</code></p>
      : <p id={`${id}-preview`} className={directory.invalid ? 'settings-inline-error' : 'settings-hint'} role="status">{directory.message}</p>}
    {saveError ? <p id={`${id}-save`} className="settings-inline-error" role="alert">{saveError}</p> : null}
    {selectionError ? <p id={`${id}-selection`} className="settings-inline-error" role="alert">Could not choose a folder: {selectionError} You can enter a path above.</p> : null}
  </div>
}
