# Plugin and naming contract review

## Scope

This review covers the public plugin boundary and the Agent Skill guidance for readable Agent and Workspace names.

## Design decisions

- Core exposes a typed, host-neutral plugin manifest that can contribute providers, skills, and commands. Discovery and activation are separate, duplicate IDs are rejected, and the editor consumes the resulting catalog rather than vendor-specific branches.
- Plugin metadata is descriptive and does not own Runtime facts. Session, Run, PTY, ordered output, replay, and gap state remain in Core/ctxmux.
- The Agent Skill explains the durable naming actions and keeps display names separate from stable Session/Workspace IDs and filesystem paths.

## Review result

**Approved for implementation.** The public contract must have a focused unit test and a non-empty production caller. Skill text must name both self and workspace naming paths without inventing provider-specific commands.
