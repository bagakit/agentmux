import { composerCommandCandidates } from '@agentmux/client-ui/composer-command-candidates'
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { formatSessionAddress } from '@agentmux/core/sharing'
import type { AgentSkill } from '@agentmux/core'
import type { ComposerSuggestion } from '@agentmux/client-ui/components/AgentComposer'
import type { ComposerInsertionHandle } from '@agentmux/client-ui/composer-insertion'
import { encodeSemanticReference, semanticReferenceKind, semanticReferenceLabel } from '@agentmux/client-ui/composer-semantic-reference'
import { appendSelectedFileReferences } from '@agentmux/client-ui/composer-file-reference'
import { resolveComposerInputConfig } from '@agentmux/client-ui/composer-input-config'
import { presentError } from '@agentmux/client-ui/error-presentation'
import { resolveComposerShortcuts } from '../../../shared/composer-shortcut-library'
import type { AppConfig, WorkspaceDirectoryEntry, WorkspaceRecord } from '../../../shared/contracts'
import { ConversationMessageAvatar } from '../components/ConversationMessageAvatar'
import { SemanticIcon } from '../components/semantic-icons'
import { useAppStore } from '../store'
import { api } from './api'
import { createConversationSpeakerMetadataReader } from './conversation-sender-details'
import { createFirstPromptSelector } from './session-presentation'

export type ComposerCandidateQuery = { kind: 'command' | 'skill' | 'reference' | 'keyword'; query: string }
type Resource<T> = { scope: string; value: T[]; loading: boolean; error: string | null }
const EMPTY: never[] = []

export function skillComposerSuggestion(skill: AgentSkill): ComposerSuggestion {
  const kind = semanticReferenceKind(skill.path)
  return { id: `skill:${skill.source}:${skill.path}`, text: `$${skill.name}`, label: skill.name,
    searchText: `${skill.name} ${skill.description} ${skill.source} ${skill.path}`, description: `${skill.source} · ${skill.description || skill.path}`,
    insertText: encodeSemanticReference({ token: `$${skill.name}`, label: semanticReferenceLabel(skill.name), kind,
      reference: kind === 'subcommand' ? skill.path : `@${skill.path}` }),
    icon: <SemanticIcon name={kind === 'component' ? 'object.component' : 'object.skill'} size={15} /> }
}

/** Data from existing owners, read only for the actual open completion or explicit tool action. */
export function useComposerCandidates({ scope: callerScope, active, config, workspace, providerId, sessionId, commands, insertion }: {
  scope: string; active: boolean; config: AppConfig | null; workspace?: WorkspaceRecord | undefined
  providerId?: string | undefined; sessionId?: string | undefined
  commands: readonly { text: string; description: string }[]
  insertion: RefObject<ComposerInsertionHandle | null>
}) {
  const scope = JSON.stringify([callerScope, sessionId, providerId, workspace?.id, workspace?.hostId, workspace?.path])
  const inputConfig = resolveComposerInputConfig(config?.messageToolCompletion)
  const [request, setRequest] = useState<{ scope: string; query: ComposerCandidateQuery | null } | null>(null)
  const query = request?.scope === scope && active ? request.query : null
  const onCompletionQuery = useCallback((query: ComposerCandidateQuery | null) => { setRequest({ scope, query: active ? query : null }) }, [scope, active])
  const [skills, setSkills] = useState<Resource<AgentSkill> | null>(null)
  const [files, setFiles] = useState<Resource<WorkspaceDirectoryEntry> | null>(null)
  const [revision, retry] = useState(0)
  const current = useRef(scope); current.current = scope
  const skillGeneration = useRef(0)
  const loadSkills = useCallback(async () => {
    const generation = ++skillGeneration.current
    const isCurrent = () => current.current === scope && generation === skillGeneration.current
    setSkills(previous => ({ scope, value: previous?.scope === scope ? previous.value : [], loading: true, error: null }))
    try {
      const value = sessionId ? await api.ui.listAgentSkills(sessionId)
        : workspace && providerId ? await api.ui.listWorkspaceSkills(workspace.id, providerId) : []
      if (!isCurrent()) return []
      setSkills({ scope, value, loading: false, error: null }); return value
    } catch (error) {
      if (isCurrent()) setSkills(previous => ({ scope, value: previous?.scope === scope ? previous.value : [], loading: false, error: presentError(error) }))
      throw error
    }
  }, [scope, sessionId, workspace?.id, providerId])
  const kind = active ? query?.kind : undefined
  useEffect(() => {
    if (kind === 'skill') void loadSkills().catch(() => {})
  }, [kind, loadSkills, revision])
  // Path completion reads just the named directory. It does not recursively walk the project.
  const directory = kind === 'reference' && query?.query.includes('/') ? query.query.slice(0, query.query.lastIndexOf('/')) : ''
  const fileScope = JSON.stringify([scope, workspace?.id, directory])
  useEffect(() => {
    if (kind !== 'reference' || !workspace) return
    let retained = true
    setFiles(previous => ({ scope: fileScope, value: previous?.scope === fileScope ? previous.value : [], loading: true, error: null }))
    void api.files.readDirectory(workspace.id, directory).then(value => {
      if (retained) setFiles({ scope: fileScope, value, loading: false, error: null })
    }, error => {
      if (retained) setFiles(previous => ({ scope: fileScope, value: previous?.scope === fileScope ? previous.value : [], loading: false, error: presentError(error) }))
    })
    return () => { retained = false }
  }, [kind, workspace?.id, fileScope, directory, revision])
  useEffect(() => () => { skillGeneration.current++ }, [scope])

  // Closed/hidden inputs do not observe the whole Agent roster. This is one open consumer, no per-row IO.
  const nameReaders = useRef(new Map<string, ReturnType<typeof createFirstPromptSelector>>())
  const rosterFacts = useAppStore(useShallow(state => {
    if (kind !== 'reference') { nameReaders.current.clear(); return EMPTY }
    const facts: unknown[] = [state.config?.workspaces, state.config?.hosts, state.scratchTopicSnapshots, state.spaceObjectIcons]
    const retained = new Set<string>()
    for (const session of state.sessions) if (session.kind === 'agent') {
      retained.add(session.id)
      let readName = nameReaders.current.get(session.id)
      if (!readName) { readName = createFirstPromptSelector(session.id); nameReaders.current.set(session.id, readName) }
      facts.push(session.id, session.control.agentSessionId, session.hostId, session.workspacePath, session.providerId,
        session.label, session.createdAt, state.agentNames[session.id], state.agentNames[session.id] ? null : readName(state))
    }
    for (const id of nameReaders.current.keys()) if (!retained.has(id)) nameReaders.current.delete(id)
    return facts
  }))
  const references = useMemo<ComposerSuggestion[]>(() => {
    if (!rosterFacts.length) return []
    const roster = useAppStore.getState()
    const readMetadata = createConversationSpeakerMetadataReader({ ...roster, workspaces: roster.config?.workspaces ?? [] })
    const identities = new Set<string>()
    const agents: ComposerSuggestion[] = []
    for (const session of roster.sessions) {
      if (session.kind !== 'agent' || identities.has(session.control.agentSessionId)) continue
      identities.add(session.control.agentSessionId)
      const id = session.control.agentSessionId
      const details = readMetadata(session.id)
      const label = details?.mote?.name ?? details?.label ?? session.label
      const link = formatSessionAddress(id)
      const location = `${roster.config?.hosts.find(host => host.id === session.hostId)?.label ?? session.hostId} · ${details?.project?.name ?? session.workspacePath} · ${id}`
      agents.push({ id: `agent:${id}`, text: `@${label}`, label, description: location, group: 'Agents',
        searchText: `${label} ${location}`, insertText: encodeSemanticReference({ kind: 'agent', token: `@${label}`, label, reference: link }),
        icon: <ConversationMessageAvatar speaker={{ role: 'agent', id }} name={label} providerId={session.providerId}
          project={details?.project} mote={details?.mote} size={18} /> })
    }
    const entries = files?.scope === fileScope ? files.value : EMPTY
    return [...agents, ...entries.map(entry => ({ id: `file:${workspace?.id}:${entry.path}`, text: `@${entry.path}`, label: entry.name,
      description: entry.path, group: 'Files / Folders', searchText: entry.path,
      insertText: entry.isDirectory ? `${inputConfig.reference ?? '@'}${entry.path}/`
        : appendSelectedFileReferences('', [entry.path], workspace?.path).trim(),
      keepOpen: entry.isDirectory,
      icon: <SemanticIcon name={entry.isDirectory ? 'object.folder' : 'object.file'} size={15} /> }))]
  }, [rosterFacts, files, fileScope, workspace?.id, workspace?.path, inputConfig.reference])

  const candidates = composerCommandCandidates(resolveComposerShortcuts(config), providerId, commands)
  const withIcon = (item: ComposerSuggestion): ComposerSuggestion => ({ ...item, icon: <SemanticIcon name="object.subcommand" size={15} /> })
  const shortcuts = candidates.shortcuts
  const commandCandidates = candidates.commands.map(withIcon)
  const keywordCandidates = candidates.promptKeywords.map(withIcon)
  const insertCandidate = useCallback(async (item: ComposerSuggestion) => {
    if (current.current !== scope) return
    await insertion.current?.insert(() => current.current === scope ? item.insertText ?? item.text : null, { separate: true })
  }, [scope, insertion])
  const skillState = skills?.scope === scope ? skills : null
  const fileState = files?.scope === fileScope ? files : null
  const source = kind === 'skill' ? skillState : kind === 'reference' && workspace ? fileState : null
  const completionFeedback = source?.loading ? <span role="status">{kind === 'skill' ? 'Reading skills…' : 'Reading this directory…'}</span>
    : source?.error ? <span role="status">{kind === 'skill' ? 'Skills' : 'Files'}: {source.error} <button type="button" onClick={() => retry(value => value + 1)}>Retry</button></span> : null
  return { scope, completionConfig: inputConfig, commands: commandCandidates, promptKeywords: keywordCandidates, prompts: shortcuts,
    skills: skillState?.value.map(skillComposerSuggestion) ?? [], references, onCompletionQuery, completionFeedback,
    loadSkills, insertCandidate }
}
