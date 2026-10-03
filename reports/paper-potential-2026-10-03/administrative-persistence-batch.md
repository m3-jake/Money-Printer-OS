# Administrative action durability

Observed installed-runtime failure: a queued FAST_PAPER_STEADY action was drained and applied only in the current cycle's memory; a later remote position-price stall prevented the final state save, so the persisted profile remained FAIR.

Administrative actions now run before network-dependent entry/exit actions, preserving administrative relative order. Each accepted control immediately publishes only its changed runtime keys and pause/kill/error/autonomy controls onto a freshly loaded account. It never publishes the current cycle's potentially stale positions, cash, history, market or metrics merely to save a setting. Accepted pending administrative actions are removed from persisted pending actions. Failed control publication requeues the remaining actions and fails visibly.

Functional regressions verify profile/pause/kill survival without the final cycle save, no toggle replay on restart, a profile queued after an exit remaining durable while the exit's transport is held pending, and preservation of newer positions/cash/history/unrelated runtime values. Admin and existing trade-path suites 10/10. Fixtures use isolated temporary data; original runtime data untouched.

Cancellation review: current held-pool refresh uses the shared cycle signal; marketRequests now bounds both transport and body parsing with awaitAbortable and a 6500ms deadline. Coalesced calls honor caller cancellation. No additional independent cancellation defect was found in the held-position refresh path; root/copy agent own that transport repair and installed runtime verification.
