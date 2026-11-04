# Wagering Processor — Tasks

## Execution Protocol (MANDATORY -- do not skip)

Implement these tasks with the `tlc-spec-driven` skill: **activate it by name and follow its Execute flow and Critical Rules.** Do not search for skill files by filesystem path. The skill is the source of truth for the full flow (per-task cycle, sub-agent delegation, adequacy review, Verifier, discrimination sensor).

**If the skill cannot be activated, STOP and tell the user - do not proceed without it.**

Regras do projeto que valem sobre o skill (`CLAUDE.md`): nunca rodar `git commit`/`push`/`merge`/`rebase`/`reset --hard` (o usuário comita; o skill pede um commit por task, então cada task termina com o `git add` e a mensagem sugeridos); nunca editar o `ARCHITECTURE.md` direto; PARAR no checkpoint de cada fase e esperar o "ok".

---

**Spec**: `.specs/features/wagering-processor/spec.md`
**Design**: `.specs/features/wagering-processor/design.md`
**Status**: Draft (aguardando aprovação)

**Ferramentas**: nenhum MCP necessário em nenhuma task; skill `tlc-spec-driven` no Execute. Confirmar no checkpoint.

---

## Test Coverage Matrix

> Generated from spec, design (Test Strategy) and strong defaults - confirm before Execute. Guidelines found: none - strong defaults applied (sem `AGENTS.md`, `CONTRIBUTING.md` nem gate de cobertura no repositório). Não há testes ainda; o piso vem dos critérios do spec.

| Code Layer | Required Test Type | Coverage Expectation | Location Pattern | Run Command |
| ---------- | ------------------ | -------------------- | ---------------- | ----------- |
| Domain | unit | Todos os ramos; 1:1 com os critérios; todo edge case listado | `test/unit/**/*.test.ts` | `bun run test:unit` |
| Contratos Zod / config / guard | unit | Todo caso válido e inválido citado nos critérios | `test/unit/**/*.test.ts` | `bun run test:unit` |
| Persistence (migrations, schemas, repos, UoW) | integration | Uma violação por constraint e trigger; up → down → up; caminhos de query principais; erros | `test/integration/persistence/**/*.test.ts` | `bun run test:integration` |
| Use cases | integration | Happy path + todo `failureCode` + rollback atômico; `assertReconciled` ao fim | `test/integration/use-cases/**/*.test.ts` | `bun run test:integration` |
| HTTP (Nest) | integration | Toda rota: happy + edge + erro | `test/integration/http/**/*.test.ts` | `bun run test:integration` |
| Messaging (SQS, outbox, worker) | integration | Happy + DLQ + retry + falha, contra LocalStack real | `test/integration/messaging/**/*.test.ts` | `bun run test:integration` |
| Cenários da seção 13 | concurrency | Asserções só sobre estado final + reconciliação; 100 / 2×80 repetido 20× | `test/concurrency/**/*.test.ts` | `bun run test:concurrency` |
| Ports / config de compose / docs | none | - (build gate only) | - | build gate only |

Integração e concorrência rodam no banco `wagering_test`; nunca mockar PostgreSQL nem LocalStack. Fakes de `MetricsPort` e `LoggerPort` em teste são permitidos (não são os dois proibidos).

## Gate Check Commands

> Generated from `package.json`, `docker-compose.yml` e design - confirm before Execute. Não há linter configurado e não adiciono um (fora de escopo); o typecheck é o gate estático.

| Gate Level | When to Use | Command |
| ---------- | ----------- | ------- |
| Quick | Tasks com apenas testes unitários | `bun run typecheck && bun run test:unit` |
| Full | Tasks com testes de integração | `docker compose up -d --wait postgres localstack && bun run typecheck && bun run test:unit && bun run test:integration` |
| Build | Fim de fase, tasks de config/docs e cenários de concorrência | `docker compose up -d --wait postgres localstack && bun run typecheck && bun run test` |

Os scripts `test:*` nascem na T1; até lá os gates das tasks T1 e T2 são `bun run typecheck` e `docker compose config`.

---

## Execution Plan

Fases em ordem; tarefas sequenciais dentro da fase. Cada fase tem uma branch própria, anunciada antes de começar, e termina em checkpoint.

### Phase 1: Fundação

Branch: `chore/foundation` · 3 tasks (T1–T3)

```
T1 → T3
T2
```

### Phase 2: Domínio

Branch: `feat/domain` · 6 tasks (T4–T9)

```
T4 → T5 → T6 → T8
T4 → T7 → T8
T4 → T9
```

### Phase 3: Contratos e portas

Branch: `feat/contracts-ports` · 3 tasks (T10–T12)

```
T10
T11
T12
```

### Phase 4: Persistência

Branch: `feat/persistence` · 7 tasks (T13–T19)

```
T13 → T14 → T15 → T16 → T17 → T19
T16 → T18 → T19
```

### Phase 5: Use cases

Branch: `feat/use-cases` · 6 tasks (T20–T25)

```
T20 → T21 → T22 → T23
T21 → T24
T21 → T25
```

### Phase 6: HTTP

Branch: `feat/http` · 5 tasks (T26–T30)

```
T26 → T27 → T29 → T30
T26 → T28 → T29
```

### Phase 7: Concorrência e reconciliação

Branch: `test/concurrency-reconciliation` · 4 tasks (T31–T34)

```
T31 → T32 → T33 → T34
```

### Phase 8: Mensageria

Branch: `feat/messaging` · 6 tasks (T35–T40)

```
T35 → T36 → T40
T35 → T37 → T38 → T40
T39 → T40
```

### Phase 9: Observabilidade

Branch: `feat/observability` · 2 tasks (T41–T42)

```
T41 → T42
```

### Phase 10: Entrega

Branch: `chore/delivery` · 4 tasks (T43–T46)

```
T43 → T44
T43 → T45 → T46
```

---

## Prioridade sob prazo

Prazo: 06/11/2026, 13h (Brasília). Se o tempo apertar:

1. **A Fase 8 (mensageria) nunca é pulada**: inbox, consumidor, outbox e worker de pendências são parte do núcleo avaliado e das invariantes eliminatórias.
2. **A Fase 10 (entrega: Dockerfile, compose com `app` e `migrate`, README) vem antes da Fase 9 (observabilidade).** Sem `docker compose up` funcionando e README, o avaliador não roda nada; logs e métricas valem menos pontos.
3. A ordem de execução vira 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 10 → 9. A Fase 10 não depende de nenhuma task da Fase 9, então a troca é segura.
4. Se a Fase 9 for cortada, o que perde cobertura é OBS-01..04 e IDEM-08; OBS-05..07 (health) já estão na T26. Registrar o corte como limitação no `ARCHITECTURE.md`.

---

## Task Breakdown

### Phase 1 — Fundação

#### T1: Scripts de teste, dependências e .gitignore

**What**: Adicionar `test:unit`, `test:integration`, `test:concurrency` e `test` ao `package.json`, instalar `zod`, `pino` e `prom-client`, e conferir que o `.gitignore` cobre os arquivos locais.
**Where**: `package.json`
**Depends on**: None
**Reuses**: `package.json` atual (script `typecheck`)
**Requirement**: TEST-05, DOC-05

**Done when**:

- [x] `bun run test:unit`, `test:integration`, `test:concurrency` e `test` existem; `test` executa os três em sequência
- [x] `zod`, `pino`, `prom-client` em `dependencies` com versão fixada pelo `bun.lock`
- [x] `git check-ignore instrucoes-teste.md CLAUDE.md .claude .env` imprime os quatro; `.env.example` não é ignorado; `.specs/` não é ignorada
- [x] Gate de build passa: `bun run typecheck`

**Tests**: none
**Gate**: build
**Commit**: `chore(deps): add test scripts and runtime dependencies`

---

#### T2: Compose com versões fixas e banco de teste

**What**: Fixar as imagens do PostgreSQL e do LocalStack (nada de `:latest`) e criar o banco `wagering_test` por script de init do Postgres (`infra/postgres/init-test-db.sh`, montado no serviço).
**Where**: `docker-compose.yml`
**Depends on**: None
**Reuses**: `docker-compose.yml` e `infra/localstack/init-queues.sh` atuais
**Requirement**: TEST-05, DOC-01

**Done when**:

- [x] Nenhuma imagem usa `:latest`; versões exatas de PostgreSQL e LocalStack no compose
- [x] Em volume limpo (`docker compose down -v && up -d --wait postgres localstack`), `psql -l` lista `wagering` e `wagering_test`
- [x] `docker compose config` valida sem erro

**Tests**: none
**Gate**: build
**Commit**: `chore(compose): pin image versions and create the test database`

---

#### T3: Configuração tipada por variáveis de ambiente

**What**: Carregar e validar com Zod todas as variáveis: URL dos bancos, endpoint e nomes das filas, `RUN_HTTP`, `RUN_SQS_CONSUMER`, `RUN_OUTBOX_PUBLISHER`, `RUN_PENDING_WORKER`, `pool.max`, `lock_timeout`, políticas de retry e do worker.
**Where**: `src/infrastructure/config/env.ts`
**Depends on**: T1
**Reuses**: `.env.example`
**Requirement**: — (suporte; consumido por outras tasks)

**Done when**:

- [x] Valores padrão do design (pool 20, `lock_timeout` 2 s, 10 tentativas, base 1 s, teto 5 min) aplicados quando a variável falta
- [x] Variável inválida (ex.: `RUN_HTTP=maybe`, número negativo) falha na carga com mensagem que nomeia a variável
- [x] Os quatro runners são `true` por padrão e desligáveis individualmente
- [x] Gate rápido passa; ≥ 6 testes unitários

**Tests**: unit
**Gate**: quick
**Commit**: `feat(config): add validated environment configuration`

---

### Phase 2 — Domínio

#### T4: Value object Money e erros de domínio

**What**: Implementar `Money` (bigint em centavos, escala 2) com `from`, `fromCents`, `zero`, `add`, `subtract`, `negate`, comparações, `toJSON` e `toString`, e as classes de erro de domínio (`InvalidMoneyError`, `CurrencyMismatchError`, `InsufficientFundsError`, `InvalidTransactionStateError`).
**Where**: `src/domain/money/money.ts`
**Depends on**: None
**Reuses**: Nada (primeiro código de domínio)
**Requirement**: MON-01, MON-02, MON-03, MON-04, MON-05, MON-06, MON-07, MON-09, TEST-01

**Done when**:

- [ ] Cada critério MON-01..07 e 09 tem ao menos um teste com valor esperado literal (ex.: `Money.from('10.5')` → `'10.50'`)
- [ ] Rejeita `NaN`, `Infinity`, `1e3`, vazio, `abc`, mais de 2 casas e moeda fora de ISO-4217; nunca arredonda
- [ ] Operações retornam nova instância; a original não muda; `subtract` negativo → `isNegative()`; moedas diferentes → `CurrencyMismatchError`
- [ ] `grep -rn "number" src/domain/money` não encontra tipo `number` em campo de valor; `src/domain` não importa `@nestjs` nem `@mikro-orm`
- [ ] Gate rápido passa; ≥ 30 testes

**Tests**: unit
**Gate**: quick
**Commit**: `feat(domain): add Money value object and domain errors`

---

#### T5: Lançamento de ledger imutável

**What**: Implementar `WalletLedgerEntry` com todos os campos `readonly`, factory `create` que valida `balanceBefore ± money == balanceAfter` e `rehydrate`.
**Where**: `src/domain/ledger/wallet-ledger-entry.ts`
**Depends on**: T4
**Reuses**: `Money` (T4)
**Requirement**: LEDG-02, LEDG-07

**Done when**:

- [ ] `create` com CREDIT e DEBIT coerentes passa; aritmética incoerente lança erro de domínio
- [ ] Valor `0.00` e saldos negativos são recusados
- [ ] Tentativa de atribuir a um campo falha em tempo de compilação (`@ts-expect-error` no teste) e o objeto é congelado
- [ ] `rehydrate` não revalida; gate rápido passa; ≥ 8 testes

**Tests**: unit
**Gate**: quick
**Commit**: `feat(domain): add immutable wallet ledger entry`

---

#### T6: Agregado Wallet

**What**: Implementar `Wallet.open`, `rehydrate`, `debit` e `credit`; `debit/credit` retornam o `WalletLedgerEntry`, incrementam `version` em 1 e recusam saldo negativo e moeda diferente.
**Where**: `src/domain/wallet/wallet.ts`
**Depends on**: T5
**Reuses**: `Money` (T4), `WalletLedgerEntry` (T5)
**Requirement**: WAL-02, WAL-03, WAL-07, WAL-08, WAL-09, TEST-01

**Done when**:

- [ ] `open` com saldo inicial > 0 devolve `openingEntry` com `balanceBefore 0.00` e versão 1; com `0.00` não devolve lançamento
- [ ] `debit` acima do saldo lança erro de domínio; débito que zera o saldo é aceito
- [ ] `version` sobe exatamente 1 por mudança de saldo; moeda diferente lança `CurrencyMismatchError`
- [ ] Não existe caminho público que altere o saldo sem devolver o lançamento
- [ ] Gate rápido passa; ≥ 14 testes

**Tests**: unit
**Gate**: quick
**Commit**: `feat(domain): add Wallet aggregate`

---

#### T7: Máquina de estados de WagerTransaction

**What**: Implementar `WagerTransaction` com `create`, `createOpening`, `rehydrate`, `markProcessed`, `markPendingReference`, `reject`, `fail` e `scheduleReferenceRetry` (backoff base 1 s, fator 2, teto 5 min, 10 tentativas).
**Where**: `src/domain/wager/wager-transaction.ts`
**Depends on**: T4
**Reuses**: `Money` (T4)
**Requirement**: TXN-11, TXN-12, PREF-02

**Done when**:

- [ ] Só as transições `PENDING → PROCESSED|REJECTED|PENDING_REFERENCE|FAILED` e `PENDING_REFERENCE → PROCESSED|REJECTED|FAILED` passam
- [ ] Qualquer transição a partir de `PROCESSED`, `REJECTED` ou `FAILED` lança `InvalidTransactionStateError`
- [ ] `scheduleReferenceRetry` produz 1 s, 2 s, 4 s … 300 s e esgota na 10ª tentativa; `rehydrate` não revalida transições
- [ ] `createOpening` é a única forma de gerar `OPENING` (`provider_id = 'internal'`)
- [ ] Gate rápido passa; ≥ 20 testes

**Tests**: unit
**Gate**: quick
**Commit**: `feat(domain): add WagerTransaction state machine`

---

#### T8: WagerRules.decide (tabela da seção 7)

**What**: Implementar a função pura `decide({ wallet, transaction, reference?, alreadyReversed })` devolvendo `Processed | Rejected | PendingReference`, cobrindo todos os kinds.
**Where**: `src/domain/wager/wager-rules.ts`
**Depends on**: T6, T7
**Reuses**: `Wallet` (T6), `WagerTransaction` (T7)
**Requirement**: TXN-01, TXN-02, TXN-03, TXN-04, REV-02, REV-03, REV-04, REV-05, REV-06, REV-07, REV-08, REV-09, REV-10, PREF-01, TEST-01

**Done when**:

- [ ] BET, WIN e LOSS: processado com a direção e o lançamento corretos; BET sem saldo → `INSUFFICIENT_FUNDS`; LOSS sem lançamento
- [ ] Cada rejeição de reversão tem teste próprio: `REFERENCE_MISMATCH`, `INVALID_REFERENCE_KIND` (inclui autorreferência), `AMOUNT_MISMATCH`, `REFERENCE_NOT_PROCESSED`, `REFERENCE_ALREADY_REVERSED`, `REVERSAL_INSUFFICIENT_FUNDS`
- [ ] REFUND de BET credita; ROLLBACK de BET credita; ROLLBACK de WIN ou REFUND debita; referência ausente ou não-terminal → `PendingReference`
- [ ] Saldo que chega exatamente a `0.00` é aceito
- [ ] Gate rápido passa; ≥ 40 testes

**Tests**: unit
**Gate**: quick
**Commit**: `feat(domain): add wager rules decision table`

---

#### T9: Eventos de integração, inbox e outbox

**What**: Implementar `IntegrationEvent<T>` abstrata e as subclasses `WagerTransactionProcessed`, `WagerTransactionRejected`, `WalletBalanceChanged` e `WagerTransactionPendingReference`, mais `InboxMessage` e `OutboxMessage`.
**Where**: `src/domain/messaging/integration-event.ts`
**Depends on**: T4
**Reuses**: `Money` (T4)
**Requirement**: OUT-07

**Done when**:

- [ ] Cada evento declara `eventType` e `version` no tipo e serializa no envelope da seção 11 do enunciado
- [ ] `WalletBalanceChanged` carrega `walletVersion`, `direction`, `money`, `balanceBefore` e `balanceAfter` como `MoneyProps`
- [ ] Eventos e mensagens são `readonly`; `eventId` é gerado uma única vez
- [ ] Gate rápido passa; ≥ 10 testes

**Tests**: unit
**Gate**: quick
**Commit**: `feat(domain): add integration events, inbox and outbox messages`

---

### Phase 3 — Contratos e portas

#### T10: Hash canônico do payload

**What**: Implementar o `payloadHash`: SHA-256 hex de JSON canônico (chaves ordenadas recursivamente, UTF-8) dos campos de negócio, `referenceExternalTransactionId` omitido quando ausente.
**Where**: `src/application/services/payload-hash.ts`
**Depends on**: T4
**Reuses**: Nada
**Requirement**: IDEM-07, TEST-01

**Done when**:

- [ ] Mesma operação com chaves em ordens diferentes produz o mesmo hash; qualquer campo de negócio alterado muda o hash
- [ ] `idempotencyKey`, `messageId`, `occurredAt` e headers não entram no hash
- [ ] Hash de uma entrada fixa bate com o valor literal esperado (64 caracteres hex)
- [ ] Gate rápido passa; ≥ 8 testes

**Tests**: unit
**Gate**: quick
**Commit**: `feat(application): add canonical payload hash`

---

#### T11: Contratos Zod compartilhados por HTTP e SQS

**What**: Definir os schemas Zod de wallet, transação de aposta, query do ledger e mensagem SQS, com a regex `^\d+\.\d{2}$` e as regras de valor por kind.
**Where**: `src/infrastructure/contracts/wager.contract.ts`
**Depends on**: T4
**Reuses**: `Money` (T4)
**Requirement**: MON-08, TXN-05, TXN-06, TXN-13, TXN-14, LEDG-06

**Done when**:

- [ ] `"25"`, `"25.5"`, `"-1.00"` e `"1e3"` → erro de validação; `"25.00"` passa; mais de 18 dígitos inteiros falha
- [ ] `kind = OPENING`, `providerId = "internal"`, REFUND/ROLLBACK sem referência e `0.00` em BET/WIN/REFUND/ROLLBACK são rejeitados; LOSS `0.00` passa
- [ ] `limit` fora de 1..200 e cursor inválido são rejeitados
- [ ] O mesmo schema valida o corpo HTTP e a mensagem SQS
- [ ] Gate rápido passa; ≥ 25 testes

**Tests**: unit
**Gate**: quick
**Commit**: `feat(contracts): add shared zod contracts for http and sqs`

---

#### T12: Portas da aplicação

**What**: Declarar as portas: `UnitOfWork` e `TxRepositories`, `ProviderIdentityPort`, `EventPublisherPort`, `MetricsPort`, `LoggerPort` e `Clock`.
**Where**: `src/application/ports/index.ts`
**Depends on**: T6, T7, T9
**Reuses**: Interfaces do design (seção Components)
**Requirement**: — (suporte; consumido por outras tasks)

**Done when**:

- [ ] Todas as portas do design declaradas, sem import de Nest ou do ORM
- [ ] `TxRepositories` expõe `wallets.lockById`, `transactions.*`, `ledger.append`, `inbox.tryRecord` e `outbox.enqueue`
- [ ] Gate de build passa: `bun run typecheck`

**Tests**: none
**Gate**: build
**Commit**: `feat(application): declare application ports`

---

### Phase 4 — Persistência

#### T13: Config do ORM, runner de migrations e harness de teste

**What**: Copiar a config do spike para a config real (`defineConfig`, `migrationsList` explícito, `snapshot: false`), criar o comando de migrate e o helper de teste que aponta para `wagering_test`.
**Where**: `src/infrastructure/persistence/orm.config.ts`
**Depends on**: T3
**Reuses**: `spike/orm.ts`, `spike/migrations.ts`
**Requirement**: DB-01, TEST-05

**Done when**:

- [ ] `bun run migrate` aplica as migrations no banco da env; o helper de teste usa `wagering_test`
- [ ] Pool lê `pool.max` da env
- [ ] Gate completo passa com um teste de conexão (≥ 1 teste de integração)

**Tests**: integration
**Gate**: full
**Commit**: `feat(persistence): add orm config and migration runner`

---

#### T14: Migration de wallets e wager_transactions

**What**: Criar a migration SQL manual (`up`/`down`) de `wallets` e `wager_transactions` com todas as constraints, FK composta, índices parciais e o trigger de estados terminais.
**Where**: `src/infrastructure/persistence/migrations/Migration001Wallets.ts`
**Depends on**: T13
**Reuses**: `spike/migrations.ts` (padrão `addSql`)
**Requirement**: DB-02, WAL-04, WAL-08, WAL-09, TXN-06, TXN-08, TXN-09, TXN-11, REV-08, IDEM-02

**Done when**:

- [ ] Teste de violação por constraint via SQL, cada um esperando o erro do Postgres: `CHECK (balance >= 0)`, `UNIQUE (player_id, currency)`, `UNIQUE (provider_id, idempotency_key)`, `UNIQUE (provider_id, external_transaction_id)`, índice parcial de reversão única, `CHECK` de referência obrigatória, `CHECK` de `kind`/`status`, `CHECK` de `failure_code`, `CHECK` de valor positivo
- [ ] FK composta rejeita transação com `player_id` ou moeda diferentes da wallet
- [ ] Trigger rejeita `UPDATE` de linha `PROCESSED`, `REJECTED` e `FAILED`
- [ ] `down` desfaz a migration sem erro
- [ ] Gate completo passa; ≥ 14 testes de integração

**Tests**: integration
**Gate**: full
**Commit**: `feat(persistence): add wallets and wager transactions schema`

---

#### T15: Migration de ledger, inbox e outbox, e reconciliação por SQL

**What**: Criar a migration do `wallet_ledger_entries` (CHECKs, FKs, UNIQUEs, triggers anti `UPDATE`/`DELETE`/`TRUNCATE`), de `inbox_messages` e `outbox_messages`, e o helper `assertReconciled` por SQL em `test/support`.
**Where**: `src/infrastructure/persistence/migrations/Migration002LedgerInboxOutbox.ts`
**Depends on**: T14
**Reuses**: Migration001 (T14)
**Requirement**: DB-01, DB-02, LEDG-02, LEDG-03, LEDG-04, CONC-08, TEST-04

**Done when**:

- [ ] Teste de violação para cada constraint do ledger: `amount > 0`, `balance_after >= 0`, `CHECK` aritmético, `UNIQUE (transaction_id)`, `UNIQUE (wallet_id, wallet_version)`, FK composta de moeda
- [ ] `UPDATE`, `DELETE` e `TRUNCATE` no ledger falham pelo trigger
- [ ] Inbox rejeita `(consumer_name, message_id)` repetido; outbox tem `attempts`, `next_attempt_at`, `locked_until`, `published_at`
- [ ] Ciclo up → down → up completo de todas as migrations passa em banco real
- [ ] `assertReconciled(walletIds)` calcula Σ CREDIT − Σ DEBIT e compara com `wallets.balance`
- [ ] Gate completo passa; ≥ 14 testes de integração

**Tests**: integration
**Gate**: full
**Commit**: `feat(persistence): add ledger, inbox and outbox schema`

---

#### T16: Records, EntitySchema e mappers de wallet e ledger

**What**: Criar os records de persistência e os `EntitySchema` de wallet e ledger, com mappers `toDomain`/`applyToRecord`, lendo `numeric` como string e convertendo para `bigint`.
**Where**: `src/infrastructure/persistence/mappers/wallet.mapper.ts`
**Depends on**: T15
**Reuses**: `spike/spike-wallet.record.ts`
**Requirement**: DB-03, DB-04, MON-01

**Done when**:

- [ ] Round-trip wallet e lançamento: `numeric` → string → `Money` → string preserva `'0.10'` e `'999999999999999999.99'` sem perda
- [ ] Mapeamento só por `EntitySchema`; nenhum decorator nem import do ORM em `src/domain`
- [ ] O mapper hidrata via `rehydrate`; nenhum campo de valor tipado como `number`
- [ ] Gate completo passa; ≥ 8 testes

**Tests**: integration
**Gate**: full
**Commit**: `feat(persistence): map wallet and ledger entities`

---

#### T17: Records e mappers de transação, inbox e outbox

**What**: Criar records, `EntitySchema` e mappers de `wager_transactions`, `inbox_messages` e `outbox_messages`.
**Where**: `src/infrastructure/persistence/mappers/wager-transaction.mapper.ts`
**Depends on**: T16
**Reuses**: Mappers de T16
**Requirement**: DB-03, DB-04

**Done when**:

- [ ] Round-trip de transação em cada status preserva todos os campos, incluindo `failureCode`, `balanceAfter` e `referenceTransactionId`
- [ ] `payload` da outbox é `jsonb` e volta idêntico
- [ ] Gate completo passa; ≥ 6 testes

**Tests**: integration
**Gate**: full
**Commit**: `feat(persistence): map transaction, inbox and outbox entities`

---

#### T18: UnitOfWork e repositório de wallet com lock

**What**: Implementar `MikroOrmUnitOfWork` sobre `em.transactional` com `SET LOCAL lock_timeout`, e `wallets.lockById` (`FOR UPDATE`) e `wallets.save` (`UPDATE … WHERE version`).
**Where**: `src/infrastructure/persistence/unit-of-work.ts`
**Depends on**: T16
**Reuses**: Mapper de wallet (T16)
**Requirement**: CONC-02, CONC-06

**Done when**:

- [ ] **Primeiro teste prova que o `lock_timeout` vale dentro de `em.transactional`**: uma segunda transação que espera a mesma wallet falha com `55P03` perto do limite configurado
- [ ] `save` com versão defasada afeta 0 linhas e lança `OptimisticLockError`
- [ ] Lock de uma wallet não bloqueia outra wallet (sem lock global)
- [ ] Falha dentro do `run` dá rollback completo
- [ ] Gate completo passa; ≥ 6 testes

**Tests**: integration
**Gate**: full
**Commit**: `feat(persistence): add unit of work with per-wallet locking`

---

#### T19: Repositórios de transação, ledger, inbox e outbox

**What**: Implementar `transactions.*`, `ledger.append`, `inbox.tryRecord` (`recorded | duplicate | conflict`) e `outbox.enqueue`, expostos em `TxRepositories`.
**Where**: `src/infrastructure/persistence/repositories.ts`
**Depends on**: T17, T18
**Reuses**: Mappers (T16, T17), `MikroOrmUnitOfWork` (T18)
**Requirement**: OUT-01, LEDG-01, SQS-02

**Done when**:

- [ ] `findByIdempotencyKey`, `findByExternalId`, `findReference` e `hasProcessedReversal` retornam o esperado
- [ ] `inbox.tryRecord` distingue primeira vez, duplicata com mesmo hash e conflito de hash
- [ ] Falha injetada depois de `ledger.append` não persiste nada (atomicidade wallet + ledger + inbox + outbox)
- [ ] Gate completo passa; ≥ 10 testes

**Tests**: integration
**Gate**: full
**Commit**: `feat(persistence): add transaction, ledger, inbox and outbox repositories`

---

### Phase 5 — Use cases

#### T20: Use case OpenWallet

**What**: Criar wallet, transação `OPENING`, lançamento e eventos numa só transação SQL; `23505` em `(player_id, currency)` vira `WalletAlreadyExists`.
**Where**: `src/application/use-cases/open-wallet.ts`
**Depends on**: T19
**Reuses**: `Wallet.open` (T6), `WagerTransaction.createOpening` (T7)
**Requirement**: WAL-01, WAL-02, WAL-03, WAL-04, OUT-03, OUT-04, LEDG-01

**Done when**:

- [ ] Saldo inicial 1000.00: wallet `version 1`, 1 transação `OPENING` `PROCESSED`, 1 lançamento CREDIT, eventos `WagerTransactionProcessed` e `WalletBalanceChanged` na outbox
- [ ] Saldo inicial 0.00: wallet sem transação, sem lançamento e sem `WalletBalanceChanged`
- [ ] Segunda wallet para o mesmo jogador e moeda → `WalletAlreadyExists`, inclusive com 10 criações concorrentes (exatamente 1 vence)
- [ ] `assertReconciled` passa; gate completo; ≥ 6 testes

**Tests**: integration
**Gate**: full
**Commit**: `feat(application): add open wallet use case`

---

#### T21: Núcleo de SubmitWagerTransaction

**What**: Implementar o fluxo transacional: lock da wallet, mismatch de wallet/player/moeda sem persistir, resolução da referência, `WagerRules.decide`, persistência de transação, lançamento, wallet e eventos.
**Where**: `src/application/use-cases/submit-wager-transaction.ts`
**Depends on**: T20
**Reuses**: `WagerRules` (T8), repositórios (T19)
**Requirement**: TXN-01, TXN-02, TXN-03, TXN-04, TXN-07, TXN-08, TXN-09, WAL-07, WAL-09, REV-01, REV-02, REV-03, REV-04, REV-05, REV-06, REV-07, REV-08, REV-09, REV-10, PREF-01, LEDG-01, OUT-01, OUT-03, OUT-04, OUT-05, OUT-06, CONC-02, CONC-03, CONC-06

**Done when**:

- [ ] Um teste por `failureCode` de rejeição, com a transação `REJECTED` persistida, saldo e ledger intactos e evento `WagerTransactionRejected`
- [ ] `WALLET_NOT_FOUND`, `WALLET_PLAYER_MISMATCH` e `CURRENCY_MISMATCH` não gravam nada
- [ ] BET → WIN → LOSS: saldos, lançamentos e `version` esperados; REFUND e ROLLBACK creditam e debitam conforme a referência; segunda reversão da mesma referência → `REFERENCE_ALREADY_REVERSED`
- [ ] Referência ausente → `PENDING_REFERENCE` com `PendingReference` na outbox; wallets diferentes processam em paralelo
- [ ] Todo teste termina com `assertReconciled`; gate completo; ≥ 30 testes

**Tests**: integration
**Gate**: full
**Commit**: `feat(application): add submit wager transaction use case`

---

#### T22: Idempotência no submit

**What**: Adicionar, depois do lock, a deduplicação: mesma key e mesmo hash → replay com o estado persistido; hash diferente → `IdempotencyConflict`; mesmo id externo com outra key → `ExternalIdConflict`.
**Where**: `src/application/use-cases/submit-wager-transaction.ts` (modify)
**Depends on**: T21
**Reuses**: `payloadHash` (T10)
**Requirement**: IDEM-02, IDEM-03, IDEM-04, IDEM-05

**Done when**:

- [ ] Replay devolve o mesmo `transactionId` e o status persistido (PROCESSED, REJECTED ou PENDING_REFERENCE) com `idempotentReplay: true`, sem novo lançamento
- [ ] Replay de transação que saiu de `PENDING_REFERENCE` reflete o estado atual
- [ ] Mesma key com `amount` diferente → conflito, nada aplicado; mesmo id externo com key diferente → conflito
- [ ] A restrição única barra o caso de wallets diferentes com a mesma key
- [ ] Gate completo; ≥ 10 testes

**Tests**: integration
**Gate**: full
**Commit**: `feat(application): add idempotent replay and conflicts to submit`

---

#### T23: Retry de concorrência

**What**: Envolver o submit com retry fora da transação (até 3 vezes, 20/60/180 ms com jitter) para `55P03`, `40001`, `40P01`, `OptimisticLockError` e `23505` nas constraints de idempotência, id externo e reversão; esgotado → `ConcurrencyConflict`.
**Where**: `src/application/services/concurrency-retry.ts`
**Depends on**: T22
**Reuses**: `UnitOfWork` (T18)
**Requirement**: CONC-05, CONC-07

**Done when**:

- [ ] Erro transitório que passa na segunda tentativa resulta em sucesso; a reexecução cai na deduplicação e vira replay ou conflito
- [ ] Quatro falhas seguidas → `ConcurrencyConflict` sem efeito parcial
- [ ] Cada retry incrementa `lock_conflicts_total` via `MetricsPort`
- [ ] Gate completo; ≥ 8 testes

**Tests**: integration
**Gate**: full
**Commit**: `feat(application): add bounded concurrency retry`

---

#### T24: Queries de wallet e transação

**What**: Implementar `GetWallet`, `GetTransactionById` e `GetTransactionByExternalId`.
**Where**: `src/application/use-cases/queries.ts`
**Depends on**: T21
**Reuses**: Repositórios (T19)
**Requirement**: WAL-05, WAL-06, TXN-10

**Done when**:

- [ ] `GetWallet` devolve `id`, `playerId`, `balance`, `version`; inexistente → `WalletNotFound`
- [ ] As duas consultas de transação devolvem status, `failureCode`, `money`, `kind`, referência e `balanceAfter`; inexistente → `TransactionNotFound`
- [ ] Gate completo; ≥ 6 testes

**Tests**: integration
**Gate**: full
**Commit**: `feat(application): add wallet and transaction queries`

---

#### T25: ListLedger com cursor

**What**: Implementar `ListLedger` ordenado por `wallet_version` decrescente, com cursor opaco base64url de `{v}` e `limit` de 1 a 200.
**Where**: `src/application/use-cases/list-ledger.ts`
**Depends on**: T21
**Reuses**: `wallet_ledger_entries` (T15)
**Requirement**: LEDG-05, LEDG-06

**Done when**:

- [ ] Ledger de 120 lançamentos paginado em 3 páginas (limit 50) sem repetição nem salto
- [ ] Inserção concorrente durante a paginação não duplica nem perde lançamentos já vistos
- [ ] Cursor inválido → erro de validação; `limit` default 50, máximo 200
- [ ] Gate completo; ≥ 6 testes

**Tests**: integration
**Gate**: full
**Commit**: `feat(application): add ledger listing with cursor pagination`

---

### Phase 6 — HTTP

#### T26: Bootstrap Nest, runners e health checks

**What**: Criar `main.ts`, o módulo raiz com runners ligáveis por env, uma fábrica de app para testes, o cliente SQS simples (`src/infrastructure/messaging/sqs-client.ts`, só a construção do `SQSClient` pela config) e `/health/live` e `/health/ready` (`SELECT 1` no PostgreSQL e `GetQueueUrl` no SQS).
**Where**: `src/infrastructure/http/health.controller.ts`
**Depends on**: T25
**Reuses**: Config (T3), ORM (T13)
**Requirement**: OBS-05, OBS-06, OBS-07

**Done when**:

- [ ] `/health/live` responde 200 sem tocar dependências
- [ ] `/health/ready` responde 200 com Postgres e LocalStack no ar
- [ ] Com o Postgres indisponível → 503 com o detalhe da dependência; com a fila ausente ou o SQS fora → 503 com o detalhe do SQS
- [ ] Runners desligados por env não sobem (`RUN_HTTP=false` não escuta porta)
- [ ] Gate completo; ≥ 6 testes

**Tests**: integration
**Gate**: full
**Commit**: `feat(http): bootstrap nest app with health checks`

---

#### T27: ExceptionFilter e mapeamento de status

**What**: Implementar o mapper `Outcome → HTTP` e o `ExceptionFilter` com o corpo `{ failureCode, message, details? }`.
**Where**: `src/infrastructure/http/filters/exception.filter.ts`
**Depends on**: T26
**Reuses**: Taxonomia de `failureCode` do spec
**Requirement**: API-01, API-02, API-03

**Done when**:

- [ ] Um teste e2e por classe: 201, 202, 400, 404, 409, 422, 503 com `Retry-After: 1` e 500
- [ ] Falha de PostgreSQL ou SQS → 503 `DEPENDENCY_UNAVAILABLE`; `ConcurrencyConflict` → 503 `CONCURRENCY_CONFLICT`
- [ ] Nenhuma mensagem de erro expõe stack ou SQL
- [ ] Gate completo; ≥ 10 testes

**Tests**: integration
**Gate**: full
**Commit**: `feat(http): map outcomes and errors to http responses`

---

#### T28: AuthGuard no-op e ProviderIdentityPort

**What**: Implementar o `AuthGuard` que delega a `ProviderIdentityPort.assertCanActAs(providerId)` e a implementação `AllowAllProviderIdentity`.
**Where**: `src/infrastructure/http/auth/auth.guard.ts`
**Depends on**: T26
**Reuses**: `ProviderIdentityPort` (T12)
**Requirement**: AUTH-01, AUTH-02

**Done when**:

- [ ] Com `AllowAllProviderIdentity` todas as rotas de wallets e wagering passam
- [ ] Com um fake que nega → 403 `PROVIDER_IDENTITY_MISMATCH`
- [ ] O guard lê o `providerId` do body de `POST /wagering/transactions`; `/health/*` e `/metrics` ficam fora do guard
- [ ] Gate rápido passa; ≥ 4 testes

**Tests**: unit
**Gate**: quick
**Commit**: `feat(http): add auth guard extension point`

---

#### T29: Controller de wallets

**What**: Expor `POST /wallets`, `GET /wallets/:walletId` e `GET /wallets/:walletId/ledger`.
**Where**: `src/infrastructure/http/controllers/wallets.controller.ts`
**Depends on**: T27, T28
**Reuses**: `OpenWallet` (T20), queries (T24, T25), contratos (T11)
**Requirement**: WAL-01, WAL-04, WAL-05, WAL-06, LEDG-05, LEDG-06, AUTH-01

**Done when**:

- [ ] Criação 201 com `id`, `playerId`, `balance`, `version`; duplicada 409 `WALLET_ALREADY_EXISTS`
- [ ] GET inexistente → 404 `WALLET_NOT_FOUND`; id malformado → 400
- [ ] Ledger paginado com `nextCursor`; cursor inválido e `limit` fora de 1..200 → 400
- [ ] Gate completo; ≥ 10 testes e2e

**Tests**: integration
**Gate**: full
**Commit**: `feat(http): add wallets controller`

---

#### T30: Controller de wagering

**What**: Expor `POST /wagering/transactions` (header `Idempotency-Key` obrigatório) e as duas consultas de transação.
**Where**: `src/infrastructure/http/controllers/wagering.controller.ts`
**Depends on**: T29
**Reuses**: `SubmitWagerTransaction` (T21, T22), queries (T24)
**Requirement**: IDEM-01, IDEM-03, IDEM-04, IDEM-05, TXN-05, TXN-06, TXN-10, TXN-13, TXN-14, AUTH-02

**Done when**:

- [ ] Sem `Idempotency-Key` → 400 `IDEMPOTENCY_KEY_REQUIRED`
- [ ] BET válida → 201 com `{transactionId, status, balance, idempotentReplay:false}`; replay → mesmo status com `idempotentReplay:true`
- [ ] Rejeição de negócio → 422 com `failureCode`; PENDING_REFERENCE → 202; conflitos → 409
- [ ] `OPENING`, `providerId = internal`, `0.00` em BET → 400; consultas por id e por id externo → 200/404
- [ ] Gate completo; ≥ 15 testes e2e

**Tests**: integration
**Gate**: full
**Commit**: `feat(http): add wagering controller`

---

### Phase 7 — Concorrência e reconciliação

#### T31: Cenários de concorrência por HTTP

**What**: Escrever os cenários: 50× a mesma requisição, 100.00 com 2×80.00 (repetido 20×), wallets distintas em paralelo, REFUND e ROLLBACK simultâneos da mesma BET, e mesma key com payloads diferentes.
**Where**: `test/concurrency/http-concurrency.test.ts`
**Depends on**: T30
**Reuses**: App factory (T26), `assertReconciled` (T15)
**Requirement**: IDEM-06, CONC-01, CONC-02, CONC-03, REV-08, TEST-03

**Done when**:

- [ ] 50 requisições iguais: 1 transação, no máximo 1 lançamento, 50 respostas com o mesmo `transactionId` (1 `false`, 49 `true`)
- [ ] 100.00 / 2×80.00: exatamente 1 PROCESSED, 1 `INSUFFICIENT_FUNDS`, saldo 20.00, 1 DEBIT — 20 execuções seguidas sem falha
- [ ] Wallets distintas terminam com saldos corretos; exatamente uma reversão vence, a outra recebe `REFERENCE_ALREADY_REVERSED`
- [ ] Todas as asserções são sobre estado final + `assertReconciled`; gate de build; ≥ 6 testes

**Tests**: concurrency
**Gate**: build
**Commit**: `test(concurrency): add http concurrency scenarios`

---

#### T32: Três processos na mesma wallet

**What**: Subir 3 processos da aplicação via `Bun.spawn` e disparar operações concorrentes sobre uma mesma wallet.
**Where**: `test/concurrency/multi-process.test.ts`
**Depends on**: T31
**Reuses**: App factory (T26)
**Requirement**: CONC-04, TEST-03

**Done when**:

- [ ] 3 processos em portas distintas processam N operações da mesma wallet sem débito ou crédito duplicado
- [ ] Saldo final igual ao esperado e `assertReconciled` passa
- [ ] Processos encerrados no `afterAll`; gate de build; ≥ 2 testes

**Tests**: concurrency
**Gate**: build
**Commit**: `test(concurrency): add multi-process scenario`

---

#### T33: Use case ReconcileWallet

**What**: Calcular `calculatedBalance` = Σ CREDIT − Σ DEBIT do ledger, comparar com o saldo armazenado e devolver `consistent`, sem corrigir nada.
**Where**: `src/application/use-cases/reconcile-wallet.ts`
**Depends on**: T32
**Reuses**: Repositório de ledger (T19)
**Requirement**: REC-01, REC-02, REC-03

**Done when**:

- [ ] Wallet com operações → `consistent: true`, `difference 0.00`, `checkedEntries` correto
- [ ] **Divergência forçada**: alterar `wallets.balance` por SQL direto → `consistent: false`, log `error` e `reconciliation_mismatches_total` incrementada (via `LoggerPort` e `MetricsPort` de teste), e o saldo **permanece** o valor alterado (nada é corrigido)
- [ ] Wallet inexistente → `WalletNotFound`
- [ ] Gate completo; ≥ 5 testes

**Tests**: integration
**Gate**: full
**Commit**: `feat(application): add wallet reconciliation use case`

---

#### T34: Endpoint de reconciliação

**What**: Expor `POST /wallets/:walletId/reconciliation` e fazer o `assertReconciled` dos testes usar o endpoint.
**Where**: `src/infrastructure/http/controllers/reconciliation.controller.ts`
**Depends on**: T33
**Reuses**: `ReconcileWallet` (T33)
**Requirement**: REC-04, TEST-04

**Done when**:

- [ ] 200 com `walletId`, `storedBalance`, `calculatedBalance`, `difference`, `consistent`, `checkedEntries`; inexistente → 404
- [ ] Os testes de T31 e T32 passam a asserir a reconciliação pelo endpoint
- [ ] Gate de build passa: `bun run test`; ≥ 4 testes

**Tests**: integration
**Gate**: full
**Commit**: `feat(http): add reconciliation endpoint`

---

### Phase 8 — Mensageria

#### T35: Adaptador SQS e filas de teste

**What**: Implementar o adaptador sobre o cliente SQS da T26 (`EventPublisherPort`, receive, delete, change visibility, send à DLQ) e garantir as filas FIFO e o redrive no `init-queues.sh`.
**Where**: `src/infrastructure/messaging/sqs.adapter.ts`
**Depends on**: T26
**Reuses**: `infra/localstack/init-queues.sh`, cliente SQS (T26)
**Requirement**: DOC-01

**Done when**:

- [ ] Envia, recebe, apaga e altera visibilidade em LocalStack real, com `MessageGroupId` e `MessageDeduplicationId`
- [ ] Mensagem recebida 5 vezes sem ack vai para `wager-transactions-dlq.fifo` (redrive)
- [ ] As três filas existem após `docker compose up`; gate completo; ≥ 5 testes

**Tests**: integration
**Gate**: full
**Commit**: `feat(messaging): add sqs adapter and queue setup`

---

#### T36: Publicador da outbox

**What**: Implementar `PublishOutboxBatch` e o `OutboxPublisher`: claim com lease (`FOR UPDATE SKIP LOCKED` + `locked_until`) em transação curta, `SendMessageBatch` fora de transação, backoff em falha.
**Where**: `src/infrastructure/messaging/outbox-publisher.ts`
**Depends on**: T35
**Reuses**: `outbox.enqueue` (T19), adaptador SQS (T35)
**Requirement**: OUT-02, OUT-08, OUT-09, OUT-10, OUT-11, OUT-12, TEST-02

**Done when**:

- [ ] Evento só aparece em `wallet-events.fifo` depois do commit; publisher desligado acumula pendentes e outra instância publica ao subir
- [ ] 2 publishers sobre a mesma outbox: cada evento publicado sem que dois peguem a mesma linha
- [ ] Crash depois do claim: outra instância publica quando `locked_until` expira
- [ ] SQS indisponível: `attempts` sobe, `next_attempt_at` aplica backoff e nada é descartado; nenhuma transação aberta durante a chamada de rede
- [ ] Gate completo; ≥ 8 testes

**Tests**: integration
**Gate**: full
**Commit**: `feat(messaging): add outbox publisher with lease`

---

#### T37: Consumidor SQS com inbox

**What**: Implementar o `SqsConsumer`: long-poll, validação pelo contrato Zod, `inbox.tryRecord` na mesma transação do use case, ack só depois do commit, DLQ para malformadas e conflitos.
**Where**: `src/infrastructure/messaging/sqs-consumer.ts`
**Depends on**: T35
**Reuses**: `SubmitWagerTransaction` (T21, T22), contrato (T11)
**Requirement**: SQS-01, SQS-02, SQS-03, SQS-04, SQS-05, SQS-08, SQS-11, SQS-12, SQS-13

**Done when**:

- [ ] Mensagem válida é processada pelo mesmo use case; a mesma mensagem 2× produz 1 transação e 1 lançamento e incrementa `inbox_duplicates_total`
- [ ] Rejeição de negócio persiste `REJECTED` e faz ack; ack só ocorre depois do commit
- [ ] Malformada, `kind = OPENING` e `messageId` com payload diferente vão à DLQ com ack e nada é gravado; `IDEMPOTENCY_KEY_REUSED` e `EXTERNAL_ID_CONFLICT` também
- [ ] Gate completo; ≥ 10 testes

**Tests**: integration
**Gate**: full
**Commit**: `feat(messaging): add sqs consumer with inbox`

---

#### T38: Retry, DLQ e SIGTERM do consumidor

**What**: Implementar visibilidade com backoff (`min(2^receiveCount · 2s, 60s)`) para erros transitórios, a métrica de DLQ e o encerramento gracioso por `SIGTERM`.
**Where**: `src/infrastructure/messaging/sqs-consumer-resilience.ts`
**Depends on**: T37
**Reuses**: `SqsConsumer` (T37)
**Requirement**: SQS-06, SQS-07, SQS-10

**Done when**:

- [ ] Erro transitório (Postgres indisponível) não faz ack e altera a visibilidade com backoff; recuperado o banco, a mensagem é processada
- [ ] Após 5 recebimentos a mensagem chega à DLQ e `dlq_messages_total` incrementa
- [ ] `SIGTERM` para o polling, conclui as mensagens em andamento em até 20 s e devolve a visibilidade das demais
- [ ] Gate completo; ≥ 6 testes

**Tests**: integration
**Gate**: full
**Commit**: `feat(messaging): add consumer retry, dlq and graceful shutdown`

---

#### T39: Worker de PENDING_REFERENCE

**What**: Implementar `ReprocessPendingReference` (trava a wallet primeiro, relê a transação e reaplica `decide`) e o `PendingReferenceWorker` com claim por `SKIP LOCKED`, retry exponencial e esgotamento.
**Where**: `src/infrastructure/messaging/pending-reference-worker.ts`
**Depends on**: T21
**Reuses**: `SubmitWagerTransaction` (T21), `scheduleReferenceRetry` (T7)
**Requirement**: PREF-02, PREF-03, PREF-04, PREF-05, PREF-06

**Done when**:

- [ ] ROLLBACK antes da BET fica `PENDING_REFERENCE` (202); depois da BET, o worker o processa e o saldo volta ao inicial
- [ ] Após 10 tentativas sem referência → `REJECTED` `REFERENCE_NOT_FOUND` com `WagerTransactionRejected`
- [ ] 2 workers sobre a mesma pendência: exatamente um processa, sem deadlock
- [ ] Erro permanente → `FAILED` `PROCESSING_FAILED` sem evento de rejeição; gate completo; ≥ 8 testes

**Tests**: integration
**Gate**: full
**Commit**: `feat(messaging): add pending reference worker`

---

#### T40: Cenários de mensageria e recuperação

**What**: Escrever os cenários: crash depois do commit e antes do ack (`FAULT_INJECTION`), reversão antes da referência de ponta a ponta, mesma operação por HTTP e SQS, e reinício com consistência final.
**Where**: `test/concurrency/messaging-recovery.test.ts`
**Depends on**: T36, T38, T39
**Reuses**: App factory (T26), SQS (T35)
**Requirement**: SQS-09, OUT-09, PREF-03, TEST-02, TEST-03

**Done when**:

- [ ] Crash após commit e antes do ack: a redelivery é detectada pela inbox, sem duplicar efeito
- [ ] Mesma operação por HTTP e por SQS é aplicada uma única vez (a segunda é replay)
- [ ] Reinício dos processos no meio da carga termina com consistência final e `assertReconciled`
- [ ] Ponto de falha só existe com a variável de ambiente de teste; gate de build; ≥ 4 testes

**Tests**: concurrency
**Gate**: build
**Commit**: `test(concurrency): add messaging recovery scenarios`

---

### Phase 9 — Observabilidade

#### T41: Logs estruturados e correlação

**What**: Configurar o logger pino com `AsyncLocalStorage` (`correlationId`, `messageId`, `transactionId`, `walletId`, `providerId`) e propagar `X-Correlation-Id`.
**Where**: `src/infrastructure/observability/logger.ts`
**Depends on**: T27
**Reuses**: `LoggerPort` (T12)
**Requirement**: OBS-01, OBS-02, OBS-03

**Done when**:

- [ ] Logs são JSON e carregam os ids aplicáveis
- [ ] Nenhum log contém `amount`, saldos, `playerId` nem payload (teste inspeciona a saída)
- [ ] `X-Correlation-Id` recebido é propagado; ausente gera UUID; SQS usa `messageId`
- [ ] Gate rápido passa; ≥ 6 testes

**Tests**: unit
**Gate**: quick
**Commit**: `feat(observability): add structured logging with correlation id`

---

#### T42: Métricas Prometheus

**What**: Implementar `MetricsPort` com `prom-client` e expor `GET /metrics` com todas as métricas do spec; as três métricas da outbox vêm do banco.
**Where**: `src/infrastructure/observability/metrics.ts`
**Depends on**: T41
**Reuses**: `MetricsPort` (T12)
**Requirement**: OBS-04, OBS-07, IDEM-08

**Done when**:

- [ ] `/metrics` lista todas as métricas do spec com os labels corretos
- [ ] Replay, conflito e duplicata de inbox incrementam seus contadores
- [ ] `outbox_pending`, `outbox_lag_seconds` e `outbox_messages_high_attempts` refletem o banco
- [ ] `/metrics` responde sem autenticação; gate completo; ≥ 6 testes

**Tests**: integration
**Gate**: full
**Commit**: `feat(observability): expose prometheus metrics`

---

### Phase 10 — Entrega

#### T43: Dockerfile e compose com migrate e app

**What**: Criar o `Dockerfile` e os serviços `migrate` (execução única) e `app` no compose, com healthcheck em `/health/ready` e sem porta fixa para permitir `--scale app=3`.
**Where**: `Dockerfile`
**Depends on**: T36
**Reuses**: `docker-compose.yml` (T2)
**Requirement**: DOC-01, DOC-02

**Done when**:

- [ ] `docker compose up` sobe Postgres, LocalStack, `migrate` (que termina com sucesso) e `app` saudável
- [ ] `docker compose up --scale app=3` sobe 3 réplicas sem conflito de porta
- [ ] Verificação manual registrada no checkpoint: 3 réplicas respondem em `/health/ready`

**Tests**: none
**Gate**: build
**Commit**: `chore(docker): add app image and migrate service`

---

#### T44: Remover o spike

**What**: Remover `spike/` e o script `spike`, e ajustar o `include` do `tsconfig.json`.
**Where**: `tsconfig.json`
**Depends on**: T43
**Reuses**: Nada
**Requirement**: — (suporte; consumido por outras tasks)

**Done when**:

- [ ] `spike/` removido e nenhum import o referencia
- [ ] `bun run typecheck` passa

**Tests**: none
**Gate**: build
**Commit**: `chore: remove validation spike`

---

#### T45: README

**What**: Escrever o `README.md` com pré-requisitos, setup, execução, `--scale app=3` e os comandos de teste.
**Where**: `README.md`
**Depends on**: T43
**Reuses**: Scripts do `package.json` (T1)
**Requirement**: DOC-03

**Done when**:

- [ ] Seguindo só o README em clone limpo, `docker compose up` e `bun run test` passam
- [ ] Lista pré-requisitos, comandos de execução e de teste

**Tests**: none
**Gate**: build
**Commit**: `docs(readme): add setup, run and test instructions`

---

#### T46: Propostas para o ARCHITECTURE.md

**What**: Redigir no chat os trechos curtos para o `ARCHITECTURE.md` (interpretação da regra 7.4, taxonomia de `failureCode`, política de `PENDING_REFERENCE`, desenho Keycloak, trade-offs). **Não editar o arquivo**; aplico só depois do seu ok.
**Where**: `ARCHITECTURE.md`
**Depends on**: T45
**Reuses**: `design.md` e `.specs/STATE.md`
**Requirement**: DOC-04, AUTH-03

**Done when**:

- [ ] Trechos propostos apresentados no chat, no tom do arquivo, cobrindo todos os itens de DOC-04 e AUTH-03
- [ ] `ARCHITECTURE.md` só é alterado depois da aprovação explícita

**Tests**: none
**Gate**: build
**Commit**: `docs(architecture): record delivery decisions`

---

## Phase Execution Map

```
Phase 1 → Phase 2 → Phase 3 → Phase 4 → Phase 5 → Phase 6 → Phase 7 → Phase 8 → Phase 9 → Phase 10
Sob prazo apertado: ... → Phase 8 → Phase 10 → Phase 9
```

Execução estritamente sequencial, uma task por vez, na ordem dos números dentro de cada fase. As setas de cada fase estão no Execution Plan.

46 tasks: pelo skill, mais de ~8 tasks pedem a oferta de sub-agentes por lote de ~7 tasks (fases inteiras). Pela contagem, os lotes seriam: Fases 1–2 (9), 3–4 (10), 5 (6), 6 (5), 7 (4), 8 (6), 9–10 (6). No início do Execute eu apresento a oferta; nada é disparado sem o seu aceite.

---

## Task Granularity Check

| Task | Scope | Status |
| ---- | ----- | ------ |
| T1: Scripts de teste, dependências e .gitignore | 1 arquivo principal em `Where` | ✅ Granular |
| T2: Compose com versões fixas e banco de teste | 1 arquivo principal em `Where` | ✅ Granular |
| T3: Configuração tipada por variáveis de ambiente | 1 arquivo principal em `Where` | ✅ Granular |
| T4: Value object Money e erros de domínio | 1 arquivo principal em `Where` | ✅ Granular |
| T5: Lançamento de ledger imutável | 1 arquivo principal em `Where` | ✅ Granular |
| T6: Agregado Wallet | 1 arquivo principal em `Where` | ✅ Granular |
| T7: Máquina de estados de WagerTransaction | 1 arquivo principal em `Where` | ✅ Granular |
| T8: WagerRules.decide (tabela da seção 7) | 1 arquivo principal em `Where` | ✅ Granular |
| T9: Eventos de integração, inbox e outbox | 1 arquivo principal em `Where` | ✅ Granular |
| T10: Hash canônico do payload | 1 arquivo principal em `Where` | ✅ Granular |
| T11: Contratos Zod compartilhados por HTTP e SQS | 1 arquivo principal em `Where` | ✅ Granular |
| T12: Portas da aplicação | 1 arquivo principal em `Where` | ✅ Granular |
| T13: Config do ORM, runner de migrations e harness de teste | 1 arquivo principal em `Where` | ✅ Granular |
| T14: Migration de wallets e wager_transactions | 1 arquivo principal em `Where` | ✅ Granular |
| T15: Migration de ledger, inbox e outbox, e reconciliação por SQL | 1 arquivo principal em `Where` | ✅ Granular |
| T16: Records, EntitySchema e mappers de wallet e ledger | 1 arquivo principal em `Where` | ✅ Granular |
| T17: Records e mappers de transação, inbox e outbox | 1 arquivo principal em `Where` | ✅ Granular |
| T18: UnitOfWork e repositório de wallet com lock | 1 arquivo principal em `Where` | ✅ Granular |
| T19: Repositórios de transação, ledger, inbox e outbox | 1 arquivo principal em `Where` | ✅ Granular |
| T20: Use case OpenWallet | 1 arquivo principal em `Where` | ✅ Granular |
| T21: Núcleo de SubmitWagerTransaction | 1 arquivo principal em `Where` | ✅ Granular |
| T22: Idempotência no submit | 1 arquivo principal em `Where` | ✅ Granular |
| T23: Retry de concorrência | 1 arquivo principal em `Where` | ✅ Granular |
| T24: Queries de wallet e transação | 1 arquivo principal em `Where` | ✅ Granular |
| T25: ListLedger com cursor | 1 arquivo principal em `Where` | ✅ Granular |
| T26: Bootstrap Nest, runners e health checks | 1 arquivo principal em `Where` | ✅ Granular |
| T27: ExceptionFilter e mapeamento de status | 1 arquivo principal em `Where` | ✅ Granular |
| T28: AuthGuard no-op e ProviderIdentityPort | 1 arquivo principal em `Where` | ✅ Granular |
| T29: Controller de wallets | 1 arquivo principal em `Where` | ✅ Granular |
| T30: Controller de wagering | 1 arquivo principal em `Where` | ✅ Granular |
| T31: Cenários de concorrência por HTTP | 1 arquivo principal em `Where` | ✅ Granular |
| T32: Três processos na mesma wallet | 1 arquivo principal em `Where` | ✅ Granular |
| T33: Use case ReconcileWallet | 1 arquivo principal em `Where` | ✅ Granular |
| T34: Endpoint de reconciliação | 1 arquivo principal em `Where` | ✅ Granular |
| T35: Adaptador SQS e filas de teste | 1 arquivo principal em `Where` | ✅ Granular |
| T36: Publicador da outbox | 1 arquivo principal em `Where` | ✅ Granular |
| T37: Consumidor SQS com inbox | 1 arquivo principal em `Where` | ✅ Granular |
| T38: Retry, DLQ e SIGTERM do consumidor | 1 arquivo principal em `Where` | ✅ Granular |
| T39: Worker de PENDING_REFERENCE | 1 arquivo principal em `Where` | ✅ Granular |
| T40: Cenários de mensageria e recuperação | 1 arquivo principal em `Where` | ✅ Granular |
| T41: Logs estruturados e correlação | 1 arquivo principal em `Where` | ✅ Granular |
| T42: Métricas Prometheus | 1 arquivo principal em `Where` | ✅ Granular |
| T43: Dockerfile e compose com migrate e app | 1 arquivo principal em `Where` | ✅ Granular |
| T44: Remover o spike | 1 arquivo principal em `Where` | ✅ Granular |
| T45: README | 1 arquivo principal em `Where` | ✅ Granular |
| T46: Propostas para o ARCHITECTURE.md | 1 arquivo principal em `Where` | ✅ Granular |

## Diagram-Definition Cross-Check

Dependências dentro da mesma fase conferidas contra as setas do Execution Plan. Dependências entre fases apontam sempre para trás e não têm seta.

| Task | Depends On (task body) | Diagram Shows | Status |
| ---- | ---------------------- | ------------- | ------ |
| T1 | None | None (intra-fase) | ✅ Match |
| T2 | None | None (intra-fase) | ✅ Match |
| T3 | T1 | T1 | ✅ Match |
| T4 | None | None (intra-fase) | ✅ Match |
| T5 | T4 | T4 | ✅ Match |
| T6 | T5 | T5 | ✅ Match |
| T7 | T4 | T4 | ✅ Match |
| T8 | T6, T7 | T6, T7 | ✅ Match |
| T9 | T4 | T4 | ✅ Match |
| T10 | T4 | None (intra-fase) | ✅ Match |
| T11 | T4 | None (intra-fase) | ✅ Match |
| T12 | T6, T7, T9 | None (intra-fase) | ✅ Match |
| T13 | T3 | None (intra-fase) | ✅ Match |
| T14 | T13 | T13 | ✅ Match |
| T15 | T14 | T14 | ✅ Match |
| T16 | T15 | T15 | ✅ Match |
| T17 | T16 | T16 | ✅ Match |
| T18 | T16 | T16 | ✅ Match |
| T19 | T17, T18 | T17, T18 | ✅ Match |
| T20 | T19 | None (intra-fase) | ✅ Match |
| T21 | T20 | T20 | ✅ Match |
| T22 | T21 | T21 | ✅ Match |
| T23 | T22 | T22 | ✅ Match |
| T24 | T21 | T21 | ✅ Match |
| T25 | T21 | T21 | ✅ Match |
| T26 | T25 | None (intra-fase) | ✅ Match |
| T27 | T26 | T26 | ✅ Match |
| T28 | T26 | T26 | ✅ Match |
| T29 | T27, T28 | T27, T28 | ✅ Match |
| T30 | T29 | T29 | ✅ Match |
| T31 | T30 | None (intra-fase) | ✅ Match |
| T32 | T31 | T31 | ✅ Match |
| T33 | T32 | T32 | ✅ Match |
| T34 | T33 | T33 | ✅ Match |
| T35 | T26 | None (intra-fase) | ✅ Match |
| T36 | T35 | T35 | ✅ Match |
| T37 | T35 | T35 | ✅ Match |
| T38 | T37 | T37 | ✅ Match |
| T39 | T21 | None (intra-fase) | ✅ Match |
| T40 | T36, T38, T39 | T36, T38, T39 | ✅ Match |
| T41 | T27 | None (intra-fase) | ✅ Match |
| T42 | T41 | T41 | ✅ Match |
| T43 | T36 | None (intra-fase) | ✅ Match |
| T44 | T43 | T43 | ✅ Match |
| T45 | T43 | T43 | ✅ Match |
| T46 | T45 | T45 | ✅ Match |

## Test Co-location Validation

| Task | Code Layer Created/Modified | Matrix Requires | Task Says | Status |
| ---- | --------------------------- | --------------- | --------- | ------ |
| T1: Scripts de teste, dependências e .gitignore | Ports / config de compose / docs | none | none | ✅ OK |
| T2: Compose com versões fixas e banco de teste | Ports / config de compose / docs | none | none | ✅ OK |
| T3: Configuração tipada por variáveis de ambiente | Contratos Zod / config / guard | unit | unit | ✅ OK |
| T4: Value object Money e erros de domínio | Domain | unit | unit | ✅ OK |
| T5: Lançamento de ledger imutável | Domain | unit | unit | ✅ OK |
| T6: Agregado Wallet | Domain | unit | unit | ✅ OK |
| T7: Máquina de estados de WagerTransaction | Domain | unit | unit | ✅ OK |
| T8: WagerRules.decide (tabela da seção 7) | Domain | unit | unit | ✅ OK |
| T9: Eventos de integração, inbox e outbox | Domain | unit | unit | ✅ OK |
| T10: Hash canônico do payload | Domain | unit | unit | ✅ OK |
| T11: Contratos Zod compartilhados por HTTP e SQS | Contratos Zod / config / guard | unit | unit | ✅ OK |
| T12: Portas da aplicação | Ports / config de compose / docs | none | none | ✅ OK |
| T13: Config do ORM, runner de migrations e harness de teste | Persistence (migrations, schemas, repos, UoW) | integration | integration | ✅ OK |
| T14: Migration de wallets e wager_transactions | Persistence (migrations, schemas, repos, UoW) | integration | integration | ✅ OK |
| T15: Migration de ledger, inbox e outbox, e reconciliação por SQL | Persistence (migrations, schemas, repos, UoW) | integration | integration | ✅ OK |
| T16: Records, EntitySchema e mappers de wallet e ledger | Persistence (migrations, schemas, repos, UoW) | integration | integration | ✅ OK |
| T17: Records e mappers de transação, inbox e outbox | Persistence (migrations, schemas, repos, UoW) | integration | integration | ✅ OK |
| T18: UnitOfWork e repositório de wallet com lock | Persistence (migrations, schemas, repos, UoW) | integration | integration | ✅ OK |
| T19: Repositórios de transação, ledger, inbox e outbox | Persistence (migrations, schemas, repos, UoW) | integration | integration | ✅ OK |
| T20: Use case OpenWallet | Use cases | integration | integration | ✅ OK |
| T21: Núcleo de SubmitWagerTransaction | Use cases | integration | integration | ✅ OK |
| T22: Idempotência no submit | Use cases | integration | integration | ✅ OK |
| T23: Retry de concorrência | Use cases | integration | integration | ✅ OK |
| T24: Queries de wallet e transação | Use cases | integration | integration | ✅ OK |
| T25: ListLedger com cursor | Use cases | integration | integration | ✅ OK |
| T26: Bootstrap Nest, runners e health checks | HTTP (Nest) | integration | integration | ✅ OK |
| T27: ExceptionFilter e mapeamento de status | HTTP (Nest) | integration | integration | ✅ OK |
| T28: AuthGuard no-op e ProviderIdentityPort | Contratos Zod / config / guard | unit | unit | ✅ OK |
| T29: Controller de wallets | HTTP (Nest) | integration | integration | ✅ OK |
| T30: Controller de wagering | HTTP (Nest) | integration | integration | ✅ OK |
| T31: Cenários de concorrência por HTTP | Cenários da seção 13 | concurrency | concurrency | ✅ OK |
| T32: Três processos na mesma wallet | Cenários da seção 13 | concurrency | concurrency | ✅ OK |
| T33: Use case ReconcileWallet | Use cases | integration | integration | ✅ OK |
| T34: Endpoint de reconciliação | HTTP (Nest) | integration | integration | ✅ OK |
| T35: Adaptador SQS e filas de teste | Messaging (SQS, outbox, worker) | integration | integration | ✅ OK |
| T36: Publicador da outbox | Messaging (SQS, outbox, worker) | integration | integration | ✅ OK |
| T37: Consumidor SQS com inbox | Messaging (SQS, outbox, worker) | integration | integration | ✅ OK |
| T38: Retry, DLQ e SIGTERM do consumidor | Messaging (SQS, outbox, worker) | integration | integration | ✅ OK |
| T39: Worker de PENDING_REFERENCE | Messaging (SQS, outbox, worker) | integration | integration | ✅ OK |
| T40: Cenários de mensageria e recuperação | Cenários da seção 13 | concurrency | concurrency | ✅ OK |
| T41: Logs estruturados e correlação | Contratos Zod / config / guard | unit | unit | ✅ OK |
| T42: Métricas Prometheus | HTTP (Nest) | integration | integration | ✅ OK |
| T43: Dockerfile e compose com migrate e app | Ports / config de compose / docs | none | none | ✅ OK |
| T44: Remover o spike | Ports / config de compose / docs | none | none | ✅ OK |
| T45: README | Ports / config de compose / docs | none | none | ✅ OK |
| T46: Propostas para o ARCHITECTURE.md | Ports / config de compose / docs | none | none | ✅ OK |

`Tests: none` aparece apenas em T1, T2, T12 e T43–T46, todas com camada "none" na matriz (config, portas, compose, docs). Nenhum teste foi adiado para outra task.

