# capsule open

<!-- amux:content -->
Request display of the exact saved Capsule with amux capsule open --input FILE|-.
Read amux space --skill and browser --skill first. Reuse the confirmed Browser for that
Capsule; placement is used only when a new Browser is needed, not to move a reused page.

With an attached Agent Region, normally provide an explicit readable split in the same
Tab. Do not rely on the Desktop's new-Tab default when placement is omitted. Choose the
anchor and direction from the actual Tab geometry and content; the anchor Region is not the result Region.
Focus discoverability and new-Tab/tool/readability exceptions follow amux space --skill.
An explicit user request for a new Tab remains valid. These are placement instructions,
not an additional input permission or approval gate.

Replace CAPSULE_ID, ORIGINAL_OPERATION and REGION_ID with the exact original identities:

```json
{"capsuleId":"CAPSULE_ID","operationId":"ORIGINAL_OPERATION","placement":{"kind":"split","direction":"right","region":{"kind":"region","regionId":"REGION_ID"}}}
```

Directions are left, right, up and down. When a new Tab is appropriate, use the exact
anchor Tab instead of dropping placement:

```json
{"capsuleId":"CAPSULE_ID","operationId":"ORIGINAL_OPERATION","placement":{"kind":"new-tab","after":{"kind":"tab","tabId":"TAB_ID"}}}
```

Replace TAB_ID with the exact inspected Tab. The API still accepts omitted placement;
presentation belongs to the Host's adapter. This guidance does not change its default or
the original owner, layout or lifecycle.
Opening requests presentation of the original page; navigation and keyboard input focus
are separate facts. It does not authorize replacing another page or taking human control.

Read rendering.status. Available rendering supplies exact browserId, tabId, regionId and
optional workspaceId; it does not say created or reused. Report those returned identities
and use amux space inspect --region REGION for actual display occurrences and geometry.
An unavailable rendering has its own reason and may leave the HTTP endpoint available.
Neither service availability nor rendering confirms Agent delivery or task completion.

After an unknown reply, keep the original Capsule and operationId and read
amux capsule operation inspect --input FILE|- with {"operationId":"ORIGINAL_OPERATION"}.
A pending original operation is still unknown. Do not replay open, create a replacement
Browser or infer historical completion from a current page. Retain the original page,
user input and healthy Agent capabilities.
