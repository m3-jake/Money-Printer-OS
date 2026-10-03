# Fresh integration and UI boundary audit — 2026-10-03

Reviewed trader `b36527bc0b3dac00dcb630cd75873176bdffc142` and Lab `4564b3094e21a639df3ed110faa18e5b079bc3af`. Checks ran around 18:05–18:15 EDT. This is a read-only source/runtime audit; no browser interactions, configuration changes, restarts, installs, orders, or code edits were performed. Only this report was written.

## Ranked findings

### P1 — Single-repository CI cannot run newly mandatory paired tests

Trader `tests/coordinator.test.mjs:92` and `:115` unconditionally import modules from a sibling `../money-printer-evolution-lab`. `tests/lab-provenance.test.mjs:12` and `:17` do the same in every fixture. These tests are mandatory through `package.json:54` (`test:lane-contracts`) and `package.json:53` (`test:all`). They neither use the existing `MPO_LAB_ROOT` override nor skip an absent sibling.

`.github/workflows/ci.yml:33` checks out only this repository and `:56` runs `test:all`; the release workflow similarly checks out only trader, then its builder runs the full suite by default. A fresh hosted runner therefore has no files at the import paths and will encounter `ERR_MODULE_NOT_FOUND`. Local paired success does not establish this CI path. Existing shared-core tests explicitly skip an absent sibling (`tests/shared-core-parity.test.mjs:21`), so that protection does not cover the new tests.

Next: create an explicit paired CI job that checks out a pinned compatible Lab revision into a declared path, accepts the same root override in every paired test, and independently verifies the supported standalone suite. Preserve genuine cross-repository behavioral tests rather than silently skipping them everywhere. Lab currently has no `.github` workflow directory, so its full suite is not independently enforced by a repository workflow.

### P2 — Coordinator and funnel failures can leave apparently current retained state

`public/js/mpo-command-center.js:122` and `:123` retain prior coordinator/funnel objects after non-404 HTTP failures or rejected requests. They swallow failures and do not store last-success time, failure reason, or an explicit retained-state flag. These side responses are accepted without checking their schemas. `public/js/mpo-command-graphs.js:59` renders the retained coordinator summary, and its copy builder renders funnel stages without exposing the snapshot's `at` age. Fresh main-summary requests can continue updating the green main connection state (`mpo-command-center.js:32`) while this independent source stops updating.

The shared request layer may surface a general unavailable-source banner, but it does not identify which displayed coordinator/funnel values are retained or when those particular values were observed. A coordinator API response can also be HTTP 200 with a persisted snapshot and `lastError` (`src/core/coordinator.js:461`); the UI does not incorporate that field in its failure state. This is a state-presentation bug, not evidence that a failure occurred during the audit: fresh coordinator and funnel GETs both returned 200.

Next: track each source's validated schema, source timestamp, last successful receive time, and error independently. Retain useful values with a visible source-specific stale label; render unknown separately from zero and never mark a frozen side source current merely because the main summary refreshed. Add failure-after-success and wrong-schema behavioral tests.

### P2 — Trader accepts foreign Host values on read APIs

`src/dashboard.js:561` routes reads without a Host/origin gate. An actual Node `http.request` to loopback8792 with `Host: audit.invalid` returned HTTP200 for `/api/health`; the same probe to Lab8793 returned403. Lab rejects foreign hosts in `src/labServer.js:118`. Trader's POST boundary is stronger (`src/core/http.js:3`): it checks socket loopback address, local Host, same origin, JSON content type, and cross-site fetch metadata. That protects mutations but does not prevent DNS-rebinding reads of operational state.

Next: validate the exact local Host/port on all trader requests before dispatch, preserve supported localhost/IPv6 aliases, and add read-boundary tests. Restrict any intentionally remote API through a separate authenticated interface. This audit made no foreign-origin mutation requests and did not demonstrate a complete browser rebinding exploit.

### P2 — Public compatibility metadata advertises the obsolete equities evaluator

`src/buildInfo.js:17` hardcodes `equities-close-next-open-v2`. The actual trader admission boundary requires v3 (`src/robinhoodEquities.js:32`, `:46`), the Lab evaluator declares v3 (`W:/money-printer-evolution-lab/src/robinhoodEquitiesResearch.js:26`), and the Windows archive builder stamps v3 (`scripts/build-windows-asar.mjs:66`). Fresh installed `/api/state` confirmed that its public `build.provenance.compatibility.equities` still says v2.

Actual candidate admission is not weakened by this metadata discrepancy: the operational gate still requires v3. However, a compatibility inspector or future paired-release gate relying on advertised metadata receives the wrong contract.

Next: share authoritative evaluator/contract constants and report the packaged BUILD compatibility where available. Verify runtime, archive and paired-receipt compatibility together, including a mismatch rejection test. The unified macOS/Windows builder currently writes a smaller BUILD document (`scripts/build-unified.mjs:171`) without the Windows builder's fingerprint/compatibility manifest, so provenance completeness also differs by build path.

### P3 — Lab's Electron navigation and external-scheme policy lags trader

Lab `desktop/main.cjs:163` only handles popup windows, compares URL strings using `startsWith(BASE)`, and forwards other values directly to `shell.openExternal`. It has no `will-navigate` origin restriction. Trader `desktop/main.cjs:346`–`:348` uses exact origin and permits external HTTP/HTTPS only through `desktop/navigation-policy.cjs:2`–`:8`.

Lab does use sandboxing, context isolation, disabled Node integration (`desktop/main.cjs:158`), a restrictive page CSP (`public/lab.html:3`) and escaped/text-only record rendering. Therefore this is a missing defense at the desktop boundary, not a demonstrated feed-to-execution exploit. A future link renderer should not inherit unrestricted custom-scheme launch behavior.

Next: apply a shared exact-origin navigation policy, reject credentials and non-HTTP external schemes, and test lookalike origins, main-frame navigation and popup URLs. Trader dashboard currently has no CSP meta tag or response CSP header; plan a compatible CSP after identifying inline-script requirements, without claiming CSP alone solves the Host gap.

### P3 — Full Lab state polling and latency evidence lack durable budgets

Fresh Lab `/api/state` was631,530 bytes; the visible UI polls full state every two seconds (`public/lab.html:204`). That is approximately18.9MB/minute at this snapshot size before request overhead, with retained scheduler/workbench/evaluation content reparsed repeatedly. Hidden polling falls to ten seconds and overlapping requests are prevented, which are useful existing safeguards. Trader's compact summary was148,596 bytes, close to the historical150KB target; its summary still carries all candidate catalogue summaries and other growing retained structures (`src/commandCenter.js:51`–`:61`). No hard response-size cap was found for these whole state views.

Single sequential GET measurements on the installed pair: trader health1498ms; summary1841ms; coordinator12ms; funnel708ms; Lab health3ms; Lab state41ms. These are samples, not statistically defensible latency percentiles. The existing native renderer artifact reports warm120-frame p50/p95 of16.7/16.8ms, but its rolling HUD frame telemetry reports p95≈99.9ms and max≈1300.1ms (`reports/coordinated-desktop-2026-10-03/native-renderer-metrics.json:21`). A short warm sample does not establish refresh/startup responsiveness under sustained load.

Next: split stable/large Lab records from frequently sampled operational status; add revision/ETag semantics and bounded paging for retained records. Measure source bytes and renderer rolling frame/long-task distributions across startup, refresh, view switching and both resource profiles. Define budgets and regression checks before claiming the interface meets them.

## Verified integration and release coherence

- Both installed `PAIRED-RELEASE.json` documents identify the same pair and installation timestamp2026-10-03T20:33:05.2323173Z. Archive SHA256s freshly matched receipts: trader `652d70801f37c960113f6edceac50fec56a764c1b7c42a6caa6a0f46bf3d8d12`, Lab `b6823f6f00f7f078c4c723eb649e245899802d53a3e39c9a5745a71c7a2d12bc`. BUILD-INFO sidecars identify installed trader89fa8d7764a315fae8503e20aac07261a62ffd6a (alpha.93), Lab9cfaa899b4d6a95d7d753314652b481d7d12dd46 (alpha.28).
- Installed commits precede the audited HEADs, but fresh `git diff <installed> HEAD --name-only -- src desktop scripts public package.json` returned empty in both repositories. The intervening changes are documentation/reports, not a runtime-code installation mismatch. Receipts have a UTF-8 BOM; the audit reader stripped it. No installer corruption was found.
- All21 trader-owned shared-core files matched their declared normalized SHA256, their Lab copies, and both shared-core manifests. No cross-repository scoring-code drift was found.
- Live `/api/command-center?view=summary`, `/api/coordinator`, `/api/copy-funnel`, Lab `/api/health` and Lab `/api/state` returned200 and their expected v1 schemas. Fresh copy funnel had11 books and zero reported read errors. Coordinator reported live source, `executionAuthority:false` and `liveAuthority:false`; funnel reported `paperOnly:true`. These endpoint checks do not establish profitable or qualified strategies.
- HUD history/groups/quotes/coordinator/funnel are dispatched through the shared lazy route table (`src/hudRoutes.js:10`). History enforces64 IDs,2000 points per ID and40000 total points (`src/marketHistory.js:21`); quotes cap pages at500. Equity history uses known early-close sessions, preserves IEX/SIP source and unknown availability, and labels inferred pre-calendar closes (`src/marketHistory.js:93`, `:178`).
- The advisory request/ack schemas match producer and consumer; Lab dispatch runs through existing scheduler/fingerprints and acknowledges no execution authority (`W:/money-printer-evolution-lab/src/coordinatorRequests.js:14`, `:20`, `:36`, `:41`). Research profile control waits for Lab acknowledgment before queuing the trader action (`src/dashboard.js:723`); UI wording explicitly distinguishes acknowledgment from queued application (`mpo-command-center.js:132`).
- Lab separates service heartbeat, labeled outcomes, trading activity and strict qualification (`public/lab.html:31`, `:56`, `:159`). Its settings drafts survive refresh, detect upstream conflicts, require backend acknowledgment, and distinguish worker application at the next boundary (`public/lab.html:184`–`:205`).

## Coverage and limits

Source review covered both desktop supervisors, trader navigation policy and local mutation gate, Lab Host/POST gate and CSP, route dispatch, market-history bounds/provenance, summary construction, coordinator request/ack integration, current UI refresh/retention/control logic, shared-core manifests, CI/release packaging and paired install receipts. Runtime reads checked only safe aggregate fields; no secrets, wallet identities, raw journals or personal data are reproduced here.

No fresh screenshot, keyboard-accessibility, canvas-rendering, new-profile application or performance experiment was performed. Existing screenshots and native metrics were reviewed as historical evidence and are not represented as fresh visual verification. No full suites or builds were rerun, so the CI finding is a concrete source-path proof rather than a hosted-run log. Browser and desktop interaction belongs to the parent audit. Provider availability, strategy economics, full input trust/execution safety and data durability are outside this sub-audit.

Recommended implementation order: paired CI portability; source-specific UI freshness/schema contracts; trader read Host gate and shared Electron navigation; authoritative compatibility metadata; bounded status/paging and measured performance budgets. Keep paper-only/no-live/no-paid-model boundaries intact throughout.

