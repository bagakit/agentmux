# AgentMux system guides

These Markdown files are the source of the system instructions read by people and by
`amux`. They ship with Core and apply independently of any project's Agent instructions.

- [Start here](index.md): identity, progressive discovery and the module directory.
- [Agent Sessions](modules/agent.md), [A2A messages](modules/message.md),
  [spaces](modules/space.md), [Browser](modules/browser.md), [Goals](modules/goal.md)
  and the other files in [modules/](modules/) are exposed by `amux MODULE --skill`.
- [actions/](actions/) contains longer instructions attached to the relevant leaf help,
  including [Browser programs](actions/browser-run.md), [Agent opening](actions/agent-open.md)
  and the [PMO manual](actions/mote-pmo.md).
- [shared/](shared/) holds text with more than one real consumer, including the
  [communication contract](shared/messaging/contract.md), short
  [entry](shared/messaging/entry.md) and [reminder](shared/messaging/reminder.md), and
  [Goal responsibilities](shared/goal/contract.md).

## Editing and generation

Edit Markdown here, then run `pnpm --filter @agentmux/core generate:guides`.
`pnpm --filter @agentmux/core check:guides` checks the generated projection and compiles
its consumers without writing. Guide IDs and required facts are generated types, so a
deleted reference or missing fact fails compilation. The check also renders the real
read-only consumers to validate dynamic registry facts. The Core build generates the
projection before compilation and performs the same consumer check. Commit the Markdown and its
generated projection together when changing guidance.

Each module declares `summary`, `roles` and `when` in YAML frontmatter. Its Markdown
heading is for direct reading; the `amux:content` comment marks the exact content supplied
to consumers. The CLI adds its standard metadata and command-discovery footer.

An ordinary Markdown link with the title `amux:include` includes the linked guide at
build time. People can follow the same link. A link titled `amux:generated NAME` points
to the owner of a code-generated fact. Only the explicitly supported named facts are
expanded; there is no script evaluation or general template language. Keep command
availability, parameters, capability names and protocol catalogs in their original code
registries. Use the current leaf `--help` for executable arguments.

Code-owner links target `dist/`, the same versioned implementation shipped in the
published package. In a source checkout, build Core before following those links; the
matching editable implementation is under `src/`. The content marker preserves CLI
text verbatim, including command examples; it does not parse or execute them.

`src/generated/agentmux-guides.ts` is generated data, never an editing source. Runtime
consumers import those browser-safe strings without filesystem, project or network
access. A source edit, build, installed CLI and a live model's actual adoption are
separate facts; updating these files does not rewrite previously frozen inputs.
