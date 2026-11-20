---
tag: tailcat-setup
form: prompt
title: Tailcat setup assistance
description: The original receiving Desktop and the separate settings target.
examples:
- label: Tailcat setup assistance
  template: setup
  parameters:
    runtimeId: RUNTIME_ID
    context: CONNECTION_FIELDS
---

# Tailcat setup assistance

## setup

~~~text
Help me install, diagnose and prepare Tailcat setup for AgentMux using its existing settings, CLI and native UI capabilities.

Installation and diagnosis target: the Desktop Mac where I clicked this request. Its Host route is local; its original Core Runtime ID is {{runtimeId}}.
First verify your own execution/tool Host identity against that original Runtime. Another device's local is not this Mac. If the target is unknown or different, give instructions or use its existing authorized route; do not install on your own local by assumption.

The connection being edited is a separate target:
{{context}}

Start at the recorded settings target and preparation step. Use the original machine code when present; an unknown cause stays unknown. RPC_METHOD_NOT_FOUND or CONTROL_UNAVAILABLE refers to the serving AgentMux setup capability; check that service before any CLI installation. TAILCAT_CLI_MISSING means that service cannot find the CLI in its PATH, even if another terminal can.
Dependency command, only after confirming the CLI is needed on that exact Mac: brew install tailcat. Check the original CLI/environment, reuse existing keys, and help prepare the missing fields through available public/native capabilities. Do not claim settings drafts have a general Agent write API or are already saved.
Explain any required person action. Keep original keys, private credentials, drafts and healthy Agent work. You may help fill ordinary fields and user-provided public-key drafts through the existing authorized UI. Granting a client access, enabling incoming connections and the final save still require the original person's confirmation; do not write configuration files directly, approve access for them or claim the connection succeeded. Key preparation retains its original local-person permission and must not be bypassed through another UI path. Do not copy private addresses, private keys or raw error output into replies.
~~~
