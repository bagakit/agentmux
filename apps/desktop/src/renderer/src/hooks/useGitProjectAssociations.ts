import { useEffect, useMemo, useState } from 'react'
import type { GitProjectIdentityResult } from '../../../shared/git-contracts'
import type { HostConfig } from '../../../shared/contracts'
import type { WorkspaceProject } from '../lib/workspace-projects'
import { api } from '../lib/api'

/** One read per Project registration, independent of Session/terminal activity. */
export function useGitProjectAssociations(projects: readonly WorkspaceProject[], hosts: readonly HostConfig[] | undefined, visible: boolean) {
  const [observations, setObservations] = useState<Map<string, GitProjectIdentityResult>>(new Map())
  useEffect(() => {
    if (!visible) return
    let current = true, cursor = 0
    setObservations(new Map())
    async function read() {
      while (current && cursor < projects.length) {
        const project = projects[cursor++]!
        let result: GitProjectIdentityResult
        try { result = await api.git.projectIdentity(project.preferredWorkspaceId) }
        catch { result = { kind: 'unavailable', hostId: project.hostId, workspacePath: project.repoPath, reason: 'Git association could not be read. Choose projects manually or retry.' } }
        if (current && result.hostId === project.hostId) setObservations(previous => new Map(previous).set(project.id, result))
      }
    }
    void Promise.all(Array.from({ length: Math.min(4, projects.length) }, read))
    return () => { current = false }
  }, [projects, hosts, visible])
  const related = useMemo(() => {
    const sources = new Map<string, WorkspaceProject[]>()
    for (const project of projects) {
      const result = observations.get(project.id)
      if (result?.kind !== 'known') continue
      for (const identity of result.identities) {
        const bucket = sources.get(identity) ?? []; bucket.push(project); sources.set(identity, bucket)
      }
    }
    return new Map(projects.map(project => {
      const result = observations.get(project.id)
      const candidates = result?.kind === 'known' ? result.identities.flatMap(identity => sources.get(identity) ?? []) : []
      return [project.id, [...new Set(candidates.filter(other => other.id !== project.id).map(other => other.id))]]
    }))
  }, [projects, observations])
  return { observations, related }
}
