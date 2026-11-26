# Writing capture fixtures

These are private test helpers, not public tool or storage formats.

- Use `capture-reviewer.ts` to read the complete installed skill, then every evidence page in order. Follow returned cursors for task, proposal and supporting-context reads.
- Return reviewer-selected records and dispositions, including exact references and branch-specific states. Assert saved intent and evidence, not minimum request counts or host discovery completeness.
- Submit once through `remembrancer_submit`, alone in its tool-call batch. Empty records and dispositions are valid only after complete delivery.
- Respect the model's output ceiling, including tool-call framing. Large finalized results fail closed; there are no retained-value handles or host-side completion steps.
- Keep scenario answers in the test. SDK suites use real continuing sessions and loopback HTTP transport, preserving tool history across requests.

`capture-sizing-sdk.test.ts` exercises 512- and 4,096-token output ceilings, bounded exact reads, retained context and terminal submission limits. These fixtures test orchestration, not live-provider latency, token usage or semantic recall.
