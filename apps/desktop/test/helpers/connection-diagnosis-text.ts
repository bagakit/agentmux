/** Read the compact presentation for business assertions; never chooses an operation or recovery. */
export function diagnosisText(text: string) {
  const observations: Record<string, any> = {}, traces: Array<{ kind: string; operationId: string; status: string; entries: any[] }> = []
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!, observation = /^(mote|enrollment|setup) (\S+) — (\S+)$/u.exec(line), trace = /^Trace (enrollment|setup) (\S+) — (\S+)$/u.exec(line)
    if (observation) {
      const facts: Record<string, unknown> = { status: observation[3] }
      for (let n = i + 1; /^  [A-Za-z]+: /u.test(lines[n] ?? ''); n++) {
        const field = /^  ([A-Za-z]+): (.*)$/u.exec(lines[n]!)!
        facts[field[1]!] = JSON.parse(field[2]!)
      }
      observations[observation[1]! + ':' + observation[2]!] = facts
    }
    if (trace) traces.push({ kind: trace[1]!, operationId: trace[2]!, status: trace[3]!, entries: [] })
    if (/^[1-9][0-9]* \| /u.test(line)) {
      const [sequence, stepId, kind, action, subjectEffect, request, secureStorage, diagnostic] = line.split(' | ')
      traces.at(-1)!.entries.push({ sequence: Number(sequence), stepId, kind, action, subject: kind === 'application-inspection' && subjectEffect !== '-' ? subjectEffect : null, effect: kind === 'application-configuration' ? subjectEffect : null, request, secureStorage: secureStorage === '-' ? null : secureStorage, network: null, ...(diagnostic !== 'null' ? { diagnostic: JSON.parse(diagnostic!) } : {}) })
    }
  }
  return { complete: text.includes('Report: complete\n'), observations, traces }
}
