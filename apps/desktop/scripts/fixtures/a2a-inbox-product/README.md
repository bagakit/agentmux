# Synthetic native Agent for private integration checks

`native-agent.mjs` supplies the controlled native actor used by the bootstrap and capsule integration checks. It retains the original native transcript and input protocol identities; it is not a live model.

A2A reading verification uses the production-component scene in [a2a-reference-reading](../a2a-reference-reading/) and the registered Renderer/preload/Main/Core bridge test. It does not build or copy an entire Desktop App, register a private Host service, or replace a native clipboard owner through Inspector. Real-model delivery remains the separate installed-bundle sample.
