import { parseHttpLinkUrl } from '@agentmux/client-ui/link-url'
import { classifyMarkdownLinkHref } from '@agentmux/client-ui/markdown-file-reference'
import {
  detectTerminalPathLinks, resolveTerminalFileUri, terminalUriTokens, type TerminalPathLink
} from '@agentmux/client-ui/terminal-path-link'
import { terminalHttpLinkText, trimTerminalUriPunctuation } from './terminal-http-link'

export type TerminalLinkScope = { workspaceRoot: string; homeDir?: string }
export type TerminalLinkTarget =
  | { kind: 'http'; url: string }
  | { kind: 'object'; url: string }
  | { kind: 'file'; file: TerminalPathLink }
  | { kind: 'unsupported'; uri: string }

type TerminalTextLink = { index: number; length: number; target: TerminalLinkTarget }

export function resolveTerminalDeclaredLink(uri: string, scope: TerminalLinkScope): TerminalLinkTarget {
  if (/^amux:/iu.test(uri)) return { kind: 'object', url: uri }
  const url = parseHttpLinkUrl(uri)
  if (url) return { kind: 'http', url }

  const uriPath = resolveTerminalFileUri(uri, scope.workspaceRoot)
  if (uriPath !== null) return { kind: 'file', file: { index: 0, length: uri.length, path: uriPath } }
  const path = classifyMarkdownLinkHref(uri, scope.workspaceRoot, scope.homeDir)
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
  for (const file of detectTerminalPathLinks(text, scope.workspaceRoot, scope.homeDir, tokens)) {
    links.push({ index: file.index, length: file.length, target: { kind: 'file', file } })
  }
  return links.sort((left, right) => left.index - right.index)
}
