import { parseHttpLinkUrl } from '@agentmux/client-ui/link-url'
import { classifyMarkdownLinkHref } from '@agentmux/client-ui/markdown-file-reference'
import {
  decodeTerminalFileUriPath, detectTerminalPathLinks, isSystemArtifactPath, resolveWorkspaceRelativePath,
  terminalUriTokens, type TerminalPathLink
} from '@agentmux/client-ui/terminal-path-link'
import { terminalHttpLinkText, trimTerminalUriPunctuation } from './terminal-http-link'

type RegisteredWorkspace = NonNullable<TerminalPathLink['workspace']>
type WorkspaceRegistration = RegisteredWorkspace & { hostId: string }
type WorkspaceIndex = ReadonlyMap<string, RegisteredWorkspace | null>
const workspaceIndexes = new WeakMap<readonly WorkspaceRegistration[], WorkspaceIndex>()

export function terminalLocalWorkspaceIndex(workspaces: readonly WorkspaceRegistration[]): WorkspaceIndex {
  const cached = workspaceIndexes.get(workspaces)
  if (cached) return cached
  const index = new Map<string, RegisteredWorkspace | null>()
  for (const workspace of workspaces) {
    if (workspace.hostId !== 'local' || !workspace.path.startsWith('/')) continue
    const root = workspace.path.replace(/\/+$/, '') || '/'
    index.set(root, index.has(root) ? null : { id: workspace.id, path: workspace.path })
  }
  workspaceIndexes.set(workspaces, index)
  return index
}

export type TerminalLinkScope = { workspaceRoot: string; homeDir?: string; registeredWorkspaces?: WorkspaceIndex }
export type TerminalLinkTarget =
  | { kind: 'http'; url: string }
  | { kind: 'object'; url: string }
  | { kind: 'file'; file: TerminalPathLink }
  | { kind: 'unsupported'; uri: string }

type TerminalTextLink = { index: number; length: number; target: TerminalLinkTarget }

export function resolveTerminalLinkPath(candidate: string, scope: TerminalLinkScope): Pick<TerminalPathLink, 'path' | 'workspace'> | null {
  const original = resolveWorkspaceRelativePath(candidate, scope.workspaceRoot, scope.homeDir)
  if (original !== null) return { path: original }
  const index = scope.registeredWorkspaces
  if (!index || !candidate.startsWith('/') || candidate.startsWith('//') ||
      /(?:^|\/)\.{1,2}(?:\/|$)|\/\//u.test(candidate) || isSystemArtifactPath(candidate)) return null
  let owner: RegisteredWorkspace | undefined
  // Only this candidate's ancestors participate in link detection.
  for (let slash = candidate.lastIndexOf('/'); slash >= 0; slash = slash ? candidate.lastIndexOf('/', slash - 1) : -1) {
    const match = index.get(candidate.slice(0, slash) || '/')
    if (match === undefined) continue
    if (match === null || owner) return null
    owner = match
  }
  const path = owner && resolveWorkspaceRelativePath(candidate, owner.path)
  return owner && path ? { path, workspace: owner } : null
}

export function resolveTerminalDeclaredLink(uri: string, scope: TerminalLinkScope): TerminalLinkTarget {
  if (/^amux:/iu.test(uri)) return { kind: 'object', url: uri }
  const url = parseHttpLinkUrl(uri)
  if (url) return { kind: 'http', url }

  const uriPath = decodeTerminalFileUriPath(uri)
  if (uriPath !== null) {
    const resolved = resolveTerminalLinkPath(uriPath, scope)
    return resolved ? { kind: 'file', file: { index: 0, length: uri.length, ...resolved } } : { kind: 'unsupported', uri }
  }
  const path = classifyMarkdownLinkHref(uri, scope.workspaceRoot, scope.homeDir, undefined, name => resolveTerminalLinkPath(name, scope))
  if (path) return { kind: 'file', file: path }
  return { kind: 'unsupported', uri }
}

export function terminalTextLinks(text: string, scope: TerminalLinkScope): TerminalTextLink[] {
  const tokens = terminalUriTokens(text)
  const links: TerminalTextLink[] = []
  for (const { index, text: token } of tokens) {
    let reference: string | null = null
    if (/^https?:\/\//i.test(token)) reference = terminalHttpLinkText(token)
    else if (token.startsWith('amux://')) reference = token.split(/[<>"\x60\[\]{}\p{Script=Han}\u3000-\u303f\uff00-\uffef]/u, 1)[0] ?? null
    else if (/^file:\/\//i.test(token)) reference = trimTerminalUriPunctuation(token.split(/[\u3000-\u303f\uff00-\uffef]/u, 1)[0] ?? '')
    if (!reference) continue

    const target = resolveTerminalDeclaredLink(reference, scope)
    if (target.kind === 'unsupported') continue
    links.push({ index, length: reference.length, target })
  }
  for (const file of detectTerminalPathLinks(text, scope.workspaceRoot, scope.homeDir, tokens, name => resolveTerminalLinkPath(name, scope))) {
    links.push({ index: file.index, length: file.length, target: { kind: 'file', file } })
  }
  return links.sort((left, right) => left.index - right.index)
}
