# Writing capture fixtures

These are private test helpers, not public tool or storage formats.

- Follow host-provided cursors and `maxObservations`, not fixed slice sizes or minimum call counts. Assert saved intent and exact evidence instead.
- Exact candidates may be inline or read through `work.page.fields`. Use `captureFields(work.page)` and reconstruct string chunks by path and offset. Retained-value inspection uses scalar `detail.page` and `nextIndex` instead.
- Accepted, unmatched, unambiguous add drafts can skip materialization. To exercise materializer rejection, use a matched target or an incomplete folded draft, and assert the invalid reply reached validation.
- Respect the model's output ceiling, including tool-call framing. Copy large retained values through issued handles rather than returning oversized fixture replies.
- Reuse `providerInstruction` and `writeCompletion` for loopback SDK transport; keep scenario answers in the test.

`capture-sizing-sdk.test.ts` compares 512- and 4,096-token output ceilings with equal conservative input budgets. It reports extraction calls separately from total model calls, plus serialized provider payload sizes in UTF-8 bytes. This measures orchestration, not live-provider latency, token usage or semantic recall.
