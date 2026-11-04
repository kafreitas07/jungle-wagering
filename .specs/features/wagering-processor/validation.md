# Wagering Processor - Validation Report

**Verdict: PASS (with advisories, no blocking gap)**
**Verifier:** independent fresh-context pass (author != verifier), evidence-or-zero.
**Examined:** commits `13c8592..3975c40` (HEAD of `chore/delivery`, 79 commits, 10 phases) plus the uncommitted working tree
(19 modified files, `README.md`, `Dockerfile`, `.dockerignore`, `test/unit/infrastructure/error-detail-in-logs.test.ts` untracked; `spike/` deleted).
All gate/sensor numbers below were measured on that working tree.

## 1. Gate

| Step | Result |
| --- | --- |
| `bun run typecheck` (`tsc --noEmit`) | exit 0 |
| `bun run test:unit` | 432 pass, 0 fail, 20 files |
| `bun run test:integration` (real Postgres :5440 `wagering_test` + LocalStack :4566) | 379 pass, 0 fail, 28 files (74 s) |
| `bun run test:concurrency` (3 files, includes 3 separate OS processes) | 18 pass, 0 fail (21 s) |
| Total | 829 pass, 0 fail, 0 skipped (no `.skip/.todo/.only` in `test/`) |

Suites were run sequentially (single shared DB). No mocks of Postgres or SQS: the only doubles are spy wrappers
around the real SQS adapter, and fake `MetricsPort`/`LoggerPort` (explicitly allowed by tasks.md).
Final invariant: `assertReconciled`/`assertReconciledByApi`/`assertReconciledViaApp` (`test/support/reconcile.ts`) compute
`wallet.balance == Σ CREDIT − Σ DEBIT` in exact `numeric` in the DB, plus last `balance_after == balance`, and the
endpoint is called too; used by every http/use-case/messaging/concurrency test that touches a wallet.

## 2. Discrimination sensor (expanded tier, P0 paths)

Isolated scratch copy: `.../scratchpad/verifier-copy` (rsync without `.git`/`node_modules`, symlinked `node_modules`).
Each mutation was applied to the copy only, the relevant test files were run, then the file was restored. No
migration was mutated (the up/down/up test would rewrite the shared database). Real-tree `git status --porcelain`
identical before/after (see section 6).

| # | Mutation (file) | Tests run | Result |
| --- | --- | --- | --- |
| M01 | `Money.from` drops the sign of negatives (`money.ts`) | unit money | KILLED (3 fail: "normalizes -1.5", "sub-unit negatives", "isZero/isPositive/isNegative") |
| M02 | `Money.equals` ignores currency | unit money | KILLED ("equals with another currency returns false") |
| M03 | `Money.subtract` computes `+` | unit money + wallet | KILLED (7 fail incl. "subtract that goes below zero") |
| M04 | `Wallet.debit` rejects exact-zero balance (`<= 0n`) | unit wallet + wager | KILLED (3 fail: "brings the balance to exactly 0.00") |
| M05 | `lockById` without `PESSIMISTIC_WRITE` (no `SELECT … FOR UPDATE`) | unit-of-work + submit | KILLED (3 fail: "concurrent debits serialize", "55P03 near limit", "many BETs serialize") |
| M06 | `UPDATE … WHERE version = :expected` predicate removed | unit-of-work | KILLED ("stale version affects 0 rows and throws OptimisticLockError") |
| M07 | idempotency payload-hash comparison disabled | submit-idempotency + http wagering | KILLED (8 fail: same key + another amount/kind/round/game) |
| M08 | replay returns `replay: false` | same | KILLED (9 fail) |
| M09 | `hasProcessedReversal` ignores ROLLBACK | submit + repositories + http-concurrency | KILLED (repositories "a ROLLBACK that was PROCESSED counts"; see advisory A5) |
| M10 | outbox claim does not set `locked_until` (no lease) | outbox-publisher | KILLED (3 fail: "claimed by exactly one", "lease live / expires", "claim already committed") |
| M11 | outbox marks failed publications as published | outbox-publisher | KILLED (5 fail: OUT-10 attempts/backoff) |
| M12 | inbox payload conflict treated as duplicate | sqs-consumer + repositories | KILLED (2 fail: tryRecord conflict, DLQ on divergent payload) |
| M13 | consumer acks transient errors instead of retry | sqs-consumer-resilience (int+unit) | KILLED (3 fail: not acked + backoff, FIFO no overtake, DLQ after 5) |
| M14 | IDEMPOTENCY_KEY_REUSED / EXTERNAL_ID_CONFLICT acked without DLQ | sqs-consumer | KILLED (2 fail) |
| M15 | pending reference retries never exhaust | pending-reference-worker | KILLED (4 fail: "after 10 attempts REJECTED REFERENCE_NOT_FOUND") |
| M16 | `PENDING_REFERENCE` answered 201 instead of 202 | integration/http + unit http | KILLED (2 fail) |
| M17 | reconciliation always `consistent = true` | reconcile-wallet + http reconciliation | KILLED (5 fail) |
| M18 | ledger entry not appended on balance change | submit-wager-transaction | KILLED (16 fail) |
| M19 | external-id conflict check removed | submit-idempotency + http + http-concurrency | KILLED (3 fail incl. "20 different keys: one wins") |
| M20 | `lock_timeout` not set per transaction | unit-of-work + error-contract | KILLED (2 fail: 55P03, 503 CONCURRENCY_CONFLICT) |
| M21 | payload hash ignores `money.amount` | payload-hash + submit-idempotency | KILLED (4 fail) |
| M22 | unique-violation races not retried (`RACE_CONSTRAINTS = []`) | http-concurrency + submit-concurrency-retry | KILLED (2 fail "CONC-07") |
| M23 | `inbox_duplicates_total` not incremented | sqs-consumer | KILLED (2 fail) |
| M24 | outbox claim ignores `published_at is null` (republish forever) | outbox-publisher | KILLED (16 fail) |
| M25 | `Retry-After` header dropped on 503 | http + unit http | KILLED (2 fail) |
| M26 | `Idempotency-Key` no longer required | http | KILLED (1 fail) |
| M27 | `assertPositiveMovement` disabled (zero/negative credit/debit) | unit wallet + persistence | KILLED (5 fail) |
| M28 | DLQ final-receive off by one (`>` instead of `>=`) | sqs-consumer-resilience (int+unit) | KILLED (2 fail) |
| X1 | `nativeUpdate(..., expectedVersion + 0)` (typed by mistake; semantically equivalent) | submit | SURVIVED - equivalent mutant, discarded, not a test weakness |
| X2 | `WALLET_PLAYER_MISMATCH` row of `BY_APPLICATION_CODE` 422 -> 409 (`http-errors.ts`) | http | SURVIVED - the row is dead code on the submission path (controller maps it to `HttpFailure(422)` itself) and no route raises it elsewhere; see advisory A6 |

**28 behaviour-level mutations injected: 28 killed, 0 survived.** Two further probes survived and are classified as
equivalent / dead code (X1, X2). Not mutated (not safe on the shared DB): the SQL migrations (CHECK/UNIQUE/trigger).
Those are covered instead by tests that violate each constraint through raw SQL (section 3, DB-*, LEDG-*).

## 3. Spec-anchored coverage (evidence-or-zero)

Paths are relative to `test/`. "title" means the cited line is the test whose title states the exact outcome; the
quoted expression is the load-bearing assertion in its body. Result: PASS = assertion value matches the spec outcome;
GAP = no evidence; PREC = spec-precision gap (spec not precise enough to choose an outcome).

### Money (MON)
| ID | Evidence | Result |
| --- | --- | --- |
| MON-01 | integration/persistence/wallet-ledger-mappers.test.ts:162 `expect(readFileSync(file)).not.toMatch(/(balance\|amount\|balanceBefore\|balanceAfter)\w*\s*:\s*number/)`; unit/domain/money/money.test.ts:40 stores cents as bigint; wallet-ledger-mappers:47 round-trip `numeric(20,2)` incl. `999999999999999999.99`; money.test.ts:45 `Money.from({amount: 10.5})` -> `InvalidMoneyError` | PASS |
| MON-02 | unit/domain/money/money.test.ts:33 `expect(money.toJSON()).toEqual({amount:'25.00',currency:'BRL'})`; :24 `toString()` `'999999999999999999.99'` | PASS |
| MON-03 | money.test.ts:61 `expect(sum).not.toBe(a)` / `a.toString()` `'10.00'`; :73 subtract; :85 negate | PASS |
| MON-04 | money.test.ts:106 `expect(result.toString()).toBe('-5.00')`, `isNegative()` true | PASS |
| MON-05 | money.test.ts:155-156 `expect(operation).toThrow(CurrencyMismatchError)` (add/subtract/isLessThan); :160 `equals` is `false` (matches Assumptions) | PASS |
| MON-06 | money.test.ts:168-186 table `NaN, Infinity, 1e3, …` -> `toThrow(InvalidMoneyError)` | PASS |
| MON-07 | money.test.ts:191 `expect(() => Money.from({amount:'1.00', currency})).toThrow(InvalidMoneyError)` for `brl, BR, BRLL, '', B1L` | PASS |
| MON-08 | unit/contracts/contracts.test.ts:42 `expect(moneyInputSchema.safeParse({amount, currency:'BRL'}).success).toBe(false)` for `'25','25.5','-1.00','1e3'`; integration wagering.test.ts:204-215 (400 `VALIDATION_ERROR`) | PASS |
| MON-09 | unit/domain/domain-purity.test.ts:13 `expect(line).not.toMatch(/@nestjs\|@mikro-orm\|reflect-metadata/)` per domain file | PASS |

### Wallet (WAL)
| ID | Evidence | Result |
| --- | --- | --- |
| WAL-01 | integration/http/wallets.test.ts:28-29 `status 201`, body `{id, playerId, balance:{amount:'1000.00',currency:'BRL'}, version:1}` | PASS |
| WAL-02 | integration/use-cases/open-wallet.test.ts:38 OPENING row (`PROCESSED`, provider `internal`), :61 CREDIT entry from `0.00`, `wallet_version 1` | PASS |
| WAL-03 | open-wallet.test.ts:95-96 `balance '0.00'`, no `wager_transactions` row (and no ledger/event) | PASS |
| WAL-04 | wallets.test.ts:40-41 `409 WALLET_ALREADY_EXISTS`; open-wallet.test.ts:129-130 10 concurrent: `winners` length 1, `losers` 9; wallets-transactions-schema.test.ts:38 UNIQUE | PASS |
| WAL-05 | wallets.test.ts:89-90 `200` body `{id, playerId, balance 70.00, version 2}` | PASS |
| WAL-06 | wallets.test.ts:97-98 `404 WALLET_NOT_FOUND`; :101 malformed id -> 400 | PASS |
| WAL-07 | unit/domain/wallet/wallet.test.ts:61-62 `version` 2 after one debit; :111 +1 per change; integration submit-wager-transaction.test.ts:108 LOSS `{balance:'100.00', version:1}` | PASS |
| WAL-08 | wallet.test.ts:78 `toThrow(InsufficientFundsError)` + balance unchanged; schema test wallets-transactions-schema.test.ts:25-26 `code 23514 wallets_balance_non_negative`, :29 UPDATE rejected | PASS |
| WAL-09 | wallet.test.ts:130 `toThrow(CurrencyMismatchError)`; wagering.test.ts:194-195 `422 WALLET_PLAYER_MISMATCH` and CURRENCY_MISMATCH nothing stored; schema :199-202 composite FK rejects | PASS |

### Submission (TXN)
| ID | Evidence | Result |
| --- | --- | --- |
| TXN-01 | integration/http/wagering.test.ts:29-30 `201` body `{transactionId,status:'PROCESSED',balance,idempotentReplay:false}`; submit-wager-transaction.test.ts:62 one DEBIT entry + version | PASS |
| TXN-02 | wagering.test.ts:120-121 `422` + `failureCode`, unchanged balance; submit-wager-transaction.test.ts:168-175 helper: `REJECTED`, `failure_code`, balance unchanged, 0 ledger rows | PASS |
| TXN-03 | submit-wager-transaction.test.ts:119 `balanceAfter '25.50'` (WIN credit) + :87 BET->WIN->LOSS ledger | PASS |
| TXN-04 | submit-wager-transaction.test.ts:107-109 LOSS `PROCESSED`, `{balance:'100.00',version:1}`, `ledgerRows` length 1 (the opening only) | PASS |
| TXN-05 | unit/contracts/contracts.test.ts:78 OPENING rejected; integration/messaging/sqs-consumer.test.ts:218-219 OPENING via SQS: 0 transactions, 0 inbox rows | PASS |
| TXN-06 | contracts.test.ts:96-100 `success false`, path `referenceExternalTransactionId`; schema :144-146 `/wager_transactions_reference_required/` | PASS |
| TXN-07 | wagering.test.ts:177 `422 WALLET_NOT_FOUND` (not 404); error asserted not persisted by :242 | PASS |
| TXN-08 | wagering.test.ts:194-195; schema :196-202 | PASS |
| TXN-09 | integration/persistence/transaction-inbox-outbox-mappers.test.ts:87-159 (round-trip of every field of PROCESSED/REJECTED/PENDING/FAILED, exact decimal strings); schema test wallets-transactions-schema.test.ts:161-181 | PASS |
| TXN-10 | wagering.test.ts:253,275,285 (by id, rejected shows failure code, by provider+external id), :296 `404 TRANSACTION_NOT_FOUND` | PASS |
| TXN-11 | unit/domain/wager/wager-transaction.test.ts:198-232 `forbidden transitions` table -> `InvalidTransactionStateError`; :319 rehydrated terminal still refuses | PASS |
| TXN-12 | wager-transaction.test.ts:123-188 each allowed transition; :232 `PENDING_REFERENCE -> PENDING_REFERENCE` throws | PASS |
| TXN-13 | contracts.test.ts:115,122 `BET/WIN/REFUND/ROLLBACK 0.00` rejected; :141 `LOSS 0.00` accepted | PASS |
| TXN-14 | contracts.test.ts:89; wager-transaction.test.ts:91 `internal` refused | PASS |

### Reversals (REV)
| ID | Evidence | Result |
| --- | --- | --- |
| REV-01 | persistence/repositories.test.ts:75 `findByExternalId` is how a reference is resolved; submit-wager-transaction.test.ts:262 | PASS |
| REV-02 | unit wager-rules.test.ts:343-349 table player/wallet/provider/round/currency -> `REFERENCE_MISMATCH`; integration submit:196-202 `expectRejection(..., 'REFERENCE_MISMATCH', '975.00')` | PASS |
| REV-03 | submit-wager-transaction.test.ts:205,214 `INVALID_REFERENCE_KIND`; wager-rules.test.ts:247,313 | PASS |
| REV-04 | submit:240 `AMOUNT_MISMATCH`; wager-rules.test.ts:262,325 | PASS |
| REV-05 | submit:231 `REFERENCE_NOT_PROCESSED`; wager-rules.test.ts:355 REJECTED/FAILED | PASS |
| REV-06 | submit:268-269 `status 'PROCESSED'`, `referenceTransactionId == bet.transaction.id` | PASS |
| REV-07 | submit:275 ROLLBACK of BET credits (:291-292 balance `'100.00'`), :285 WIN debits, :297 REFUND debits (`'975.00'`) | PASS |
| REV-08 | submit:253-259 REFUND then ROLLBACK -> `REFERENCE_ALREADY_REVERSED`, balance `'1000.00'`; schema wallets-transactions-schema.test.ts:119 partial UNIQUE index; concurrency/http-concurrency.test.ts:171-173 `[201,422]` + `REFERENCE_ALREADY_REVERSED` x10; :179 10 refunds -> 1 credit | PASS |
| REV-09 | submit:186 `REVERSAL_INSUFFICIENT_FUNDS` (distinct from INSUFFICIENT_FUNDS), balance unchanged, persisted | PASS |
| REV-10 | submit:223 self reference -> `INVALID_REFERENCE_KIND`; wager-rules.test.ts:458,469 | PASS |

### Out-of-order references (PREF)
| ID | Evidence | Result |
| --- | --- | --- |
| PREF-01 | submit:327-328 `PENDING_REFERENCE`, `failureCode null`, wallet untouched; wagering.test.ts:145 `202` and replay `202`; events `WagerTransactionPendingReference` | PASS |
| PREF-02 | integration/messaging/pending-reference-worker.test.ts:105-116 `reference_attempts == attempt`, backoff; :125 ceiling; unit wager-transaction.test.ts:244 1,2,4…300 s | PASS |
| PREF-03 | pending-reference-worker.test.ts:76-78 balance `'1000.00'` then `'960.00'` after the BET exists | PASS |
| PREF-04 | pending-reference-worker.test.ts:152-153 `REJECTED` + `REFERENCE_NOT_FOUND` after 10 attempts, rejection event, balance untouched | PASS |
| PREF-05 | pending-reference-worker.test.ts:208-209 two workers: processed total `1`, failed+deferred `0`. Implemented via wallet row lock + re-read (equivalent to the spec's "or equivalent") | PASS |
| PREF-06 | pending-reference-worker.test.ts:259-261 `failed 1`, status `FAILED`, `PROCESSING_FAILED`, no rejection event | PASS |

### Idempotency (IDEM)
| ID | Evidence | Result |
| --- | --- | --- |
| IDEM-01 | wagering.test.ts:210-211 `400 IDEMPOTENCY_KEY_REQUIRED` (missing and blank) | PASS |
| IDEM-02 | schema wallets-transactions-schema.test.ts:85-86 `23505 wager_transactions_idempotency_key`, :104 external id; no in-memory cache (grep: none in `src/`) | PASS |
| IDEM-03 | integration/use-cases/submit-idempotency.test.ts:58 same transaction; :83 replay `balanceAfter '975.00'` (balance of the original); wagering.test.ts:39 `idempotentReplay true` | PASS |
| IDEM-04 | submit-idempotency.test.ts:154 + wagering.test.ts:88 `409 IDEMPOTENCY_KEY_REUSED`, nothing applied | PASS |
| IDEM-05 | submit-idempotency.test.ts:178 + wagering.test.ts:102 `409 EXTERNAL_ID_CONFLICT` | PASS |
| IDEM-06 | concurrency/http-concurrency.test.ts:35-40 50 parallel: statuses all 201, `Set(transactionId).size == 1`, `idempotentReplay===false` x1, `===true` x49, 1 transaction, 1 DEBIT, balance `'975.00'` | PASS |
| IDEM-07 | unit/application/payload-hash.test.ts:24,28 equals SHA-256 of the canonical JSON (golden values); :66 metadata ignored; killed M21 | PASS |
| IDEM-08 | integration/observability/metrics.test.ts:113 `idempotent_replays_total == replays + 1`; :117 `idempotency_conflicts_total` | PASS |

### Concurrency (CONC)
| ID | Evidence | Result |
| --- | --- | --- |
| CONC-01 | concurrency/http-concurrency.test.ts:93-95 `[201,422]`, `INSUFFICIENT_FUNDS`, repeated 20x (balance 20.00, 1 DEBIT asserted in body) | PASS |
| CONC-02 | integration/persistence/unit-of-work.test.ts:134 locking one wallet does not block another; http-concurrency.test.ts:145-146 `status 201`, `elapsed < 600` with another wallet locked | PASS |
| CONC-03 | http-concurrency.test.ts:126-128 10 wallets x 5 BETs: all 201, per-wallet balance `${50+index}.00` | PASS |
| CONC-04 | concurrency/multi-process.test.ts:86-87 (3 OS processes) 60 BETs all 201, balance `'700.00'`; :118-119 one 201, `PROCESSES-1` x `422 INSUFFICIENT_FUNDS`; reconciliation | PASS |
| CONC-05 | integration/use-cases/submit-concurrency-retry.test.ts:69-70 PROCESSED after lock timeout clears, `lock_conflicts_total >= 1`; unit/application/concurrency-retry.test.ts:89-103 20/60/180 ms backoff; killed M22 | PASS (retry limit not in spec: PREC, advisory A3) |
| CONC-06 | unit-of-work.test.ts:46-47 `55P03` after >= 250 ms; :86 `save` expected version; killed M05/M06/M20 | PASS |
| CONC-07 | error-contract.test.ts:148-149 `503 CONCURRENCY_CONFLICT`, nothing applied, same request works after; submit-concurrency-retry.test.ts:85-86 `ConcurrencyConflictError`, `lock_conflicts_total == 3` | PASS |
| CONC-08 | ledger-inbox-outbox-schema.test.ts:89-94 duplicate `(wallet_id, wallet_version)` rejected | PASS |

### Ledger (LEDG)
| ID | Evidence | Result |
| --- | --- | --- |
| LEDG-01 | submit:109 exactly 1 entry for BET/WIN, 0 for REJECTED (:174), LOSS none; repositories.test.ts:259-281 atomic rollback (no wallet/tx change when append fails); killed M18 | PASS |
| LEDG-02 | unit/domain/ledger/wallet-ledger-entry.test.ts:45-57 incoherent arithmetic rejected; schema :56-61 `/wallet_ledger_entries_arithmetic/` | PASS |
| LEDG-03 | ledger-inbox-outbox-schema.test.ts:117-123 UPDATE `message contains 'immutable'`; :126 DELETE; :136 TRUNCATE | PASS |
| LEDG-04 | schema :32 amount > 0, :40/:48 balances >= 0, :80-84 UNIQUE(transaction_id), :99 composite FK, :107 FK transaction | PASS |
| LEDG-05 | integration/use-cases/list-ledger.test.ts:79-80 pages `[50,50,20]`, versions `120..1`; :104-105 entry written between pages neither duplicated nor skipped; :142 opaque cursor | PASS |
| LEDG-06 | wallets.test.ts:159-165 `limit` 0/201/-3/abc/1.5 -> `400 VALIDATION_ERROR`; contracts.test.ts:286 | PASS |
| LEDG-07 | wallet-ledger-entry.test.ts:110-112 `expect(() => (entry.amount = …)).toThrow()` (frozen/readonly) | PASS |

### SQS consumer (SQS)
| ID | Evidence | Result |
| --- | --- | --- |
| SQS-01 | integration/messaging/sqs-consumer.test.ts:73 row `{status:'PROCESSED', balance_after:'975.00'}` | PASS |
| SQS-02 | sqs-consumer.test.ts:139-140 inbox row `consumer_name 'wager-transactions-consumer'`; unit-of-work atomicity repositories.test.ts:190; killed M12 | PASS |
| SQS-03 | sqs-consumer.test.ts:119-122 `inbox_duplicates_total == 1`, 1 transaction; killed M23 | PASS |
| SQS-04 | sqs-consumer.test.ts:437 `expect(spy.stateAtDelete).toEqual([{committed:true}])` | PASS |
| SQS-05 | sqs-consumer.test.ts:80-89 REJECTED stored and message acknowledged, not retried | PASS |
| SQS-06 | sqs-consumer-resilience.test.ts:122-125 DB down: visibility change, no ack, processed once DB returns; :174 `adapter.visibility == [4,8,16,32,0]`; killed M13 | PASS (base 2 s ambiguity: PREC, advisory A2) |
| SQS-07 | sqs-consumer-resilience.test.ts:171-174 message ends in DLQ after 5 receives, `dlq_messages_total`; sqs-adapter.test.ts:99,193 real redrive in LocalStack; killed M28 | PASS |
| SQS-08 | sqs-consumer.test.ts:194-195 `dlqBodies == ['this is { not json']`, queue empty; :199,211,222,232,241 other malformed cases | PASS |
| SQS-09 | concurrency/messaging-recovery.test.ts:58-59 consumer process `SIGKILL`ed after commit before ack (fault injection), 1 transaction after redelivery; sqs-consumer.test.ts:457-460 ack failure then duplicate | PASS |
| SQS-10 | sqs-consumer-resilience.test.ts:216 `done.map(rows => rows.length) == [1,0,0]` (in-flight finishes, others released with visibility 0 and picked by another instance); :244 grace period `< 1500` ms; multi-process.test.ts:68 / support/process.ts:89 real `SIGTERM` | PASS |
| SQS-11 | sqs-consumer.test.ts:222 reserved provider `internal` refused as on HTTP; contracts.test.ts:241 same business rules | PASS |
| SQS-12 | sqs-consumer.test.ts:266-269 first processed, second dead-lettered (`depth(dlq) >= 1`), `inbox_payload_conflict_total`; killed M12 | PASS |
| SQS-13 | sqs-consumer.test.ts:287-290 / :299 both conflicts -> DLQ + counted + nothing written; killed M14 | PASS |

### Outbox (OUT)
| ID | Evidence | Result |
| --- | --- | --- |
| OUT-01 | repositories.test.ts:259 rollback leaves no outbox row; open-wallet.test.ts:77 events in the same transaction | PASS |
| OUT-02 | integration/messaging/outbox-publisher.test.ts:71-72 `beforeCommit 0`, `queueBeforeCommit 0`; :91-92 rollback never reaches the queue; :101-102 `{claimed:2,published:2,failed:0}`, group = wallet, dedup id = event id | PASS |
| OUT-03 | submit-wager-transaction.test.ts:144 `['WagerTransactionProcessed','WalletBalanceChanged']`; LOSS :102; OPENING open-wallet.test.ts:77 | PASS |
| OUT-04 | integration-events.test.ts:41-49 `WalletBalanceChanged` envelope; submit:102 (LOSS: no balance event); open-wallet.test.ts:92 zero wallet: none | PASS |
| OUT-05 | pending-reference-worker.test.ts:140; submit:175 `outbox_messages … 'WagerTransactionRejected'` length 1 | PASS |
| OUT-06 | submit:322 + integration-events.test.ts:175 `WagerTransactionPendingReference` names the reference | PASS |
| OUT-07 | unit integration-events.test.ts:64 stable `toJSON` envelope; :41 `eventType`, `version` | PASS |
| OUT-08 | outbox-publisher.test.ts:151-152 `claimedTwice == []`, union size = sum; killed M10 | PASS |
| OUT-09 | outbox-publisher.test.ts:164-173 rows hidden while lease live (`during.claimed 0`), published by another instance after expiry; concurrency/messaging-recovery.test.ts:166 3 instances, one killed under load | PASS |
| OUT-10 | outbox-publisher.test.ts:194-195 `{claimed:2,published:0,failed:2}`, `attempts 1`; :218 backoff doubles; :234 attempts kept; metrics.test.ts:156 `outbox_pending`; killed M11 | PASS |
| OUT-11 | unit outbox-message.test.ts:60-63 backoff `[1000,2000,4000,8000,16000,32000,60000,60000]`; sqs-adapter.test.ts:152 dedup by event id | PASS |
| OUT-12 | outbox-publisher.test.ts:297 `expect(observed).toEqual([{lockable:true, leaseVisible:true, idleInTransaction:0}])` during the network call | PASS |

### Reconciliation (REC), HTTP contract (API), Observability (OBS), Auth (AUTH), DB, TEST, DOC
| ID | Evidence | Result |
| --- | --- | --- |
| REC-01 | http/reconciliation.test.ts:31-32 `200`, body `{walletId, storedBalance, calculatedBalance, difference, consistent, checkedEntries}` | PASS |
| REC-02 | reconcile-wallet.test.ts:112-113 `consistent false`, `storedBalance '950.00'`, balance not corrected, error log, metric; :133 repeated count; killed M17 | PASS |
| REC-03 | reconciliation.test.ts:57 `404 WALLET_NOT_FOUND`; reconcile-wallet.test.ts:147 | PASS |
| REC-04 | test/support/reconcile.ts (SQL + endpoint) used in 15 test files incl. all concurrency files | PASS |
| API-01 | error-contract.test.ts:31 (201), :37 (202), :46 (400), :61 (404), :78 `[409,409,409]`, :86 (422), :118 (503), :180 (500 `INTERNAL_ERROR`); :103 `Retry-After` on no 4xx | PASS |
| API-02 | unit error-mapping.test.ts:100 `Object.keys(body).sort() == ['failureCode','message']`; :46 Zod -> `details` | PASS |
| API-03 | error-contract.test.ts:125-126 `503 DEPENDENCY_UNAVAILABLE` on writes and reads; :169-171 SQS down: bet `201`, events pending in outbox; killed M25 | PASS |
| OBS-01 | logging.test.ts:52-53 `x-correlation-id == 'trace-42'`, ids on request log; :94 message ids; unit logging.test.ts:21 | PASS (field list "when applicable": PREC, advisory A7) |
| OBS-02 | integration/observability/logging.test.ts:117-124 full cycle writes no amount/balance/playerId/payload; unit logging.test.ts:91,100 forbidden keys dropped | PASS |
| OBS-03 | logging.test.ts:45-53 echo; :60 UUID generated when absent; :94 SQS `messageId` used as `correlationId`; submit:148 events carry it | PASS |
| OBS-04 | metrics.test.ts:52-72 `# TYPE <name> <type>` for every metric listed in the spec with labels; :81-150 values (`wager_transactions_total{kind=BET,status=PROCESSED}`, `outbox_pending == base.pending + 2`) | PASS |
| OBS-05 | health.test.ts:35-36 `live 200 {status:'ok'}` with both deps unreachable | PASS |
| OBS-06 | health.test.ts:42 ready 200; :55-56 `503 status 'unavailable'` naming postgres / sqs (:63,:74) | PASS |
| OBS-07 | metrics.test.ts:44 `/metrics` 200 without credentials; health.test.ts:31 | PASS |
| AUTH-01 | unit http/auth-guard.test.ts:44 delegates body provider to the port; wallets.test.ts:186 guard applied, routes carry no provider | PASS |
| AUTH-02 | auth-guard.test.ts:51-54 `rejects.toBeInstanceOf(ProviderIdentityMismatchError)`; wagering.test.ts:321-322 `403 PROVIDER_IDENTITY_MISMATCH`, nothing written | PASS |
| AUTH-03 | `ARCHITECTURE.md` section 7 (line 51) documents Keycloak client credentials, JWT via public key, providerId mismatch -> 403, health open. Documentation only; no test applies. tasks.md still shows T46 "Pending" | PASS (doc inspection) - see advisory A4 |
| DB-01 | persistence/migrations-cycle.test.ts:29-32 up -> down (`existingTables() == []`) -> up; "up twice is a no-op" :43 | PASS |
| DB-02 | wallets-transactions-schema.test.ts (17 tests: CHECK balance, version, both UNIQUEs, partial reversal index :107/:124, kind/status CHECK :150, reference required :140, composite FK :196, terminal-row immutability :215) and ledger-inbox-outbox-schema.test.ts (24 tests: arithmetic CHECK, UNIQUE tx / wallet_version, trigger UPDATE/DELETE/TRUNCATE, inbox PK :144, outbox columns :177) - each violates the constraint with raw SQL | PASS |
| DB-03 | wallet-ledger-mappers.test.ts:156 no decorators; :47 `numeric` string round-trip; :162 no `number` money | PASS |
| DB-04 | wager-transaction.test.ts:288-314 rehydrate restores state without revalidation; wallet-ledger-entry.test.ts:119; wallet-ledger-mappers.test.ts:132 "does not revalidate" | PASS |
| TEST-01 | unit suites (432): money, wallet, wager-rules per kind, currency mismatch, payload-hash/idempotency | PASS |
| TEST-02 | integration against real Postgres/LocalStack: migrations/constraints, atomicity (repositories.test.ts:259), inbox/redelivery (sqs-consumer.test.ts:440), concurrent publishers (outbox-publisher.test.ts:141), retry/DLQ (resilience:161), restart (messaging-recovery.test.ts:166) | PASS |
| TEST-03 | concurrency dir: 18 tests incl. 3 processes (multi-process.test.ts:9 `PROCESSES = 3`) covering both-80.00 (x20), 50 replicas, hot wallet, REFUND+ROLLBACK race, external-id race, SQS+HTTP race | PASS |
| TEST-04 | `assertReconciled*` in every concurrency file and in the HTTP/use-case/messaging suites that touch a wallet (see REC-04). Persistence schema tests that insert raw rows use `ledger-inbox-outbox-schema.test.ts:205-229` as the reconciliation unit | PASS |
| TEST-05 | package.json scripts `test:unit`, `test:integration`, `test:concurrency`, `test`; persistence/orm.test.ts:17-23 `wagering_test` only | PASS |
| DOC-01 | Static inspection only: `docker-compose.yml` has postgres, localstack, a `migrate` job and `app`; queues in `infra/`; not exercised (running `docker compose up` would touch the shared containers, forbidden here) | NOT VERIFIED at runtime (advisory A8) |
| DOC-02 | Static: `app` publishes `"3100"` without a fixed host port (compose line ~55, comment "no fixed host port"), README line 13 documents `--scale app=3`; not run | NOT VERIFIED at runtime (A8) |
| DOC-03 | `README.md` (102 lines): prerequisites, setup, run, tests, API sample | PASS (doc inspection; file is uncommitted) |
| DOC-04 | `ARCHITECTURE.md` (60 lines, author's own text): ORM and Money, concurrency, idempotency and hash, 7.4 interpretation, PENDING_REFERENCE policy, outbox/inbox, Keycloak, limitations. It does NOT contain: HTTP status mapping, `failureCode` taxonomy, state-transition diagram (the README lists 3 statuses only) | PARTIAL - advisory A4 |
| DOC-05 | `git check-ignore -v`: `instrucoes-teste.md`, `CLAUDE.md`, `.claude/`, `.env`, `.env.*` ignored; `.gitignore:14 !.env.example`; `.specs/**` and `ARCHITECTURE.md` not ignored | PASS |

**Summary:** 125 of 127 requirement ids have test or inspection evidence matching the spec outcome (PASS);
DOC-01/DOC-02 are verified statically only; DOC-04 is partial. Zero requirements without any evidence in the
financial, concurrency, idempotency and messaging groups. Edge cases from the spec (the nine bullet points) are
covered: concurrent REFUND/ROLLBACK (http-concurrency.test.ts:160), same key different payload racing
(:59), HTTP+SQS same operation (messaging-recovery.test.ts:76/98/114), ROLLBACK of a spent WIN
(`REVERSAL_INSUFFICIENT_FUNDS`, submit:186), ROLLBACK of a REFUND (submit:297), balance exactly 0.00
(wallet.test.ts:84, submit:123), Postgres down -> no partial effect + 503 (error-contract.test.ts:118),
SQS down -> API continues (error-contract.test.ts:162), non-default key shape accepted (wagering.test.ts:53).

## 4. P0 invariants (CLAUDE.md), explicit check

| Invariant | Evidence | Status |
| --- | --- | --- |
| bigint cents, no `number` for money | money.ts `private constructor(readonly cents: bigint, …)`; wallet-ledger-mappers.test.ts:162; `grep` of `src/` for `amount\|balance : number` found nothing; M01-M03 killed | OK |
| Balance never negative, DB CHECK | wallets-transactions-schema.test.ts:17-29 `23514 wallets_balance_non_negative`; wallet.test.ts:78; http-concurrency.test.ts:102 (30 BETs of 1.00 on 20.00: exactly 20 pass, balance 0, never below) | OK |
| No duplicate debit/credit | `UNIQUE(transaction_id)` ledger (schema :80-84); 50-replica test; REFUND/ROLLBACK race; SQS redelivery after crash (messaging-recovery.test.ts:48) | OK |
| Persistent idempotency | UNIQUE constraints, no in-memory structures in `src/`; M07/M08/M19/M21 killed | OK |
| Per-wallet lock, never global | `SELECT … FOR UPDATE` on wallet row; unit-of-work.test.ts:134; http-concurrency.test.ts:133; M05/M20 killed | OK |
| Transactional outbox, no publish before commit | outbox-publisher.test.ts:55-72, :77-92, :278-297; M10/M11/M24 killed | OK |
| Immutable ledger (trigger) | ledger-inbox-outbox-schema.test.ts:117-136 UPDATE/DELETE/TRUNCATE | OK |
| Real Postgres/LocalStack | no `mock.module`/`jest.mock` in `test/`; support/db.ts refuses non-`wagering_test` | OK |
| Final invariant balance == ledger | `test/support/reconcile.ts` (SQL + endpoint) | OK |

## 5. Gaps and advisories, ranked

No blocking gap. Nothing in financial correctness, concurrency, idempotency or messaging guarantees is unproven.

1. **A1 (Low, documentation vs process): working tree is not the committed state.** 19 modified files plus untracked
   `README.md`, `Dockerfile`, `.dockerignore`, `error-detail-in-logs.test.ts`, and the `spike/` deletion are uncommitted;
   `tasks.md`/`spec.md` are also modified. The evaluation will see what is committed, so these must be committed
   (the Verifier validated the working tree).
2. **A2 (Low, PREC) SQS-06:** "backoff exponencial (base 2 s, teto 60 s)". The code gives `min(2^receiveCount * 2, 60)` = 4, 8, 16, 32, 60 s
   (`sqs-consumer-resilience.ts` `visibilityBackoffSeconds`), asserted at sqs-consumer-resilience.test.ts:174. The spec does not say whether the first retry waits 2 s or 4 s.
3. **A3 (Low, PREC) CONC-05:** the retry "com limite e backoff" has no numeric limit in the spec; the implementation does 3 retries (20/60/180 ms jittered),
   asserted by `concurrency-retry.test.ts:89-103`. Suggest stating it in the spec or design.
4. **A4 (Medium for the submission, documentation): DOC-04 / AUTH-03 / T46.** The spec requires the architecture document to include the HTTP mapping,
   the `failureCode` taxonomy and the state transitions; `ARCHITECTURE.md` omits those three (it is deliberately short, and the content lives in `spec.md`
   and the README only partly). Tasks.md and the traceability table still mark T46 "Pending". Not a code defect; decide whether to add short snippets
   (the file is author-owned; do not edit without his okay).
5. **A5 (Low): REV-08 at use-case level is asserted in one order.** `submit-wager-transaction.test.ts:249` covers REFUND then ROLLBACK only.
   The reverse order (ROLLBACK then REFUND) is covered by the repository test (repositories.test.ts:131) and by the DB-index test,
   and M09 (ignore ROLLBACK in `hasProcessedReversal`) was killed only by that single repository test. A use-case test for ROLLBACK -> REFUND would make this more robust.
6. **A6 (Info): dead mapping.** `BY_APPLICATION_CODE.WALLET_PLAYER_MISMATCH` and `CURRENCY_MISMATCH` rows in `http-errors.ts` are not reachable from the submission
   path (controller maps them to `HttpFailure(422)`), so changing them survives (X2). Harmless; could be removed or covered.
7. **A7 (Info, PREC) OBS-01:** "logs JSON contendo, quando aplicável…" does not define which ids are mandatory per event. Tests assert the correlation id,
   messageId and absence of forbidden keys, not the full per-event field list.
8. **A8 (Medium, unverified): DOC-01/DOC-02 runtime.** `docker compose up` and `--scale app=3` were not executed (forbidden: it would recreate the shared containers).
   Inspect manually or in CI before delivery. The `Dockerfile`/`.dockerignore` are untracked.
9. **A9 (Info): FAILED replay status.** `submissionStatus('FAILED')` returns 500; the spec says `PROCESSING_FAILED` has no HTTP class and is reachable only via the worker.
   No test replays a FAILED transaction through HTTP.
10. **A10 (Info): migrations were not mutated** in the sensor to protect the shared DB; schema guarantees are evidenced by raw-SQL violation tests (all present), not by mutation.

## 6. Isolation check

`git status --porcelain` of `/home/kaik/dev/jungle-wagering` was captured before any work and again after the sensor/gate; the two outputs are identical
(`diff` empty). The only addition to the real tree is this report file (`.specs/features/wagering-processor/validation.md`). No git command that
changes index/HEAD/branches was used; no docker container or volume was touched; mutations ran only in the scratch copy.

## 7. Other checks

- Test integrity: 829 tests, 0 skipped, none `.only`/`.skip`/`.todo`. No baseline count from before the feature exists to compare against.
- Success criteria in spec: "100/2x80 in 20 consecutive runs" is implemented as an in-test loop (http-concurrency.test.ts:83-100, 20 iterations) and passed; the
  "no `number` for money" grep criterion was checked (no occurrences).
- Code quality spot check: domain classes use private constructors with `create`/`rehydrate`; domain has no Nest/ORM imports (domain-purity test); no extra features found
  beyond the spec (`/metrics`, health, correlation are in scope).
