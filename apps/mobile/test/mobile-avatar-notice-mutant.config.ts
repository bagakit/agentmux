import { mergeConfig } from 'vitest/config'
import base from '../vitest.config'

const mutants = {
  notice: { file: '/src/notices/MobileNotice.tsx', marker: 'if (!target || !issue) return null', replacement: 'if (!target || !issue || true) return null' },
  'retry-target': { file: '/src/navigation/MobileSpaceIcon.tsx', marker: "client.forwardRpc!('space.inspect', { target: { spaceId }, presentation: true })",
    replacement: "client.forwardRpc!('space.inspect', { target: { spaceId: retryRevision ? 'wrong-original-space' : spaceId }, presentation: true })" },
  'image-run': { file: '/src/navigation/MobileIdentity.tsx', marker: 'const appearanceOwner = useMemo(() => ({}), [client, identity.mote?.spaceId])',
    replacement: 'const appearanceOwner = useMemo(() => ({}), [client, identity.mote?.spaceId, session?.run.runId])' },
  'image-host': { file: '/src/navigation/MobileIdentity.tsx', marker: 'const appearanceOwner = useMemo(() => ({}), [client, identity.mote?.spaceId])',
    replacement: 'const appearanceOwner = useMemo(() => ({}), [])' },
  'mote-name': { file: '/src/navigation/MobileIdentity.tsx', marker: "name={identity.mote.name ?? 'Mote 名称未确认'}",
    replacement: 'name={identity.name}' },
  'space-reference': { file: '/src/navigation/MobileSpaceIcon.tsx', marker: 'const observationOwner = useMemo(() => ({}), [client, reference])',
    replacement: 'const observationOwner = useMemo(() => ({}), [client, reference, appearance])' },
  'old-failure': { file: '/src/navigation/MobileIdentity.tsx', marker: "const issue = failure?.owner === sourceOwner ? failure.message : ''",
    replacement: "const issue = failure?.message ?? ''" }
} as const
const name = process.env.AGENTMUX_AVATAR_NOTICE_MUTANT as keyof typeof mutants
const mutant = mutants[name]
if (!mutant) throw Error('Select an avatar notice mutation')
export default mergeConfig(base, { plugins: [{ name: 'mobile-avatar-notice-consumer-mutant', enforce: 'pre' as const,
  transform(code: string, id: string) {
    if (!id.split('?')[0]!.endsWith(mutant.file)) return
    if (code.split(mutant.marker).length !== 2) throw Error('The original avatar consumer mutation did not match its loaded module uniquely')
    return code.replace(mutant.marker, mutant.replacement)
  }
}] })
