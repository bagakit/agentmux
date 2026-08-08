import { useEffect, useState } from 'react'
import { Folder, GitBranch } from 'lucide-react'
import { api } from '../lib/api'

export function ProjectIcon({ workspaceId }: { workspaceId: string }) {
  const [appearance, setAppearance] = useState<{ kind: 'repository' | 'directory'; icon: string | null }>({ kind: 'directory', icon: null })
  useEffect(() => {
    let active = true
    void api.workspaces.appearance(workspaceId).then((value) => { if (active) setAppearance(value) }).catch(() => {})
    return () => { active = false }
  }, [workspaceId])
  return <span className="project-rail-row__icon" title={appearance.kind === 'repository' ? 'Git project' : 'Project folder'}>
    {appearance.icon ? <img src={appearance.icon} alt="Project icon" onError={() => setAppearance({ ...appearance, icon: null })} />
      : appearance.kind === 'repository' ? <GitBranch size={15} /> : <Folder size={15} />}
  </span>
}
