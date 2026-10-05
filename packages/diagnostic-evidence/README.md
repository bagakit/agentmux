# @agentmux/diagnostic-evidence

Portable TypeScript evidence contracts and bounded queries. No runtime dependencies, storage, collectors, UI, Node APIs or domain-specific payloads.

```ts
import { DiagnosticEvidenceQuery, type DiagnosticEvidenceReader }
  from '@agentmux/diagnostic-evidence'
```

Implement an ordinary typed reader over your existing owner and reuse one query per service. Supply explicit related targets/relations when original evidence supports them. Cancellation ends this observation; unresolved owner IO retains its in-flight slot. Original records, authority, safe projection, raw retention and domain semantics remain with their owners.

- [Protocol](../../docs/specs/diagnostic-evidence-protocol.md)
- [Integration guide](../../docs/guides/diagnostic-evidence-integration.md)
- [Design and ownership](../../docs/design/diagnostic-evidence.md)
- [Public types](src/protocol.ts) and [query](src/query.ts)

AgentMux assembles its domain readers in Core and exposes `system.diagnostics.inspect` / `amux system diagnostics inspect`. The portable package alone does not collect evidence, start sampling or implement a business domain.
