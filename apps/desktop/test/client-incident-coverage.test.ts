import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { AgentMuxRpcService } from '../../../packages/core/src/public-rpc-service'
import { parseDiagnosticEvidenceResult } from '../../../packages/core/src/diagnostic-evidence-codec'
const { ClientIncidentArchive }: typeof import('@agentmux/host/client-incident-archive') = await import(
  process.env.AGENTMUX_TEST_INCIDENT_ARCHIVE_ENTRY ?? new URL('@agentmux/host/client-incident-archive', import.meta.url).href)

it('keeps an uncovered exact incident unknown through the real public diagnostic owner', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'client-incident-coverage-'))
  const archive = new ClientIncidentArchive(directory)
  const service = new AgentMuxRpcService({ coreClients: () => [], clientIncidents: archive })
  try {
    await archive.flush()
    const query = { target: { domain: 'client.incident' as const, hostId: 'local', logId: '111111111111' } }
    const result = parseDiagnosticEvidenceResult(await service.call('system.diagnostics.inspect', query), query)
    expect(result.reads).toHaveLength(1)
    expect(result.reads[0]).toMatchObject({ availability: 'not-found', completeness: 'unknown', issue: null,
      data: null, authorityStatus: 'verified', raw: { retention: 'not-retained' } })
  } finally { await service.dispose(); await rm(directory, { recursive: true, force: true }) }
})
