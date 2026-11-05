# T17 fixture-only skill walkthrough

This is a deterministic workflow fixture for the remembrancer skill gate. It does not invoke Taskwarrior, read a personal archive, mock an approval engine, or add runtime behavior.

## Fixture records

- `T1`: existing task, `Investigate ranking drift`.
- `P1`: inferred add, `Send the comparison`.
- `P2`: inferred modify, annotate `T1` with `The comparison is ready.`.
- `P3`: inferred completion, close `T1`.

## Walkthrough

1. Begin seed batch `B1`; read every evidence page and present `P1`, `P2`, and `P3`.
2. The user accepts `P1`, edits `P2` to `The comparison is ready for review.`, and leaves `P3` undecided. Keep `B1` open. Do not finish.
3. The user dismisses `P3`. Re-read the fixture task records before writing.
4. Apply the edited `P2` and verify the resulting record. The `P1` write fails. Report the failure and cancel `B1`.
5. Cancellation changes no checkpoint, seed default, or staged enrollment. It does not undo the already verified `P2` write. The fixture task records are now the source of truth for retry reconciliation.
6. Retry with batch `B2`. Re-read the current fixture records, suppress `P2` because it is already applied, and propose `P1` only if it is still needed.
7. After the user accepts `P1`, apply and verify it, then finish `B2` after all evidence pages are consumed.
8. If the user abandons before decisions, cancel without writes or coverage changes.

## Acceptance predicates

- The skill, not the review tool, owns accept/edit/dismiss decisions, Taskwarrior rechecks, writes, and verification.
- An unresolved proposal keeps the batch open.
- A failed accepted write prevents finish and leads to cancel.
- A verified write survives cancellation and is deduplicated on retry.
- Seed evidence never authorizes a task write by itself.
