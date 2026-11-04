# Distributed Wagering Processor

Processador de transações de apostas (BET, WIN, LOSS, REFUND, ROLLBACK) sobre carteiras, feito para rodar em várias réplicas ao mesmo tempo. Recebe operações por HTTP e por uma fila SQS, mantém o saldo exato e o ledger imutável no PostgreSQL e publica eventos de integração por uma outbox transacional.

As decisões, os trade-offs e as limitações estão no [ARCHITECTURE.md](ARCHITECTURE.md). Este arquivo cobre só como subir, usar e testar.

## Início rápido

No Windows, rode tudo dentro do WSL2, com o projeto no sistema de arquivos do Linux (por exemplo `~/dev`), não em `/mnt/c`.

```bash
git clone https://github.com/kafreitas07/jungle-wagering.git
cd jungle-wagering
cp .env.example .env
bun install
docker compose up -d postgres localstack
bun run migrate
bun run start   # deixe este terminal aberto
```

Em outro terminal, na mesma pasta:

```bash
bun run demo health
bun run demo wallet 100
bun run test
```

`bun run demo help` lista todos os comandos da demo.

Para rodar a aplicação em 3 réplicas, veja a seção [Subir tudo com Docker](#subir-tudo-com-docker-aplicação-em-3-réplicas).

## Pré-requisitos

- [Bun](https://bun.sh) 1.x (testado com 1.4.4)
- Docker com Docker Compose v2. **No Windows e no macOS, o Docker Desktop precisa estar aberto** antes de qualquer comando `docker compose`; com ele fechado, os comandos falham com erro de conexão ao daemon.
- Portas livres no host: `5440` (PostgreSQL), `4566` (LocalStack), `3100` (aplicação, ou o balanceador no modo Docker) e a faixa `3101-3110` (réplicas da aplicação no Docker). Se alguma estiver ocupada, use `POSTGRES_HOST_PORT`, `LOCALSTACK_HOST_PORT` e `APP_HOST_PORTS` para trocar. Os testes e o `.env.example` assumem os padrões.

## Subir tudo com Docker (aplicação em 3 réplicas)

```bash
docker compose up -d --build --scale app=3
```

Isso sobe, nesta ordem: PostgreSQL, LocalStack (que cria as filas `wager-transactions.fifo`, `wager-transactions-dlq.fifo` e `wallet-events.fifo`), o serviço `migrate` (aplica as migrations e termina) e três réplicas de `app`, cada uma com API, consumidor SQS, publicador da outbox e worker de pendências.

Um balanceador (nginx, serviço `lb`) fica na porta 3100 do host e distribui as requisições entre as réplicas. Por isso os comandos da demo são os mesmos do Início rápido, sem mudar nada:

```bash
bun run demo health
bun run demo wallet 100
bun run demo bet 25
bun run demo balance
```

> **Não rode o Início rápido e o modo Docker ao mesmo tempo.** Os dois usam a porta 3100 (a aplicação local no Início rápido, o balanceador aqui). Pare um antes de subir o outro.

Cada réplica também é acessível direto, em uma porta da faixa 3101 a 3110 (até 10 réplicas; a faixa pode ser trocada com `APP_HOST_PORTS`). O `docker compose ps app` mostra qual porta cada uma pegou. Para falar com uma réplica específica, use `--replica N` na demo, que descobre a porta da réplica N sozinha:

```bash
bun run demo wallet 100 --replica 1
bun run demo bet 25 --replica 2
bun run demo balance --replica 3
```

Sem `--replica`, a demo usa `BASE_URL` (padrão `http://localhost:3100`). Também dá para apontar para uma porta à mão: `BASE_URL=http://localhost:3101 bun run demo health`.

Verificação rápida com `curl` (use `3100` ou uma porta da faixa):

```bash
curl localhost:3100/health/live
curl localhost:3100/health/ready
```

Para parar: `docker compose down`.

`docker compose down` para tudo e mantém os dados do banco; `docker compose down -v` apaga também o volume, e com ele os dados.

### Acompanhar as operações

```bash
docker compose logs -f app
```

Mostra ao vivo cada requisição, com o nome da réplica que atendeu no começo da linha (`app-1`, `app-2`, `app-3`). O `Ctrl + C` só para de mostrar o log, sem derrubar os contêineres. Uma boa forma de ver o balanceamento é deixar esse comando num terminal e usar a demo em outro: as requisições se alternam entre as réplicas. Os health checks (`/health/live`, `/health/ready`) e o `/metrics` não aparecem nesse log.



Cada instância roda os quatro papéis por padrão. Para separar papéis, use `RUN_HTTP`, `RUN_SQS_CONSUMER`, `RUN_OUTBOX_PUBLISHER` e `RUN_PENDING_WORKER`.

## Testes

Os testes de integração e de concorrência usam o PostgreSQL e o LocalStack **reais**, sem mocks, no banco `wagering_test`. Com a infraestrutura de pé (`docker compose up -d postgres localstack`):

```bash
bun run typecheck           # TypeScript estrito
bun run test:unit           # domínio, contratos, configuração (sem infraestrutura)
bun run test:integration    # casos de uso, HTTP, persistência, mensageria
bun run test:concurrency    # concorrência, vários processos, recuperação de falhas
bun run test                # os três, em sequência
```

Todo teste termina conferindo que o saldo da carteira é igual ao saldo reconstruído pelo ledger. A suíte completa leva alguns minutos, principalmente pelos testes de mensageria e de recuperação.

## Uso rápido da API

```bash
# criar uma carteira
curl -X POST localhost:PORTA/wallets -H 'content-type: application/json' \
  -d '{"playerId":"11111111-1111-4111-8111-111111111111","initialBalance":{"amount":"100.00","currency":"BRL"}}'

# apostar (Idempotency-Key é obrigatório; valores são strings com duas casas)
curl -X POST localhost:PORTA/wagering/transactions \
  -H 'content-type: application/json' -H 'Idempotency-Key: minha-chave-1' -H 'X-Correlation-Id: teste-1' \
  -d '{"providerId":"provedor-1","externalTransactionId":"ext-1","playerId":"11111111-1111-4111-8111-111111111111","walletId":"ID_DA_CARTEIRA","roundId":"r1","gameId":"g1","kind":"BET","money":{"amount":"25.00","currency":"BRL"}}'
```

| Rota | O que faz |
| --- | --- |
| `POST /wallets` · `GET /wallets/:id` · `GET /wallets/:id/ledger` | Cria, consulta e lista o ledger (paginado por cursor) |
| `POST /wallets/:id/reconciliation` | Compara o saldo guardado com o reconstruído pelo ledger; só reporta, nunca corrige |
| `POST /wagering/transactions` | Processa uma operação (201 processada, 202 aguardando referência, 422 recusa de negócio) |
| `GET /wagering/transactions/:id` · `GET /providers/:providerId/wagering/transactions/:externalId` | Consulta por id interno ou externo |
| `GET /health/live` · `GET /health/ready` | Processo vivo · PostgreSQL e SQS respondendo |
| `GET /metrics` | Métricas no formato Prometheus |

### CLI de demonstração

Para explorar a API sem montar `curl`s, há uma CLI que fala com uma aplicação já de pé (`BASE_URL`, padrão `http://localhost:3100`) e guarda a carteira e a última requisição em `.demo-state.json` (ignorado pelo git). Cada comando imprime o status HTTP e só o essencial; `--raw` mostra a resposta completa em JSON. Comece por `bun run demo wallet 100`.

| Comando | O que faz |
| --- | --- |
| `bun run demo health` | Consulta `/health/live` e `/health/ready` |
| `bun run demo wallet <valor>` | Cria jogador e carteira novos e guarda no estado |
| `bun run demo bet <valor> [extId]` | Aposta; gera `ext-1`, `ext-2`… e a `Idempotency-Key` se não forem passados |
| `bun run demo win <valor> [refExtId]` · `loss [refExtId]` | Prêmio ou perda, opcionalmente ligados a uma aposta |
| `bun run demo replay` | Reenvia exatamente a última requisição (resposta com `idempotentReplay: true`) |
| `bun run demo conflict <valor>` | Reenvia a última com a mesma chave e outro valor (409) |
| `bun run demo refund <refExtId> [valor]` · `rollback <refExtId> [valor]` | Reversão; o valor padrão é o da transação referenciada. Com uma referência que ainda não existe, fica `PENDING_REFERENCE` |
| `bun run demo tx <extId>` | Consulta a transação pelo id externo |
| `bun run demo balance` · `ledger` · `reconcile` | Saldo, ledger e reconciliação da carteira |
| `bun run demo reset` · `help` | Apaga o estado · lista os comandos com exemplos |

Pela fila, a mesma operação entra como mensagem `WagerTransactionRequested` em `wager-transactions.fifo` (`MessageGroupId` igual ao id da carteira). Mensagem malformada ou em conflito vai direto para a DLQ; erro temporário volta para a fila com espera crescente e vai para a DLQ depois de 5 recebimentos. Os eventos de saída saem em `wallet-events.fifo`.

## Operação

- **`/metrics` e `/health/*` não têm autenticação**, de propósito, porque o Prometheus e o orquestrador não têm credenciais. Exponha essas rotas só em rede interna, nunca na internet. As três métricas da outbox (`outbox_pending`, `outbox_lag_seconds`, `outbox_messages_high_attempts`) vêm do banco e são iguais em todas as réplicas: agregue com `max()`, não com `sum()`.
- **Logs** saem em JSON no stdout, com `correlationId` em todas as linhas de uma requisição ou mensagem. O nível vem de `LOG_LEVEL`. Valores, saldos, `playerId` e payloads nunca são logados.
- **Autenticação não está implementada.** Há um `AuthGuard` que aceita todos os provedores; não use assim em produção. O desenho previsto está na seção 7 do [ARCHITECTURE.md](ARCHITECTURE.md).
- **Encerramento:** com `SIGTERM` a instância para de buscar mensagens, termina a que está em andamento (até `SQS_SHUTDOWN_GRACE_MS`) e devolve o resto à fila.

## Uso de IA

Este projeto foi desenvolvido com o apoio do **Claude Code** (Anthropic), usado como ferramenta de execução. A direção do projeto, as decisões e a revisão foram minhas.

**Por que usei IA:** o prazo era de três dias para um escopo grande. Preferi concentrar o meu tempo no que o desafio mais avalia, que é entender os problemas de um sistema financeiro distribuído e escolher bem como resolvê-los, e usar a IA para acelerar a escrita do código.

**Como trabalhei:** segui o método **TLC spec-driven**, em que nada é implementado sem antes ser especificado e aprovado. O ciclo foi sempre o mesmo:

1. **Eu defini o que fazer:** li e interpretei o enunciado, e tomei as decisões de arquitetura e de regra de negócio. Por exemplo: a reversão única, para evitar crédito duplicado; o replay devolvendo o estado atual da transação; a chave estrangeira composta entre transação e carteira; o lock pessimista por carteira; e a decisão de não implementar a autenticação, documentando o desenho.
2. **A IA executou:** escreveu o código e os testes a partir das especificações e decisões que eu tinha aprovado.
3. **Eu defini o rumo dos testes:** além dos cenários obrigatórios do enunciado, decidi como os testes deviam funcionar e pedi os que faltavam. Por exemplo: um banco de testes separado do de desenvolvimento; todos os testes terminando com a reconciliação pela API; um teste que força uma divergência no saldo e confere que ela é sinalizada, sem ser corrigida; o caso de um ROLLBACK depois de um REFUND da mesma aposta; o replay de uma transação que falhou; e o limite de tamanho dos identificadores. Também recusei atalhos, como deixar uma suíte de testes vazia passar sem aviso.

O texto do `ARCHITECTURE.md` e todos os commits são meus. Ao final, uma revisão independente conferiu a implementação contra cada requisito da especificação, e a suíte completa (837 testes) roda contra PostgreSQL e LocalStack reais.

Assumo a responsabilidade por todas as decisões deste projeto e estou preparado para explicá-las.
