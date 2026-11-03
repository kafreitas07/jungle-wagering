# Wagering Processor — Specification

> Fonte: `instrucoes-teste.md` (desafio técnico Jungle Gaming) + ajustes do candidato (2026-11-03).
> Convenção: critérios em EARS com palavras-chave em inglês (`WHEN`/`IF … THEN`/`WHILE`/`The system SHALL`) e conteúdo em português.
> Escopo: **Complex** (domínio financeiro, concorrência, mensageria). Todas as dimensões implícitas estão cobertas abaixo.

## Problem Statement

Provedores de jogos enviam operações de aposta (`BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`) com entrega at-least-once: duplicadas, fora de ordem e concorrentes, via HTTP e via SQS FIFO. O serviço precisa aplicar essas operações em wallets com correção financeira absoluta — sem crédito/débito duplicado, sem saldo negativo, sem perder eventos confirmados — mesmo com 3+ instâncias rodando e com PostgreSQL/SQS falhando temporariamente. As garantias devem estar no **schema do banco**, não só no código.

## Goals

- [ ] Zero débito/crédito duplicado e zero saldo negativo em todos os testes de concorrência (50 réplicas paralelas, hot wallet, 3+ processos).
- [ ] `wallet.balance == saldo reconstruído pelo ledger` ao fim de **todo** teste de integração/concorrência (verificado pelo endpoint de reconciliação).
- [ ] Toda transação financeira, ledger, inbox e outbox confirmados atomicamente; nenhum evento publicado antes do commit; nenhum evento confirmado perdido após crash.
- [ ] Toda resposta de erro distinguível por status HTTP + `failureCode` estável, sem o provedor precisar ler mensagem.
- [ ] `README.md` e `ARCHITECTURE.md` permitem subir, testar e defender cada decisão.

## Out of Scope

| Item | Motivo |
| --- | --- |
| Keycloak / qualquer IdP real | Decisão do candidato; auth não pontua (seção 2). Substituído por `AuthGuard` no-op + `ProviderIdentityPort`, desenho documentado. |
| Teste de carga (`test:load`) | Diferencial opcional; fora do timebox. |
| Ledger double-entry | Diferencial opcional; ledger single-entry por wallet atende a seção 6.4. |
| Reversão parcial | Explicitamente fora de escopo (regra 7.5). |
| Operação real multi-moeda | Enunciado permite assumir só `BRL`; o modelo continua multi-moeda e conflito de moeda é testado. |
| Ciclo de vida de rodada (abrir/fechar round) | Não pedido; `roundId` é só atributo de validação de referência. |
| Correção automática de divergência na reconciliação | Proibido pelo enunciado ("não corrigidas silenciosamente"). |
| Fechar/bloquear/excluir wallet, depósito/saque | Não pedido. |
| OpenTelemetry e dashboard | Opcionais; métricas em formato Prometheus em `/metrics` bastam. |
| Rate limiting | Não pedido; sem pontos. |

---

## Assumptions & Open Questions

| Assumption / decision | Chosen default | Rationale | Confirmed? |
| --- | --- | --- | --- |
| Reversão única (interpretação da regra 7.4) | `UNIQUE (reference_transaction_id) WHERE kind IN ('REFUND','ROLLBACK') AND status='PROCESSED'`: uma referência é revertida **no máximo uma vez no total**, por qualquer tipo. | Índice por (referência, kind) permitiria REFUND **e** ROLLBACK da mesma BET = crédito duplicado. Mais restritivo que a letra da regra, documentado no ARCHITECTURE.md. | y (ajuste 1) |
| Escopo da idempotency key | `UNIQUE (provider_id, idempotency_key)`. | Keys são geradas pelo provedor; dois provedores podem colidir sem relação entre si. | y (ajuste 2) |
| Mesmo `(providerId, externalTransactionId)` com key diferente | 409 `EXTERNAL_ID_CONFLICT`, nada é aplicado. `UNIQUE (provider_id, external_transaction_id)` no banco. | Evita que o mesmo id externo vire duas transações por troca de key. | y (ajuste 3) |
| Status HTTP do replay | Replay devolve o mesmo status HTTP e corpo da resposta original (201, 202 ou 422) com `idempotentReplay: true`. | Provedor trata replay igual à primeira resposta; 200 confundiria "aplicado agora" com "já aplicado". | y (ajuste 4) |
| Replay de transação que **mudou de estado** desde a resposta original (era 202 `PENDING_REFERENCE`, hoje `PROCESSED`/`REJECTED`) | O replay reflete o **estado persistido atual**: 201 se hoje `PROCESSED`, 422 se `REJECTED`, 202 se ainda pendente. Para estados terminais isso é idêntico à resposta original. | A regra 7.7 fala de operação "já processada"; para pendentes, devolver o 202 antigo esconderia do provedor um resultado que já existe. | y |
| Formato de `amount` na entrada | Regex `^\d+\.\d{2}$` aplicada **na validação do contrato** (HTTP e SQS). `"25"` e `"25.5"` são rejeitados (400). `Money` em si aceita negativos internamente (`negate`/`subtract`). | Separa regra de contrato (escala fixa, não-negativo) da álgebra do value object. | y (ajuste 6) |
| Valor zero | `money.amount` deve ser `> 0.00` para `BET`, `WIN`, `REFUND` e `ROLLBACK` (400 `VALIDATION_ERROR`); `LOSS` aceita `>= 0.00`; `initialBalance` aceita `>= 0.00`. | Movimento de valor zero não tem significado financeiro e geraria lançamento vazio; `LOSS` não move saldo, então `0.00` é um resultado legítimo; wallet pode abrir zerada. | y |
| Limite de magnitude | `amount` com no máximo 18 dígitos inteiros; colunas `numeric(20,2)`. | Limite explícito evita overflow silencioso e define bound testável. | y |
| `WIN`/`LOSS` com `referenceExternalTransactionId` | Opcional. Se informado, é resolvido e validado pelas mesmas regras de referência (mesmo provider/player/wallet/moeda/rodada, deve ser `BET`); ausente → `PENDING_REFERENCE`. Sem referência → processa sem vínculo. | Enunciado diz "pode referenciar a BET"; aplicar a mesma regra evita dois caminhos de validação. Múltiplos `WIN` por `BET` são permitidos. | y |
| Referência em estado não-terminal (`PENDING`/`PENDING_REFERENCE`) | Tratada como ausente: a dependente vai/permanece em `PENDING_REFERENCE`. | A referência ainda pode ser aplicada; rejeitar agora seria prematuro. | y |
| Referência `REJECTED`/`FAILED` | Dependente `REJECTED` com `REFERENCE_NOT_PROCESSED`. | Regras 7.REFUND/ROLLBACK exigem referência `PROCESSED`; estado terminal nunca mudará. | y |
| Política do worker de `PENDING_REFERENCE` | Backoff exponencial base 1 s, fator 2, teto 5 min, **máx. 10 tentativas** (~14 min no total); configurável por env. Esgotado → `REJECTED` `REFERENCE_NOT_FOUND` + evento `WagerTransactionRejected`. | Provedores enviam a referência em segundos/minutos; 14 min cobre atraso realista de fila sem manter pendências indefinidamente. | y |
| Referência que chega **depois** da dependente já ter sido rejeitada por `REFERENCE_NOT_FOUND` | A referência é processada normalmente; a dependente rejeitada **não** é reaberta (estado terminal). | Estados terminais são imutáveis (seção 6.3); o provedor recebeu o evento de rejeição e decide reenviar com novo id. | y |
| `walletId` inexistente na submissão | 422 `WALLET_NOT_FOUND`, **não** persistido (não há wallet para FK); logado e contado em métrica. Via SQS: ack. | Sem wallet não há agregado para auditar; a resposta é determinística e não depende de estado da transação. | y |
| `playerId` diferente do dono da wallet, ou moeda diferente da moeda da wallet | `422` `WALLET_PLAYER_MISMATCH` / `CURRENCY_MISMATCH` **sem persistir** a transação (mesmo critério de `WALLET_NOT_FOUND`); via SQS: ack + log + métrica; nenhum evento na outbox. No schema, `FOREIGN KEY (wallet_id, currency, player_id) → wallets (id, currency, player_id)` impede que uma transação inconsistente seja gravada. | A chave estrangeira composta torna impossível gravar a transação com player ou moeda diferentes da wallet; rejeitar antes do INSERT é a única saída coerente com o schema. A evidência fica em log e métrica. | y |
| `providerId` reservado | `"internal"` é reservado às transações `OPENING`; o contrato Zod rejeita `providerId = "internal"` (400 `VALIDATION_ERROR`). | Evita que um provedor colida com `opening:{walletId}` e burle a regra de `OPENING` interno. | y |
| Ordem dos eventos da outbox | **Best-effort**: falha com backoff e publishers concorrentes podem inverter eventos de uma mesma wallet. O consumidor ordena por `walletVersion` e deduplica por `eventId`. Não se promete ordem estrita. | A garantia real é entrega at-least-once sem perda; ordem estrita exigiria um publisher único por wallet, o que contradiz múltiplas réplicas. | y |
| Agregação das métricas globais da outbox | `outbox_pending`, `outbox_lag_seconds` e `outbox_messages_high_attempts` são lidas do banco, então todas as réplicas reportam o mesmo valor. Agregam-se com `max()`, nunca com `sum()`. | `sum()` multiplicaria o valor pelo número de réplicas. | y |
| Conflito de idempotência vindo do SQS (`IDEMPOTENCY_KEY_REUSED`, `EXTERNAL_ID_CONFLICT`) | Mensagem vai para `wager-transactions-dlq.fifo` + ack + métrica; nada é gravado. | Mesmo critério do `messageId` com payload divergente: o que não fica registrado no banco preserva a evidência na DLQ. | y |
| Bancos de teste | Testes de integração e concorrência rodam no banco `wagering_test`, separado do de desenvolvimento; `bun run test` executa unidade, integração e concorrência. | Evita que testes sujem ou dependam do banco de desenvolvimento. | y |
| Imagens do Compose | Versões fixas (PostgreSQL e LocalStack), nunca `:latest`. | Reprodutibilidade para o avaliador. | y |
| Uso de `PENDING` | Estado inicial em memória (`WagerTransaction.create`); no caminho síncrono a transação é persistida já no estado resultante (`PROCESSED`/`REJECTED`/`PENDING_REFERENCE`) na mesma transação SQL. | Evita commits intermediários que precisariam de recuperação própria. | y |
| Uso de `FAILED` | Transação já persistida (`PENDING_REFERENCE`) cujo reprocessamento sofre erro permanente não-negocial (ex.: estado inconsistente detectado, exceção não classificada após esgotar retries) → `FAILED` com `failureCode` `PROCESSING_FAILED`, auditável, evento `WagerTransactionRejected` **não** é emitido (é falha nossa, não regra de negócio) — métrica + log de erro. | Enunciado define FAILED como erro permanente de infra auditável; o único lugar onde a transação já existe e o erro é nosso é o worker. | y |
| Mesmo `messageId` SQS com payload diferente | Enviar a mensagem para `wager-transactions-dlq.fifo`, fazer ack, log `warn` e incrementar `inbox_payload_conflict_total`; nada é processado. | A inbox é por `(consumerName, messageId)`; reprocessar quebraria a dedup. Mandar para a DLQ preserva a evidência para investigação (só ack a descartaria). | y |
| Mensagem SQS malformada (JSON inválido, schema inválido, `kind=OPENING`) | Erro permanente → não faz ack; a redrive policy da fila move para a DLQ após `maxReceiveCount=5`. Mensagem malformada é enviada imediatamente para a DLQ (sem esperar 5 recebimentos) e depois recebe ack. | Seção 10: permanente → DLQ. Envio explícito evita bloquear o message group FIFO por 5 ciclos de visibilidade. | y |
| Retentativa transitória no consumidor SQS | Sem ack + `ChangeMessageVisibility` com backoff exponencial (base 2 s, teto 60 s); após `maxReceiveCount=5` a redrive policy envia para a DLQ. | Retry nativo do SQS sobrevive a crash do consumidor; limite explícito antes da DLQ. | y |
| Filas de eventos | Outbox publica em `wallet-events.fifo`, `MessageGroupId = walletId`, `MessageDeduplicationId = eventId`. Filas de entrada também usam `MessageGroupId = walletId`. | Ordenação por wallet é otimização; dedup do broker reduz duplicatas, mas consumidor continua deduplicando por `eventId`. | y (ajuste 7) |
| Retry da outbox | Sem limite de tentativas (nunca descarta evento confirmado); backoff exponencial base 1 s, teto 60 s; `outbox_lag_seconds` e gauge `outbox_messages_high_attempts` (pendentes com `attempts >=` limiar configurável, default 10). | Invariante "não perder eventos confirmados" proíbe descartar; lag e contagem de mensagens com muitas tentativas sinalizam o problema operacionalmente. | y |
| Ledger: ordem e paginação | Cada lançamento guarda `wallet_version` (versão da wallet **após** o lançamento), `UNIQUE (wallet_id, wallet_version)`. Paginação ordenada por `wallet_version` **decrescente**; cursor = base64url opaco de `{v: wallet_version}`; `limit` default 50, máx. 200. | `wallet_version` é monotônica por wallet e estável → cursor estável; unique prova no schema que não há dois lançamentos para a mesma versão (sem lost update). | y (ajuste 5) |
| Lançamento de `OPENING` | `initialBalance > 0` → transação `OPENING` `PROCESSED` + ledger `CREDIT` com `wallet_version = 1`. `initialBalance = 0` → sem transação e sem ledger; wallet nasce com `version = 1`. | `version` inicia em 1 após criação (6.2) e o ledger precisa espelhar o saldo. | y |
| Algoritmo do `payloadHash` | SHA-256 hex de JSON canônico (chaves ordenadas recursivamente, sem espaços, UTF-8) dos campos: `providerId`, `externalTransactionId`, `playerId`, `walletId`, `roundId`, `gameId`, `kind`, `money.amount`, `money.currency`, `referenceExternalTransactionId` (omitido se ausente). Idêntico para HTTP e SQS. | Requisição HTTP e mensagem SQS da mesma operação são replay uma da outra. Header, `messageId`, `occurredAt` e `idempotencyKey` ficam fora (metadados). | y |
| Dados nos logs | Logs carregam ids (`correlationId`, `messageId`, `transactionId`, `walletId`, `providerId`), `kind`, `status`, `failureCode`, duração. **Não** carregam `amount`, saldos, `playerId` nem payload. | Seção 12 proíbe payload financeiro completo; ids bastam para diagnóstico e correlação. | y |
| Estratégia de concorrência | `SELECT … FOR UPDATE` na linha da wallet (lock por wallet) + `UPDATE … WHERE id = :id AND version = :expected` como defesa extra + `lock_timeout` curto na sessão. Estouro do `lock_timeout` = erro transitório: retry limitado e, esgotado, 503 `CONCURRENCY_CONFLICT` + `Retry-After`. | Lock pessimista serializa a hot wallet sem tempestade de retries do otimista; o predicado de `version` pega qualquer caminho que esqueça o lock; `lock_timeout` impede fila de espera ilimitada. Nenhum lock global. | y |
| ORM | MikroORM com `EntitySchema`/`defineEntity` (sem decorators), domínio separado da persistência. Se quebrar no Bun durante o spike, avisar antes de trocar para TypeORM. | Preferencial no enunciado; mapeamento sem decorators mantém domínio puro. | y |
| Representação interna de `Money` | `bigint` em centavos, escala fixa 2; persistência em `numeric(20,2)` lida pelo driver como string e convertida para `bigint` (nunca `number`). | Aritmética inteira exata, sem biblioteca decimal; string no driver evita perda de precisão do `pg`. | y |
| Topologia de execução | Monólito modular hexagonal (`domain/` → `application/` → `infrastructure/`); uma imagem, N réplicas no Compose; cada instância roda API + consumidor SQS + publisher da outbox + worker de `PENDING_REFERENCE`. | Toda garantia de concorrência é exercitada com réplicas idênticas; sem coordenação fora do Postgres. | y |
| Idioma dos documentos | `.specs/`, `README.md` e `ARCHITECTURE.md` em português; código, nomes, comentários, logs e commits em inglês. | Enunciado e banca em português; código segue convenção da indústria. | y |

**Open questions:** none — todas resolvidas ou registradas acima. Todos os defaults foram confirmados pelo candidato em 2026-11-03.

---

## User Stories

### P1: Money exato ⭐ MVP

**User Story**: Como serviço financeiro, quero um value object `Money` imutável e exato para que nenhum valor monetário passe por `number`/float.

**Why P1**: Falha eliminatória (`number` para dinheiro); base de todo o resto.

**Acceptance Criteria**:

1. The system SHALL representar valores monetários sem `number`/`float`/`double` em domínio, contratos e persistência: internamente `bigint` em centavos, coluna `numeric(20,2)` lida como string, string decimal no JSON.
2. WHEN `Money.from` recebe amount decimal válido THEN `Money` SHALL preservar o valor exato e serializar com exatamente 2 casas (`toJSON().amount`, `toString()`).
3. WHEN `add`, `subtract` ou `negate` é chamado THEN `Money` SHALL retornar nova instância e manter a original inalterada.
4. WHEN `subtract` ou `negate` produz resultado negativo THEN `Money` SHALL representá-lo (ex.: `"-5.00"`) e `isNegative()` SHALL retornar `true`.
5. IF uma operação recebe `Money` de moeda diferente THEN `Money` SHALL lançar `CurrencyMismatchError` (erro de domínio).
6. IF `Money.from` recebe `NaN`, `Infinity`, notação científica, string vazia, não-numérico ou mais de 2 casas decimais THEN `Money` SHALL lançar `InvalidMoneyError`.
7. IF `currency` não é código ISO-4217 de 3 letras maiúsculas THEN `Money` SHALL lançar `InvalidMoneyError`.
8. IF o contrato de entrada (HTTP/SQS) recebe `amount` fora de `^\d+\.\d{2}$` (ex.: `"25"`, `"25.5"`, `"-1.00"`, `"1e3"`) THEN the system SHALL rejeitar com 400 `VALIDATION_ERROR` antes de chegar ao domínio.
9. The system SHALL manter o domínio (`Money`, entidades) livre de dependências de NestJS e de tipos/decorators do ORM.

**Independent Test**: suíte unitária de `Money` sem banco.

---

### P1: Wallet e abertura ⭐ MVP

**User Story**: Como plataforma, quero criar e consultar wallets por jogador e moeda para que as apostas tenham um agregado com saldo e versão.

**Why P1**: Agregado raiz de todas as invariantes.

**Acceptance Criteria**:

1. WHEN `POST /wallets` recebe `playerId` UUID e `initialBalance` válido THEN the system SHALL criar a wallet com `version = 1` e responder 201 com `id`, `playerId`, `balance`, `version`.
2. WHEN `initialBalance > 0` THEN the system SHALL criar, na mesma transação SQL, uma transação `OPENING` `PROCESSED` e um lançamento `CREDIT` com `balanceBefore = 0.00`, `balanceAfter = initialBalance`, `wallet_version = 1`.
3. WHEN `initialBalance = 0.00` THEN the system SHALL criar a wallet sem transação e sem lançamento de ledger.
4. IF já existe wallet para o mesmo `playerId` + `currency` THEN the system SHALL responder 409 `WALLET_ALREADY_EXISTS`, garantido por `UNIQUE (player_id, currency)` inclusive sob criação concorrente.
5. WHEN `GET /wallets/:walletId` é chamado com id existente THEN the system SHALL responder 200 com `id`, `playerId`, `balance`, `version`.
6. IF `walletId` não existe (ou não é UUID) THEN `GET /wallets/:walletId` SHALL responder 404 `WALLET_NOT_FOUND` (ou 400 `VALIDATION_ERROR` para id malformado).
7. The system SHALL incrementar `version` da wallet em exatamente 1 a cada mudança de saldo e SHALL não alterá-la em operações sem efeito no saldo (`LOSS`, `REJECTED`, `PENDING_REFERENCE`).
8. IF uma operação deixaria o saldo negativo THEN `Wallet` SHALL recusar a mudança (erro de domínio) e o banco SHALL impedir via `CHECK (balance >= 0)`.
9. IF a moeda da operação difere da moeda da wallet THEN `Wallet` SHALL lançar `CurrencyMismatchError`, e o sistema SHALL responder 422 `CURRENCY_MISMATCH` sem persistir a transação, garantido no schema por `FOREIGN KEY (wallet_id, currency, player_id) → wallets (id, currency, player_id)`.

**Independent Test**: criar wallet com 1000.00 e com 0.00, consultar, ver ledger com 1 e 0 lançamentos.

---

### P1: Submissão de transações de aposta ⭐ MVP

**User Story**: Como provedor de jogo, quero submeter `BET`, `WIN`, `LOSS`, `REFUND` e `ROLLBACK` para que o saldo do jogador reflita a rodada.

**Why P1**: Núcleo do desafio.

**Acceptance Criteria**:

1. WHEN uma `BET` válida com saldo suficiente é submetida THEN the system SHALL debitar o valor, criar 1 lançamento `DEBIT`, marcar `PROCESSED` e responder 201 `{transactionId, status, balance, idempotentReplay:false}`.
2. IF a `BET` excede o saldo THEN the system SHALL marcar `REJECTED` `INSUFFICIENT_FUNDS`, não alterar saldo nem ledger, e responder 422 com `failureCode`.
3. WHEN um `WIN` válido é submetido THEN the system SHALL creditar o valor, criar 1 lançamento `CREDIT` e marcar `PROCESSED`.
4. WHEN um `LOSS` válido é submetido THEN the system SHALL marcar `PROCESSED` sem alterar saldo, sem lançamento e sem incrementar `version`.
5. IF `kind` é `OPENING` (HTTP ou SQS) THEN the system SHALL rejeitar com 400 `VALIDATION_ERROR` sem persistir.
6. IF `REFUND` ou `ROLLBACK` não traz `referenceExternalTransactionId` THEN the system SHALL rejeitar com 400 `VALIDATION_ERROR`, também garantido por `CHECK` no banco.
7. IF `walletId` não existe THEN the system SHALL responder 422 `WALLET_NOT_FOUND` sem persistir transação.
8. IF `playerId` não é o dono da wallet THEN the system SHALL responder 422 `WALLET_PLAYER_MISMATCH` sem persistir a transação, garantido no schema pela mesma chave estrangeira composta.
9. The system SHALL persistir cada transação com `providerId`, `externalTransactionId`, `idempotencyKey`, `payloadHash`, `walletId`, `playerId`, `roundId`, `gameId`, `kind`, `amount`, `currency`, `status`, `failureCode`, `referenceTransactionId`, `balanceAfter` observado e timestamps.
10. WHEN `GET /wagering/transactions/:transactionId` ou `GET /providers/:providerId/wagering/transactions/:externalTransactionId` é chamado THEN the system SHALL responder 200 com status, `failureCode`, `money`, `kind`, referência e `balanceAfter`; inexistente SHALL responder 404 `TRANSACTION_NOT_FOUND`.
11. IF uma transição de estado é tentada a partir de `PROCESSED`, `REJECTED` ou `FAILED` THEN `WagerTransaction` SHALL lançar `InvalidTransactionStateError`.
12. The system SHALL permitir somente as transições `PENDING → PROCESSED | REJECTED | PENDING_REFERENCE | FAILED` e `PENDING_REFERENCE → PROCESSED | REJECTED | FAILED`.
13. IF `money.amount` é `0.00` em `BET`, `WIN`, `REFUND` ou `ROLLBACK` THEN the system SHALL rejeitar com 400 `VALIDATION_ERROR`; `LOSS` com `0.00` SHALL ser aceito.
14. IF `providerId` é `"internal"` THEN the system SHALL rejeitar com 400 `VALIDATION_ERROR` (valor reservado às transações `OPENING`).

**Independent Test**: sequência BET → WIN → LOSS numa wallet e checagem de saldo, ledger e status.

---

### P1: Reversões e referências ⭐ MVP

**User Story**: Como provedor, quero reverter apostas (`REFUND`) e transações (`ROLLBACK`) com segurança para que nunca haja crédito duplicado.

**Why P1**: Reversões são a principal fonte de crédito duplicado.

**Acceptance Criteria**:

1. The system SHALL resolver a referência por `(providerId, referenceExternalTransactionId)`.
2. IF a referência pertence a outro player, wallet, moeda ou rodada THEN the system SHALL marcar `REJECTED` `REFERENCE_MISMATCH`.
3. IF `REFUND` referencia algo que não é `BET`, ou `ROLLBACK` referencia algo fora de `BET`/`WIN`/`REFUND` THEN the system SHALL marcar `REJECTED` `INVALID_REFERENCE_KIND`.
4. IF o valor de `REFUND`/`ROLLBACK` difere do valor da referência THEN the system SHALL marcar `REJECTED` `AMOUNT_MISMATCH`.
5. IF a referência está `REJECTED` ou `FAILED` THEN the system SHALL marcar a dependente `REJECTED` `REFERENCE_NOT_PROCESSED`.
6. WHEN `REFUND` de uma `BET` `PROCESSED` é válido THEN the system SHALL creditar o valor com 1 lançamento `CREDIT` e gravar `referenceTransactionId`.
7. WHEN `ROLLBACK` válido referencia `BET` THEN the system SHALL creditar; WHEN referencia `WIN` ou `REFUND` THEN the system SHALL debitar — sempre 1 lançamento na direção inversa à da referência.
8. IF a referência já foi revertida por qualquer `REFUND` ou `ROLLBACK` `PROCESSED` THEN the system SHALL marcar `REJECTED` `REFERENCE_ALREADY_REVERSED`, garantido por `UNIQUE (reference_transaction_id) WHERE kind IN ('REFUND','ROLLBACK') AND status='PROCESSED'` inclusive sob concorrência.
9. IF uma reversão debitora deixaria saldo negativo THEN the system SHALL marcar `REJECTED` `REVERSAL_INSUFFICIENT_FUNDS` (distinto de `INSUFFICIENT_FUNDS`), sem alterar saldo, persistida e auditável.
10. IF a transação referencia a si mesma THEN the system SHALL marcar `REJECTED` `INVALID_REFERENCE_KIND`.

**Independent Test**: BET → REFUND → segundo REFUND e ROLLBACK da mesma BET rejeitados; saldo volta ao inicial.

---

### P1: Referências fora de ordem ⭐ MVP

**User Story**: Como provedor, quero que uma reversão que chega antes da referência seja aplicada quando a referência chegar.

**Why P1**: Cenário de teste obrigatório (13.7).

**Acceptance Criteria**:

1. IF a referência não existe ou está em estado não-terminal THEN the system SHALL persistir a dependente como `PENDING_REFERENCE` com `attempts = 0` e `nextAttemptAt`, enfileirar `WagerTransactionPendingReference` e responder 202.
2. WHILE uma transação está `PENDING_REFERENCE` the system SHALL reprocessá-la por worker agendado com backoff exponencial (base 1 s, fator 2, teto 5 min).
3. WHEN o worker encontra a referência `PROCESSED` THEN the system SHALL aplicar as mesmas regras da submissão síncrona (mesmo use case de aplicação) e publicar os eventos resultantes.
4. IF o limite de 10 tentativas se esgota THEN the system SHALL marcar `REJECTED` `REFERENCE_NOT_FOUND` e enfileirar `WagerTransactionRejected`.
5. The system SHALL permitir múltiplas instâncias do worker sem que duas processem a mesma pendência simultaneamente (claim com `FOR UPDATE SKIP LOCKED` ou equivalente).
6. IF o worker sofre erro permanente não-negocial THEN the system SHALL marcar `FAILED` `PROCESSING_FAILED`, logar erro e incrementar métrica.

**Independent Test**: enviar ROLLBACK, receber 202; enviar BET; após o worker, ROLLBACK `PROCESSED` e saldo inicial restaurado.

---

### P1: Idempotência persistente ⭐ MVP

**User Story**: Como provedor, quero reenviar qualquer requisição com segurança para que retries nunca dupliquem efeito.

**Why P1**: 15 pontos e falha eliminatória.

**Acceptance Criteria**:

1. IF o header `Idempotency-Key` está ausente ou vazio THEN the system SHALL responder 400 `IDEMPOTENCY_KEY_REQUIRED`.
2. The system SHALL garantir unicidade por `UNIQUE (provider_id, idempotency_key)` e `UNIQUE (provider_id, external_transaction_id)` no banco, sem cache em memória como garantia.
3. WHEN chega requisição com `(providerId, idempotencyKey)` existente e `payloadHash` igual THEN the system SHALL responder o mesmo status HTTP e corpo do resultado persistido (incluindo o `balance` observado naquele momento) com `idempotentReplay: true`, sem novo efeito.
4. IF a key existe com `payloadHash` diferente THEN the system SHALL responder 409 `IDEMPOTENCY_KEY_REUSED` sem efeito.
5. IF `(providerId, externalTransactionId)` existe com outra idempotency key THEN the system SHALL responder 409 `EXTERNAL_ID_CONFLICT` sem efeito.
6. WHEN a mesma requisição é enviada 50 vezes em paralelo THEN the system SHALL produzir exatamente 1 transação e no máximo 1 lançamento, e todas as respostas SHALL ter o mesmo `transactionId` (1 com `idempotentReplay:false`, 49 com `true`).
7. The system SHALL calcular `payloadHash` como SHA-256 hex do JSON canônico definido nas Assumptions, igual para HTTP e SQS.
8. The system SHALL contar duplicatas detectadas em métrica (`idempotent_replays_total`, `idempotency_conflicts_total`).

**Independent Test**: mesmo POST 2× → mesma resposta + `idempotentReplay:true`; mudar `amount` → 409.

---

### P1: Concorrência e múltiplas instâncias ⭐ MVP

**User Story**: Como operador, quero rodar 3+ instâncias para que a escala não comprometa a correção.

**Why P1**: 20 pontos e falha eliminatória.

**Acceptance Criteria**:

1. WHEN duas `BET` de 80.00 BRL são processadas simultaneamente numa wallet com 100.00 BRL THEN the system SHALL resultar em exatamente 1 `PROCESSED`, 1 `REJECTED` `INSUFFICIENT_FUNDS`, saldo 20.00 BRL e exatamente 1 lançamento `DEBIT`.
2. The system SHALL serializar mudanças de saldo por `walletId`, sem lock global compartilhado entre wallets.
3. WHEN wallets distintas recebem operações em paralelo THEN the system SHALL processá-las sem serialização mútua e com saldo final correto em cada uma.
4. WHEN 3+ processos da aplicação processam operações da mesma wallet THEN the system SHALL manter saldo == ledger e nenhum débito/crédito duplicado.
5. IF ocorre conflito de concorrência (estouro de `lock_timeout`, serialization failure, `UPDATE … WHERE version = :expected` afetando 0 linhas) THEN the system SHALL repetir a operação com limite e backoff, e contar em `lock_conflicts_total`.
6. WHEN uma mudança de saldo é aplicada THEN the system SHALL adquirir `SELECT … FOR UPDATE` na wallet com `lock_timeout` curto e gravar com `UPDATE … WHERE version = :expected`.
7. IF o limite de retries de concorrência se esgota THEN the system SHALL responder 503 `CONCURRENCY_CONFLICT` com `Retry-After`, sem efeito parcial.
8. The system SHALL garantir no schema que não existem dois lançamentos com o mesmo `(wallet_id, wallet_version)`.

**Independent Test**: testes de concorrência 13.1–13.4 com paralelismo real e reconciliação ao final.

---

### P1: Ledger imutável e auditável ⭐ MVP

**User Story**: Como auditor, quero um ledger imutável que explique cada centavo do saldo.

**Why P1**: Falha eliminatória (ausência de ledger auditável).

**Acceptance Criteria**:

1. The system SHALL criar exatamente 1 lançamento para cada mudança de saldo, na mesma transação SQL da mudança, e nenhum lançamento sem mudança de saldo.
2. The system SHALL validar `balanceBefore ± money == balanceAfter` na factory `WalletLedgerEntry.create` e via `CHECK` no banco.
3. IF há tentativa de `UPDATE` ou `DELETE` em `wallet_ledger_entries` THEN o banco SHALL rejeitar via trigger.
4. The system SHALL garantir no banco `amount > 0`, `balance_after >= 0`, `UNIQUE (transaction_id)` e FK para wallet e transação.
5. WHEN `GET /wallets/:walletId/ledger?cursor=&limit=` é chamado THEN the system SHALL retornar lançamentos por `wallet_version` decrescente com `nextCursor` opaco, estável sob inserções concorrentes.
6. IF `cursor` é inválido ou `limit` fora de 1..200 THEN the system SHALL responder 400 `VALIDATION_ERROR`.
7. The system SHALL não expor métodos de mutação em `WalletLedgerEntry` (todos os campos `readonly`).

**Independent Test**: tentar `UPDATE` direto via SQL e ver erro; paginar ledger de 120 lançamentos em 3 páginas sem repetição.

---

### P1: Consumo SQS com inbox ⭐ MVP

**User Story**: Como provedor assíncrono, quero enviar operações por `wager-transactions.fifo` com as mesmas garantias da API.

**Why P1**: 15 pontos (mensageria e falhas).

**Acceptance Criteria**:

1. WHEN mensagem `WagerTransactionRequested` válida é recebida THEN the system SHALL executar o mesmo use case da entrada HTTP.
2. The system SHALL registrar `(consumerName, messageId)` na inbox na mesma transação SQL da operação financeira e do outbox.
3. WHEN `messageId` já processado é recebido THEN the system SHALL fazer ack sem reprocessar e incrementar `inbox_duplicates_total`.
4. The system SHALL fazer ack somente após o commit da transação SQL.
5. WHEN o resultado é rejeição de negócio THEN the system SHALL persistir `REJECTED` e fazer ack.
6. IF ocorre erro transitório (Postgres indisponível, conflito de lock esgotado) THEN the system SHALL não fazer ack e alterar a visibilidade com backoff exponencial.
7. IF a mensagem é recebida mais que `maxReceiveCount = 5` vezes THEN a fila SHALL movê-la para `wager-transactions-dlq.fifo` (redrive policy) e o sistema SHALL contar em `dlq_messages_total`.
8. IF a mensagem é malformada ou permanentemente inválida THEN the system SHALL enviá-la à DLQ e fazer ack.
9. WHEN o worker morre depois do commit e antes do ack THEN a redelivery SHALL ser detectada pela inbox/idempotência sem duplicar efeito.
10. WHEN o processo recebe `SIGTERM` THEN the system SHALL parar de buscar mensagens, concluir as em andamento dentro do grace period, e devolver visibilidade (`ChangeMessageVisibility 0`) das não concluídas.
11. The system SHALL aplicar ao `providerId` da mensagem as mesmas validações de domínio da API (fila é canal interno confiável apenas quanto à autenticação).
12. IF chega um `messageId` já registrado na inbox com `payloadHash` diferente THEN the system SHALL enviar a mensagem à DLQ, fazer ack, não processar e incrementar `inbox_payload_conflict_total`.
13. IF a mensagem resulta em `IDEMPOTENCY_KEY_REUSED` ou `EXTERNAL_ID_CONFLICT` THEN the system SHALL enviá-la à DLQ, fazer ack e incrementar `idempotency_conflicts_total`, sem gravar nada.

**Independent Test**: publicar a mesma mensagem 2× e com o worker morto antes do ack; uma única transação e um único lançamento.

---

### P1: Transactional outbox ⭐ MVP

**User Story**: Como consumidor de eventos, quero receber todo evento confirmado, mesmo após crashes, e nunca antes do commit.

**Why P1**: Falha eliminatória (publicação antes do commit).

**Acceptance Criteria**:

1. The system SHALL gravar eventos de integração na tabela `outbox_messages` na mesma transação SQL da mudança que os origina.
2. The system SHALL publicar eventos somente a partir da outbox, após o commit, por worker dedicado em `wallet-events.fifo` com `MessageGroupId = walletId` e `MessageDeduplicationId = eventId`.
3. WHEN qualquer transação é `PROCESSED` (inclusive `LOSS` e `OPENING`) THEN the system SHALL enfileirar `WagerTransactionProcessed`.
4. WHEN o saldo muda THEN the system SHALL enfileirar `WalletBalanceChanged` com `walletVersion`, `direction`, `money`, `balanceBefore`, `balanceAfter` como `MoneyProps`; e SHALL não enfileirá-lo quando o saldo não muda.
5. WHEN transação é `REJECTED` por regra de negócio THEN the system SHALL enfileirar `WagerTransactionRejected` com `failureCode`.
6. WHEN transação entra em `PENDING_REFERENCE` THEN the system SHALL enfileirar `WagerTransactionPendingReference`.
7. The system SHALL modelar cada evento como subclasse de `IntegrationEvent<T>` com `eventType` e `version` no tipo, e `toJSON()` no envelope definido (seção 11).
8. WHEN dois ou mais publishers rodam sobre a mesma outbox THEN the system SHALL publicar cada evento sem que dois publishers peguem a mesma linha ao mesmo tempo (claim com lease: `FOR UPDATE SKIP LOCKED` + `locked_until`, commit do claim antes da chamada ao SQS).
9. WHEN o processo morre após o commit e antes de publicar (inclusive após fazer o claim) THEN outra instância SHALL publicar o evento assim que `locked_until` expirar.
10. IF a publicação falha THEN the system SHALL incrementar `attempts`, agendar `nextAttemptAt` com backoff, nunca descartar o evento e refletir pendentes com muitas tentativas em `outbox_messages_high_attempts`.
11. The system SHALL tolerar publicação duplicada e fora de ordem: cada evento carrega `eventId` estável para dedup e `walletVersion` para ordenação pelo consumidor; a ordem entre eventos de uma wallet é best-effort.
12. The system SHALL não manter transação SQL aberta durante a chamada de rede ao SQS.

**Independent Test**: commit com publisher desligado → evento pendente; subir publisher em outra instância → publicado em `wallet-events.fifo`.

---

### P1: Reconciliação ⭐ MVP

**User Story**: Como operador, quero verificar que o saldo materializado bate com o ledger.

**Why P1**: Prova a invariante final de todos os testes; implementada logo após concorrência.

**Acceptance Criteria**:

1. WHEN `POST /wallets/:walletId/reconciliation` é chamado THEN the system SHALL responder 200 com `walletId`, `storedBalance`, `calculatedBalance` (Σ CREDIT − Σ DEBIT do ledger), `difference`, `consistent`, `checkedEntries`.
2. IF `storedBalance != calculatedBalance` THEN the system SHALL retornar `consistent: false`, logar `error` e incrementar `reconciliation_mismatches_total`, sem corrigir o saldo.
3. IF a wallet não existe THEN the system SHALL responder 404 `WALLET_NOT_FOUND`.
4. The system SHALL usar a reconciliação como asserção final de todos os testes de integração e concorrência.

**Independent Test**: reconciliar após operações → `consistent:true`; alterar saldo por SQL direto (bypass) → `consistent:false` e métrica incrementada.

---

### P1: Contrato de erros HTTP ⭐ MVP

**User Story**: Como provedor, quero status HTTP que digam se devo reenviar, corrigir ou desistir.

**Why P1**: Exigido explicitamente na seção 9.

**Acceptance Criteria**:

1. The system SHALL usar o mesmo mapeamento em todos os endpoints: 201 processado/criado; 202 aceito pendente; 400 payload inválido; 404 recurso inexistente em consultas; 409 conflito (idempotência, external id, wallet duplicada); 422 rejeição de regra de negócio; 503 falha transitória (com `Retry-After`); 500 erro inesperado.
2. The system SHALL retornar corpo de erro `{ "failureCode": string, "message": string, "details"?: [...] }`, com `failureCode` da taxonomia documentada.
3. IF PostgreSQL ou SQS está indisponível durante uma requisição THEN the system SHALL responder 503 `DEPENDENCY_UNAVAILABLE` com `Retry-After`.

**Independent Test**: um teste e2e por classe de status.

---

### P1: Observabilidade e health ⭐ MVP

**User Story**: Como operador, quero logs, métricas e health checks para diagnosticar o sistema.

**Why P1**: 5 pontos; health/ready necessário para compose com 3 instâncias.

**Acceptance Criteria**:

1. The system SHALL emitir logs JSON contendo, quando aplicável, `correlationId`, `messageId`, `transactionId`, `walletId`, `providerId`.
2. The system SHALL não logar `amount`, saldos, `playerId` nem payloads completos.
3. WHEN requisição HTTP chega com `X-Correlation-Id` THEN the system SHALL propagá-lo para logs e eventos; caso ausente SHALL gerar um UUID. Mensagens SQS usam `messageId` como `correlationId` quando ausente.
4. The system SHALL expor em `GET /metrics` (Prometheus): `wager_transactions_total{kind,status}`, `idempotent_replays_total`, `idempotency_conflicts_total`, `inbox_duplicates_total`, `retries_total{reason}`, `dlq_messages_total`, `lock_conflicts_total`, `outbox_lag_seconds`, `outbox_pending`, `outbox_messages_high_attempts` (as três métricas da outbox vêm do banco: agregar com `max()` entre réplicas, nunca `sum()`), `inbox_payload_conflict_total`, `processing_duration_seconds` (histograma), `reconciliation_mismatches_total`.
5. WHEN `GET /health/live` é chamado THEN the system SHALL responder 200 enquanto o processo estiver vivo, sem tocar dependências.
6. WHEN `GET /health/ready` é chamado THEN the system SHALL responder 200 se PostgreSQL (`SELECT 1`) e SQS (`GetQueueUrl`) respondem, e 503 com o detalhe da dependência falha caso contrário.
7. The system SHALL deixar `/health/*` e `/metrics` sem autenticação.

**Independent Test**: derrubar o container do LocalStack e ver `/health/ready` 503 enquanto `/health/live` segue 200.

---

### P1: Ponto de extensão de autenticação ⭐ MVP

**User Story**: Como avaliador, quero ver onde a autenticação entraria sem que ela consuma o timebox.

**Why P1**: Exigência mínima da seção 2 ao optar por não implementar.

**Acceptance Criteria**:

1. The system SHALL aplicar um `AuthGuard` no-op (permite tudo) aos endpoints de wallets e wagering que delega a um `ProviderIdentityPort`.
2. The system SHALL invocar `ProviderIdentityPort` com o `providerId` do body em `POST /wagering/transactions`, de modo que uma implementação real possa responder 403 `PROVIDER_IDENTITY_MISMATCH` quando o `providerId` do token difere.
3. The system SHALL documentar no `ARCHITECTURE.md` o desenho com Keycloak: OAuth2 client credentials por provedor, JWT validado via JWKS, claim de provider comparada ao body → 403 se diferente; health aberto; fila como canal interno.

**Independent Test**: teste unitário do guard com um `ProviderIdentityPort` fake que nega → 403.

---

### P1: Schema e migrations ⭐ MVP

**User Story**: Como avaliador, quero que as garantias estejam no schema.

**Why P1**: Restrição inviolável 5.9.

**Acceptance Criteria**:

1. The system SHALL versionar migrations MikroORM reversíveis (`up` e `down`), testadas em ciclo up → down → up em banco real.
2. The system SHALL declarar no schema: `UNIQUE (player_id, currency)` e `UNIQUE (id, currency, player_id)` em wallets; chave estrangeira composta `(wallet_id, currency, player_id) → wallets (id, currency, player_id)` nas transações e `(wallet_id, currency) → wallets (id, currency)` no ledger; `CHECK (balance >= 0)`; `UNIQUE (provider_id, idempotency_key)`; `UNIQUE (provider_id, external_transaction_id)`; índice parcial de reversão única; `CHECK` de `kind`/`status` válidos; `CHECK` de referência obrigatória para `REFUND`/`ROLLBACK`; ledger com `CHECK` aritmético, `UNIQUE (transaction_id)`, `UNIQUE (wallet_id, wallet_version)` e trigger anti-UPDATE/DELETE; inbox com PK `(consumer_name, message_id)`; outbox com `attempts`, `next_attempt_at`, `locked_until`, `published_at`.
3. The system SHALL mapear entidades via `EntitySchema`/`defineEntity`, sem decorators no domínio, com `Money` reidratado a partir de `numeric` como string (nunca `number`).
4. The system SHALL usar a factory `rehydrate` para reconstruir entidades do banco, sem revalidar transições.

**Independent Test**: suíte de integração que tenta violar cada constraint via SQL direto e espera o erro do Postgres.

---

### P1: Testes obrigatórios ⭐ MVP

**User Story**: Como avaliador, quero testes reais que provem as garantias.

**Why P1**: 10 pontos; mocks completos de Postgres/SQS são eliminatórios.

**Acceptance Criteria**:

1. The system SHALL ter testes unitários (`bun test`) para `Money`, invariantes de `Wallet`, regras de cada `kind`, conflito de moeda e idempotency key com payload divergente.
2. The system SHALL ter testes de integração contra PostgreSQL e LocalStack reais em containers para: migrations e constraints; atomicidade wallet+ledger+inbox+outbox; inbox e redelivery; publishers concorrentes; retry e DLQ; recuperação após reinício.
3. The system SHALL ter testes de concorrência com paralelismo real cobrindo os 8 cenários da seção 13 (incluindo ≥ 3 processos separados).
4. WHEN qualquer teste de integração ou concorrência termina THEN o teste SHALL afirmar `wallet.balance == saldo reconstruído pelo ledger` para toda wallet tocada.
5. The system SHALL expor `bun run test:unit`, `bun run test:integration`, `bun run test:concurrency` e `bun run test` (executa os três), com integração e concorrência no banco `wagering_test`.

**Independent Test**: `bun run test:*` com `docker compose up` verde.

---

### P2: Ambiente e documentação

**User Story**: Como avaliador, quero subir tudo com um comando e entender as decisões.

**Why P2**: 5 pontos; essencial para a entrega, mas depende do resto pronto.

**Acceptance Criteria**:

1. WHEN `docker compose up` é executado THEN the system SHALL subir PostgreSQL, LocalStack (filas `wager-transactions.fifo`, `wager-transactions-dlq.fifo` com redrive, `wallet-events.fifo`) e a aplicação com migrations aplicadas.
2. WHERE o perfil de escala é usado (`docker compose up --scale app=3`) the system SHALL rodar 3 instâncias sem conflito de porta.
3. The system SHALL ter `README.md` com pré-requisitos, setup, comandos de execução e de teste.
4. The system SHALL ter `ARCHITECTURE.md` com: escolha do ORM e mapeamento do `Money`, estratégia transacional e de concorrência, idempotência e algoritmo de hash, mapeamento HTTP, taxonomia de `failureCode`, transições de estado, interpretação da regra 7.4, política de `PENDING_REFERENCE`, outbox/inbox, desenho de auth com Keycloak, trade-offs e limitações; toda nova decisão de arquitetura entra no `ARCHITECTURE.md` com motivo e trade-off.
5. The system SHALL manter no `.gitignore` `instrucoes-teste.md`, `CLAUDE.md`, `.claude/`, `.env` e `.env.*` (exceto `!.env.example`), e SHALL versionar `.specs/` (não ignorada).

**Independent Test**: clone limpo + README → testes verdes.

---

## Edge Cases

- IF duas reversões diferentes (um `REFUND` e um `ROLLBACK`) da mesma `BET` chegam simultaneamente THEN the system SHALL processar exatamente uma e rejeitar a outra com `REFERENCE_ALREADY_REVERSED`.
- IF duas requisições com a mesma `Idempotency-Key` e payloads diferentes chegam simultaneamente THEN the system SHALL aplicar no máximo uma e responder 409 à outra.
- IF uma requisição HTTP e uma mensagem SQS representam a mesma operação (mesma key, mesmo hash) THEN the system SHALL aplicar uma única vez e tratar a segunda como replay.
- IF um `ROLLBACK` de `WIN` chega quando o saldo já foi gasto THEN the system SHALL rejeitar com `REVERSAL_INSUFFICIENT_FUNDS`.
- IF um `ROLLBACK` de um `REFUND` é aplicado THEN a `BET` original SHALL não poder ser reembolsada de novo (já consta reversão `PROCESSED` sobre ela).
- WHEN o saldo chega exatamente a `0.00` por uma `BET` THEN the system SHALL aceitar (saldo não-negativo inclui zero).
- IF PostgreSQL cai no meio de uma transação THEN the system SHALL não deixar efeito parcial (rollback SQL) e a requisição SHALL receber 503.
- IF SQS está indisponível THEN a API HTTP SHALL continuar processando (outbox acumula) e `outbox_lag_seconds` SHALL crescer.
- IF o `messageId` da mensagem e o `Idempotency-Key` divergem do default `{providerId}:{externalTransactionId}` THEN the system SHALL aceitar (o default é só recomendação).

---

## Failure Code Taxonomy (proposta)

| Classe | HTTP | Ação do provedor | Códigos |
| --- | --- | --- | --- |
| Payload inválido | 400 | Corrigir payload | `VALIDATION_ERROR`, `IDEMPOTENCY_KEY_REQUIRED` |
| Não encontrado (consulta) | 404 | — | `WALLET_NOT_FOUND`, `TRANSACTION_NOT_FOUND` |
| Conflito | 409 | Não reenviar igual; investigar | `IDEMPOTENCY_KEY_REUSED`, `EXTERNAL_ID_CONFLICT`, `WALLET_ALREADY_EXISTS` |
| Rejeição de negócio (terminal) | 422 | Desistir ou corrigir e enviar como nova operação | `INSUFFICIENT_FUNDS`, `REVERSAL_INSUFFICIENT_FUNDS`, `CURRENCY_MISMATCH` (não persistido), `WALLET_NOT_FOUND` (não persistido), `WALLET_PLAYER_MISMATCH` (não persistido), `REFERENCE_NOT_FOUND`, `REFERENCE_MISMATCH`, `INVALID_REFERENCE_KIND`, `REFERENCE_NOT_PROCESSED`, `REFERENCE_ALREADY_REVERSED`, `AMOUNT_MISMATCH` |
| Aceito pendente | 202 | Aguardar evento / consultar | (status `PENDING_REFERENCE`) |
| Transitório | 503 | Reenviar igual após `Retry-After` | `DEPENDENCY_UNAVAILABLE`, `CONCURRENCY_CONFLICT` |
| Auth (extensão) | 403 | Corrigir credencial | `PROVIDER_IDENTITY_MISMATCH` |
| Inesperado | 500 | Reenviar igual (idempotente) | `INTERNAL_ERROR` |
| Falha permanente interna (só via worker) | — | Suporte | `PROCESSING_FAILED` (status `FAILED`) |

---

## Requirement Traceability

| Requirement ID | Story | Phase | Status |
| --- | --- | --- | --- |
| MON-01 | P1: Money exato | Design | Pending |
| MON-02 | P1: Money exato | Design | Pending |
| MON-03 | P1: Money exato | Design | Pending |
| MON-04 | P1: Money exato | Design | Pending |
| MON-05 | P1: Money exato | Design | Pending |
| MON-06 | P1: Money exato | Design | Pending |
| MON-07 | P1: Money exato | Design | Pending |
| MON-08 | P1: Money exato | Design | Pending |
| MON-09 | P1: Money exato | Design | Pending |
| WAL-01 | P1: Wallet e abertura | Design | Pending |
| WAL-02 | P1: Wallet e abertura | Design | Pending |
| WAL-03 | P1: Wallet e abertura | Design | Pending |
| WAL-04 | P1: Wallet e abertura | Design | Pending |
| WAL-05 | P1: Wallet e abertura | Design | Pending |
| WAL-06 | P1: Wallet e abertura | Design | Pending |
| WAL-07 | P1: Wallet e abertura | Design | Pending |
| WAL-08 | P1: Wallet e abertura | Design | Pending |
| WAL-09 | P1: Wallet e abertura | Design | Pending |
| TXN-01 | P1: Submissão de transações | Design | Pending |
| TXN-02 | P1: Submissão de transações | Design | Pending |
| TXN-03 | P1: Submissão de transações | Design | Pending |
| TXN-04 | P1: Submissão de transações | Design | Pending |
| TXN-05 | P1: Submissão de transações | Design | Pending |
| TXN-06 | P1: Submissão de transações | Design | Pending |
| TXN-07 | P1: Submissão de transações | Design | Pending |
| TXN-08 | P1: Submissão de transações | Design | Pending |
| TXN-09 | P1: Submissão de transações | Design | Pending |
| TXN-10 | P1: Submissão de transações | Design | Pending |
| TXN-11 | P1: Submissão de transações | Design | Pending |
| TXN-12 | P1: Submissão de transações | Design | Pending |
| TXN-13 | P1: Submissão de transações | Design | Pending |
| TXN-14 | P1: Submissão de transações | Design | Pending |
| REV-01 | P1: Reversões e referências | Design | Pending |
| REV-02 | P1: Reversões e referências | Design | Pending |
| REV-03 | P1: Reversões e referências | Design | Pending |
| REV-04 | P1: Reversões e referências | Design | Pending |
| REV-05 | P1: Reversões e referências | Design | Pending |
| REV-06 | P1: Reversões e referências | Design | Pending |
| REV-07 | P1: Reversões e referências | Design | Pending |
| REV-08 | P1: Reversões e referências | Design | Pending |
| REV-09 | P1: Reversões e referências | Design | Pending |
| REV-10 | P1: Reversões e referências | Design | Pending |
| PREF-01 | P1: Referências fora de ordem | Design | Pending |
| PREF-02 | P1: Referências fora de ordem | Design | Pending |
| PREF-03 | P1: Referências fora de ordem | Design | Pending |
| PREF-04 | P1: Referências fora de ordem | Design | Pending |
| PREF-05 | P1: Referências fora de ordem | Design | Pending |
| PREF-06 | P1: Referências fora de ordem | Design | Pending |
| IDEM-01 | P1: Idempotência persistente | Design | Pending |
| IDEM-02 | P1: Idempotência persistente | Design | Pending |
| IDEM-03 | P1: Idempotência persistente | Design | Pending |
| IDEM-04 | P1: Idempotência persistente | Design | Pending |
| IDEM-05 | P1: Idempotência persistente | Design | Pending |
| IDEM-06 | P1: Idempotência persistente | Design | Pending |
| IDEM-07 | P1: Idempotência persistente | Design | Pending |
| IDEM-08 | P1: Idempotência persistente | Design | Pending |
| CONC-01 | P1: Concorrência | Design | Pending |
| CONC-02 | P1: Concorrência | Design | Pending |
| CONC-03 | P1: Concorrência | Design | Pending |
| CONC-04 | P1: Concorrência | Design | Pending |
| CONC-05 | P1: Concorrência | Design | Pending |
| CONC-06 | P1: Concorrência | Design | Pending |
| CONC-07 | P1: Concorrência | Design | Pending |
| CONC-08 | P1: Concorrência | Design | Pending |
| LEDG-01 | P1: Ledger imutável | Design | Pending |
| LEDG-02 | P1: Ledger imutável | Design | Pending |
| LEDG-03 | P1: Ledger imutável | Design | Pending |
| LEDG-04 | P1: Ledger imutável | Design | Pending |
| LEDG-05 | P1: Ledger imutável | Design | Pending |
| LEDG-06 | P1: Ledger imutável | Design | Pending |
| LEDG-07 | P1: Ledger imutável | Design | Pending |
| SQS-01 | P1: Consumo SQS com inbox | Design | Pending |
| SQS-02 | P1: Consumo SQS com inbox | Design | Pending |
| SQS-03 | P1: Consumo SQS com inbox | Design | Pending |
| SQS-04 | P1: Consumo SQS com inbox | Design | Pending |
| SQS-05 | P1: Consumo SQS com inbox | Design | Pending |
| SQS-06 | P1: Consumo SQS com inbox | Design | Pending |
| SQS-07 | P1: Consumo SQS com inbox | Design | Pending |
| SQS-08 | P1: Consumo SQS com inbox | Design | Pending |
| SQS-09 | P1: Consumo SQS com inbox | Design | Pending |
| SQS-10 | P1: Consumo SQS com inbox | Design | Pending |
| SQS-11 | P1: Consumo SQS com inbox | Design | Pending |
| SQS-12 | P1: Consumo SQS com inbox | Design | Pending |
| SQS-13 | P1: Consumo SQS com inbox | Design | Pending |
| OUT-01 | P1: Transactional outbox | Design | Pending |
| OUT-02 | P1: Transactional outbox | Design | Pending |
| OUT-03 | P1: Transactional outbox | Design | Pending |
| OUT-04 | P1: Transactional outbox | Design | Pending |
| OUT-05 | P1: Transactional outbox | Design | Pending |
| OUT-06 | P1: Transactional outbox | Design | Pending |
| OUT-07 | P1: Transactional outbox | Design | Pending |
| OUT-08 | P1: Transactional outbox | Design | Pending |
| OUT-09 | P1: Transactional outbox | Design | Pending |
| OUT-10 | P1: Transactional outbox | Design | Pending |
| OUT-11 | P1: Transactional outbox | Design | Pending |
| OUT-12 | P1: Transactional outbox | Design | Pending |
| REC-01 | P1: Reconciliação | Design | Pending |
| REC-02 | P1: Reconciliação | Design | Pending |
| REC-03 | P1: Reconciliação | Design | Pending |
| REC-04 | P1: Reconciliação | Design | Pending |
| API-01 | P1: Contrato de erros HTTP | Design | Pending |
| API-02 | P1: Contrato de erros HTTP | Design | Pending |
| API-03 | P1: Contrato de erros HTTP | Design | Pending |
| OBS-01 | P1: Observabilidade e health | Design | Pending |
| OBS-02 | P1: Observabilidade e health | Design | Pending |
| OBS-03 | P1: Observabilidade e health | Design | Pending |
| OBS-04 | P1: Observabilidade e health | Design | Pending |
| OBS-05 | P1: Observabilidade e health | Design | Pending |
| OBS-06 | P1: Observabilidade e health | Design | Pending |
| OBS-07 | P1: Observabilidade e health | Design | Pending |
| AUTH-01 | P1: Extensão de autenticação | Design | Pending |
| AUTH-02 | P1: Extensão de autenticação | Design | Pending |
| AUTH-03 | P1: Extensão de autenticação | Design | Pending |
| DB-01 | P1: Schema e migrations | Design | Pending |
| DB-02 | P1: Schema e migrations | Design | Pending |
| DB-03 | P1: Schema e migrations | Design | Pending |
| DB-04 | P1: Schema e migrations | Design | Pending |
| TEST-01 | P1: Testes obrigatórios | Design | Pending |
| TEST-02 | P1: Testes obrigatórios | Design | Pending |
| TEST-03 | P1: Testes obrigatórios | Design | Pending |
| TEST-04 | P1: Testes obrigatórios | Design | Pending |
| TEST-05 | P1: Testes obrigatórios | Design | Pending |
| DOC-01 | P2: Ambiente e documentação | Design | Pending |
| DOC-02 | P2: Ambiente e documentação | Design | Pending |
| DOC-03 | P2: Ambiente e documentação | Design | Pending |
| DOC-04 | P2: Ambiente e documentação | Design | Pending |
| DOC-05 | P2: Ambiente e documentação | Design | Pending |

IDs individuais = prefixo + número do critério na story (ex.: `REV-08` = critério 8 de Reversões).

**Coverage:** 127 critérios, 0 mapeados para tasks (fase Tasks ainda não executada).

---

## Success Criteria

- [ ] Cenário 100.00 / 2×80.00 passa 100% em 20 execuções seguidas (sem flakiness).
- [ ] 50 réplicas paralelas → 1 transação, 1 lançamento, 50 respostas com o mesmo `transactionId`.
- [ ] Reconciliação `consistent: true` em todas as wallets ao fim de todas as suítes.
- [ ] Cada constraint do schema tem um teste que a viola via SQL e falha no Postgres.
- [ ] Nenhuma ocorrência de `number` em tipos de dinheiro (verificável por grep em `amount`/`balance`).
