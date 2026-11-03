# State

## Decisions

### AD-001
- **Decision**: MikroORM com mapeamento via `EntitySchema`/`defineEntity`, sem decorators; domínio e persistência em camadas separadas.
- **Reason**: ORM preferencial do enunciado (UoW, `transactional()`, `LockMode`); sem decorators o domínio fica puro e testável sem ORM.
- **Trade-off**: mais código de mapeamento manual; se MikroORM falhar no Bun, cair para TypeORM (requer aviso prévio).
- **Scope**: toda a persistência.
- **Date**: 2026-11-03
- **Status**: active

### AD-002
- **Decision**: Autenticação não implementada; `AuthGuard` no-op + `ProviderIdentityPort`, desenho Keycloak (client credentials, JWKS, providerId do token == body, senão 403) documentado.
- **Reason**: auth não pontua; timebox vai para correção financeira e concorrência.
- **Trade-off**: API aberta no ambiente local.
- **Scope**: camada HTTP.
- **Date**: 2026-11-03
- **Status**: active

### AD-003
- **Decision**: Uma referência é revertida no máximo uma vez no total: `UNIQUE (reference_transaction_id) WHERE kind IN ('REFUND','ROLLBACK') AND status='PROCESSED'`.
- **Reason**: índice por (referência, kind) permitiria REFUND + ROLLBACK da mesma BET (crédito duplicado).
- **Trade-off**: mais restritivo que a letra da regra 7.4; documentado como interpretação.
- **Scope**: schema de transações, regras de reversão.
- **Date**: 2026-11-03
- **Status**: active

### AD-004
- **Decision**: Idempotência por `UNIQUE (provider_id, idempotency_key)`; `(provider_id, external_transaction_id)` também único, conflito → 409 `EXTERNAL_ID_CONFLICT`; replay devolve o status HTTP original com `idempotentReplay: true`.
- **Reason**: keys são do provedor; replay com mesmo status deixa o cliente tratar retry igual à primeira resposta.
- **Trade-off**: duas constraints de unicidade a manter coerentes.
- **Scope**: submissão HTTP e SQS.
- **Date**: 2026-11-03
- **Status**: active

### AD-005
- **Decision**: Concorrência por wallet com `SELECT … FOR UPDATE` + `UPDATE … WHERE version = :expected` como defesa extra + `lock_timeout` curto (estouro = transitório → retry limitado → 503 `CONCURRENCY_CONFLICT`).
- **Reason**: hot wallet serializa sem tempestade de retries; o predicado de versão pega qualquer caminho sem lock; sem lock global.
- **Trade-off**: throughput de uma wallet limitado a uma transação por vez; conexões esperam até o `lock_timeout`.
- **Scope**: todo use case que altera saldo.
- **Date**: 2026-11-03
- **Status**: active

### AD-006
- **Decision**: Outbox publicada por claim com lease (`FOR UPDATE SKIP LOCKED` + `locked_until`), commit do claim antes da chamada ao SQS, retry sem limite com métrica de mensagens com muitas tentativas.
- **Reason**: nenhuma transação aberta durante rede; crash após o claim é recuperado quando a lease expira; nunca descarta evento confirmado.
- **Trade-off**: publicação duplicada possível (at-least-once), mitigada por `eventId` como `MessageDeduplicationId` e dedup no consumidor.
- **Scope**: publisher da outbox.
- **Date**: 2026-11-03
- **Status**: active
