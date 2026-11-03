# Arquitetura

Decisões, trade-offs e limitações do Distributed Wagering Processor. Os requisitos detalhados estão em `.specs/features/wagering-processor/spec.md`.

## 1. Visão geral

Montei o projeto como um monólito modular com arquitetura hexagonal, para facilitar a criação dos testes. O domínio guarda as regras de negócio e não depende de framework nem de banco. A aplicação administra os casos de uso, e a infraestrutura cuida do banco, da fila e do HTTP.

Todos os processos são iguais e rodam as quatro funções (API, consumidor da fila, publicador de eventos e worker de pendências). A consistência é garantida pelo PostgreSQL, e as regras financeiras estão no schema; a ordenação da fila FIFO é só uma otimização.

## 2. Escolhas técnicas

**ORM:** escolhi o MikroORM. Antes de escrever o domínio, fiz um spike de meia hora para testar a stack junta, já que é uma combinação pouco comum e eu queria ver como funcionaria. A ideia era descobrir incompatibilidades cedo, enquanto ainda dava para trocar para o TypeORM. O spike também confirmou que o saldo negativo é recusado pelo `CHECK` e que duas atualizações simultâneas na mesma carteira não se sobrescrevem.

Domínio e persistência ficam separados: o ORM só conhece records que espelham as tabelas, e um mapper converte para as classes de domínio, sempre pela factory `rehydrate`. O custo é mais código de mapeamento, em troca de um domínio que não sabe que o banco existe.

**Dinheiro:** centavos em `bigint` no código e `numeric(20,2)` no banco, lido como texto. Porque dessa forma as contas são sempre exatas: inteiros não têm erro de arredondamento, enquanto o `number` do JavaScript erra até contas simples, como `0.1 + 0.2`, que dá `0.30000000000000004`. Nos contratos, o valor é uma string com duas casas (`"25.00"`).

**Validação:** uso o Zod, com o mesmo schema para a API e para a fila, porque assim os caminhos de entrada nunca validam de forma diferente.

## 3. Concorrência

Cada carteira é travada no banco antes de qualquer alteração, fazendo com que duas operações na mesma carteira aconteçam uma depois da outra, mesmo vindo de réplicas diferentes, enquanto carteiras diferentes seguem em paralelo. Não existe lock global.

Usei o lock pessimista porque, numa carteira muito disputada, o otimista gera ondas de tentativas que falham e se repetem. O custo é que uma mesma carteira processa uma transação por vez.

## 4. Idempotência

A repetição é detectada pelo banco, com chaves únicas por provedor, nunca em memória. Cada transação guarda um hash do seu conteúdo de negócio (SHA-256 de um JSON com as chaves em ordem alfabética), para que a mesma transação gere sempre o mesmo hash.

Mesma chave e mesmo conteúdo devolve o resultado original. Mesma chave com conteúdo diferente devolve 409. A checagem acontece depois do lock da carteira, então requisições simultâneas e iguais são resolvidas uma de cada vez.

Se a transação estava pendente e já foi processada, o replay devolve o resultado final, porque um pendente não é um resultado.

## 5. Interpretações das regras

**Reversão única:** uma transação só pode ser revertida uma vez no total, seja por REFUND ou por ROLLBACK, para evitar crédito duplicado na mesma aposta.

**Recusas não gravadas:** transações com carteira inexistente, ou com moeda ou jogador diferente da carteira, são recusadas pelo banco e voltam 422 sem serem gravadas. Ficam registradas em log e métrica.

## 6. Mensageria

**Consumidor:** usa o mesmo caso de uso da API e só confirma a mensagem depois do commit. A mensagem é registrada na inbox na mesma transação, então uma reentrega é reconhecida e não gera efeito duplicado. Erros temporários voltam para a fila com espera crescente e vão para a DLQ depois de 5 tentativas. Mensagens malformadas ou em conflito vão direto para a DLQ, para preservar a evidência.

**Eventos:** são gravados na outbox, na mesma transação da operação, e publicados depois do commit. Se a instância cair no meio da publicação, outra assume. Um evento pode ser publicado duas vezes, mas nunca se perde, e o consumidor deduplica pelo `eventId`. A ordem entre eventos de uma carteira não é garantida: o consumidor deve ordenar pelo `walletVersion`.

**Referências pendentes:** um REFUND ou ROLLBACK que chega antes da aposta fica pendente e é tentado de novo até 10 vezes, com espera crescente de 1 segundo até 5 minutos (cerca de 14 minutos no total), porque a maioria dos atrasos se resolve em segundos e assim ainda toleramos atrasos de alguns minutos. Se a referência não aparecer, vira REJECTED com `REFERENCE_NOT_FOUND`.

## 7. Autenticação

Decidi não implementar a autenticação. Priorizei as garantias financeiras (saldo, concorrência e idempotência).

**O que existe no código:** todas as rotas passam por um `AuthGuard`, que pergunta a um `ProviderIdentityPort` se aquele provedor pode agir. A implementação atual responde sempre "sim". Para ligar a autenticação de verdade, basta trocar essa implementação; nenhum controller muda. Como ela aceita todos os provedores, a aplicação não deve ir para produção assim.

Em produção, eu usaria o Keycloak: cada provedor seria um cliente OAuth2 com *client credentials*, a API validaria o token JWT pela chave pública do Keycloak, e o `providerId` do token teria que ser igual ao do body, senão a resposta seria 403. Os endpoints de health ficam abertos.

## 8. Limitações

- Uma mesma carteira processa uma transação por vez, por causa do lock.
- Eventos podem ser publicados mais de uma vez e sem ordem garantida entre eventos da mesma carteira.
- Recusas por carteira inexistente, moeda ou jogador diferente não ficam gravadas no banco, só em log e métrica.
- Não há autenticação.
- As métricas da outbox são iguais em todas as réplicas e devem ser agregadas com `max()`, não `sum()`.