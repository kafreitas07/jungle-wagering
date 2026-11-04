/**
 * Demo CLI for a running application: `bun run demo <command>`. It only calls the public HTTP API with Bun's fetch
 * and keeps a little state (player, wallet, last request, sent transactions) in `.demo-state.json` at the repo root.
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

let BASE_URL = (process.env.BASE_URL ?? 'http://localhost:3100').replace(/\/+$/, '');
const STATE_FILE = new URL('../.demo-state.json', import.meta.url).pathname;
const GAME_ID = 'demo-game';
const CURRENCY = 'BRL';

interface SentTransaction {
  readonly kind: string;
  readonly amount: string;
  readonly roundId: string;
}

interface LastRequest {
  readonly path: string;
  readonly headers: Record<string, string>;
  readonly body: Record<string, any>;
}

interface DemoState {
  /** One provider per demo wallet: idempotency keys and external ids are scoped by provider, so a new wallet starts clean. */
  providerId: string;
  playerId: string;
  walletId: string;
  nextNumber: number;
  last?: LastRequest;
  /** Every transaction sent, by external id: what a later REFUND/ROLLBACK/WIN needs to default its value and round. */
  transactions: Record<string, SentTransaction>;
}

interface Reply {
  readonly status: number;
  readonly body: any;
}

class UsageError extends Error {}

// --- state ---------------------------------------------------------------------------------------------------------

function loadState(): DemoState | undefined {
  if (!existsSync(STATE_FILE)) {
    return undefined;
  }
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf8')) as DemoState;
  } catch {
    throw new UsageError(`${STATE_FILE} não é um JSON válido. Rode "bun run demo reset" e comece de novo.`);
  }
}

function saveState(state: DemoState): void {
  writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`);
}

function requireState(): DemoState {
  const state = loadState();
  if (state === undefined) {
    throw new UsageError('Não há carteira no estado da demo. Rode "bun run demo wallet 100" primeiro.');
  }
  return state;
}

// --- http ----------------------------------------------------------------------------------------------------------

async function call(method: string, path: string, options: { headers?: Record<string, string>; body?: unknown } = {}): Promise<Reply> {
  let response: Response;
  try {
    response = await fetch(`${BASE_URL}${path}`, {
      method,
      headers: { ...(options.body === undefined ? {} : { 'content-type': 'application/json' }), ...options.headers },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new UsageError(`Não consegui acessar ${BASE_URL}. A aplicação está de pé? (mude o endereço com BASE_URL)`);
  }
  const text = await response.text();
  let body: unknown = text;
  try {
    body = text === '' ? undefined : JSON.parse(text);
  } catch {
    // keep the raw text (for example the Prometheus format)
  }
  return { status: response.status, body };
}

// --- helpers -------------------------------------------------------------------------------------------------------

/** "25" → "25.00", "25.5" → "25.50". The API itself only accepts two decimals; the CLI is just forgiving. */
function amountArg(value: string | undefined, what = 'Valor'): string {
  if (value === undefined || !/^\d+(\.\d{1,2})?$/.test(value)) {
    throw new UsageError(`${what} inválido "${value ?? ''}": use um número como 25 ou 25.50.`);
  }
  const [whole = '0', cents = ''] = value.split('.');
  return `${whole}.${cents.padEnd(2, '0')}`;
}

function nextExternalId(state: DemoState): string {
  let candidate = `ext-${state.nextNumber}`;
  while (state.transactions[candidate] !== undefined) {
    state.nextNumber += 1;
    candidate = `ext-${state.nextNumber}`;
  }
  state.nextNumber += 1;
  return candidate;
}

const money = (amount: string) => ({ amount, currency: CURRENCY });
const balanceOf = (body: any): string => (body?.balance ? `${body.balance.amount} ${body.balance.currency}` : '-');

/** The short form. Only what matters: HTTP status, transaction status, failure code, external id, balance. */
function summarizeTransaction(reply: Reply, extId: string): string {
  const { status, body } = reply;
  if (typeof body?.transactionId !== 'string') {
    return `${status} ${body?.failureCode ?? 'ERROR'}${body?.message ? ` - ${body.message}` : ''}`;
  }
  const parts = [String(status), body.status];
  if (body.failureCode) parts.push(body.failureCode);
  parts.push(`ext=${extId}`, `saldo=${balanceOf(body)}`);
  if (body.idempotentReplay) parts.push('(repetição)');
  return parts.join(' ');
}

// --- commands ------------------------------------------------------------------------------------------------------

type Flags = { raw: boolean };
type Output = { reply?: Reply; lines: string[] };

async function sendTransaction(
  state: DemoState,
  fields: { kind: string; amount: string; extId: string; roundId: string; referenceExtId?: string },
): Promise<Output> {
  const body: Record<string, any> = {
    providerId: state.providerId,
    externalTransactionId: fields.extId,
    playerId: state.playerId,
    walletId: state.walletId,
    roundId: fields.roundId,
    gameId: GAME_ID,
    kind: fields.kind,
    money: money(fields.amount),
    ...(fields.referenceExtId === undefined ? {} : { referenceExternalTransactionId: fields.referenceExtId }),
  };
  const request: LastRequest = { path: '/wagering/transactions', headers: { 'idempotency-key': `key-${fields.extId}` }, body };
  const reply = await call('POST', request.path, request);

  state.last = request;
  if (reply.status === 201 || reply.status === 202 || reply.status === 422) {
    state.transactions[fields.extId] = { kind: fields.kind, amount: fields.amount, roundId: fields.roundId };
  }
  saveState(state);
  return { reply, lines: [summarizeTransaction(reply, fields.extId)] };
}

const commands: Record<string, { usage: string; example: string; run: (args: string[], flags: Flags) => Promise<Output> }> = {
  health: {
    usage: 'health',
    example: 'bun run demo health',
    async run() {
      const live = await call('GET', '/health/live');
      const ready = await call('GET', '/health/ready');
      const deps = Object.entries(ready.body?.dependencies ?? {})
        .map(([name, value]: [string, any]) => `${name}=${value.status}`)
        .join(' ');
      return { reply: ready, lines: [`live ${live.status} | ready ${ready.status} ${deps}`] };
    },
  },

  wallet: {
    usage: 'wallet <valor>',
    example: 'bun run demo wallet 100',
    async run([value]) {
      const amount = amountArg(value);
      const playerId = crypto.randomUUID();
      const reply = await call('POST', '/wallets', { body: { playerId, initialBalance: money(amount) } });
      if (reply.status !== 201) {
        return { reply, lines: [`${reply.status} ${reply.body?.failureCode ?? 'ERROR'}`] };
      }
      saveState({ providerId: `demo-${playerId.slice(0, 8)}`, playerId, walletId: reply.body.id, nextNumber: 1, transactions: {} });
      return { reply, lines: [`${reply.status} carteira=${reply.body.id} saldo=${balanceOf(reply.body)}`] };
    },
  },

  bet: {
    usage: 'bet <valor> [extId]',
    example: 'bun run demo bet 25',
    async run([value, given]) {
      const state = requireState();
      const amount = amountArg(value);
      const extId = given ?? nextExternalId(state);
      return sendTransaction(state, { kind: 'BET', amount, extId, roundId: `round-${extId}` });
    },
  },

  win: {
    usage: 'win <valor> [refExtId]',
    example: 'bun run demo win 50 ext-1',
    async run([value, refExtId]) {
      const state = requireState();
      const amount = amountArg(value);
      const extId = nextExternalId(state);
      const roundId = state.transactions[refExtId ?? '']?.roundId ?? `round-${refExtId ?? extId}`;
      return sendTransaction(state, { kind: 'WIN', amount, extId, roundId, ...(refExtId === undefined ? {} : { referenceExtId: refExtId }) });
    },
  },

  loss: {
    usage: 'loss [refExtId]',
    example: 'bun run demo loss ext-1',
    async run([refExtId]) {
      const state = requireState();
      const extId = nextExternalId(state);
      const roundId = state.transactions[refExtId ?? '']?.roundId ?? `round-${refExtId ?? extId}`;
      return sendTransaction(state, { kind: 'LOSS', amount: '0.00', extId, roundId, ...(refExtId === undefined ? {} : { referenceExtId: refExtId }) });
    },
  },

  replay: {
    usage: 'replay',
    example: 'bun run demo replay',
    async run() {
      const state = requireState();
      if (state.last === undefined) {
        throw new UsageError('Ainda não há requisição para repetir. Envie uma aposta antes, por exemplo "bun run demo bet 25".');
      }
      const reply = await call('POST', state.last.path, state.last);
      return { reply, lines: [summarizeTransaction(reply, state.last.body.externalTransactionId)] };
    },
  },

  conflict: {
    usage: 'conflict <valor>',
    example: 'bun run demo conflict 30',
    async run([value]) {
      const state = requireState();
      if (state.last === undefined) {
        throw new UsageError('Ainda não há requisição para conflitar. Envie uma aposta antes, por exemplo "bun run demo bet 25".');
      }
      const body: Record<string, any> = { ...state.last.body, money: money(amountArg(value)) };
      const reply = await call('POST', state.last.path, { headers: state.last.headers, body });
      return { reply, lines: [summarizeTransaction(reply, body.externalTransactionId)] };
    },
  },

  refund: reversal('REFUND'),
  rollback: reversal('ROLLBACK'),

  tx: {
    usage: 'tx <extId>',
    example: 'bun run demo tx ext-1',
    async run([extId]) {
      if (extId === undefined) throw new UsageError('Uso: bun run demo tx <extId>');
      const { providerId } = requireState();
      const reply = await call('GET', `/providers/${providerId}/wagering/transactions/${encodeURIComponent(extId)}`);
      const b = reply.body;
      if (reply.status !== 200) {
        return { reply, lines: [`${reply.status} ${b?.failureCode ?? 'ERROR'} ext=${extId}`] };
      }
      const parts = [String(reply.status), b.status, b.kind];
      if (b.failureCode) parts.push(b.failureCode);
      parts.push(`ext=${b.externalTransactionId}`, `valor=${b.money.amount}`, `saldo=${balanceOf(b)}`);
      return { reply, lines: [parts.join(' ')] };
    },
  },

  balance: {
    usage: 'balance',
    example: 'bun run demo balance',
    async run() {
      const state = requireState();
      const reply = await call('GET', `/wallets/${state.walletId}`);
      return { reply, lines: [`${reply.status} saldo=${balanceOf(reply.body)} versão=${reply.body?.version ?? '-'}`] };
    },
  },

  ledger: {
    usage: 'ledger',
    example: 'bun run demo ledger',
    async run() {
      const state = requireState();
      const reply = await call('GET', `/wallets/${state.walletId}/ledger?limit=20`);
      if (reply.status !== 200) {
        return { reply, lines: [`${reply.status} ${reply.body?.failureCode ?? 'ERROR'}`] };
      }
      const lines = (reply.body.items as any[]).map(
        (entry) => `v${entry.walletVersion} ${entry.direction.padEnd(6)} ${entry.amount.amount} ${entry.balanceBefore.amount} -> ${entry.balanceAfter.amount}`,
      );
      return { reply, lines: [`${reply.status} ${lines.length} lançamentos (do mais novo ao mais antigo)`, ...lines] };
    },
  },

  reconcile: {
    usage: 'reconcile',
    example: 'bun run demo reconcile',
    async run() {
      const state = requireState();
      const reply = await call('POST', `/wallets/${state.walletId}/reconciliation`);
      const b = reply.body;
      if (reply.status !== 200) {
        return { reply, lines: [`${reply.status} ${b?.failureCode ?? 'ERROR'}`] };
      }
      return {
        reply,
        lines: [`${reply.status} consistente=${b.consistent} guardado=${b.storedBalance.amount} calculado=${b.calculatedBalance.amount} lançamentos=${b.checkedEntries}`],
      };
    },
  },

  reset: {
    usage: 'reset',
    example: 'bun run demo reset',
    async run() {
      rmSync(STATE_FILE, { force: true });
      return { lines: ['estado da demo apagado'] };
    },
  },
};

function reversal(kind: 'REFUND' | 'ROLLBACK') {
  const name = kind.toLowerCase();
  return {
    usage: `${name} <refExtId> [valor]`,
    example: `bun run demo ${name} ext-1`,
    async run([refExtId, value]: string[]): Promise<Output> {
      const state = requireState();
      if (refExtId === undefined) throw new UsageError(`Uso: bun run demo ${name} <refExtId> [valor]`);
      const referenced = state.transactions[refExtId];
      const amount = value !== undefined ? amountArg(value) : referenced?.amount;
      if (amount === undefined) {
        throw new UsageError(`${refExtId} não está no estado da demo, então não há valor padrão: bun run demo ${name} ${refExtId} <valor>`);
      }
      return sendTransaction(state, {
        kind,
        amount,
        extId: nextExternalId(state),
        roundId: referenced?.roundId ?? `round-${refExtId}`,
        referenceExtId: refExtId,
      });
    },
  };
}

/**
 * Resolves `--replica N` to the host URL of the Nth replica of the `app` service (Docker Compose only).
 * Runs `docker compose port --index N app 3100` from the repo root, which prints e.g. `0.0.0.0:3101`.
 */
function resolveReplicaUrl(replica: string): string {
  if (!/^[1-9]\d*$/.test(replica)) {
    throw new UsageError(`--replica espera um número inteiro a partir de 1 (recebi "${replica}").`);
  }
  const repoRoot = new URL('..', import.meta.url).pathname;
  let result: ReturnType<typeof Bun.spawnSync>;
  try {
    result = Bun.spawnSync(['docker', 'compose', 'port', '--index', replica, 'app', '3100'], { cwd: repoRoot });
  } catch {
    throw new UsageError('Não consegui executar "docker compose". O Docker está instalado e acessível?');
  }
  const output = (result.stdout?.toString() ?? '').trim();
  const port = /:(\d+)$/.exec(output.split('\n')[0] ?? '')?.[1];
  if (result.exitCode !== 0 || port === undefined) {
    throw new UsageError(
      `Não encontrei a réplica ${replica}. O compose está de pé com essa réplica? (docker compose ps app)`,
    );
  }
  return `http://localhost:${port}`;
}

function help(): string {
  const width = Math.max(...Object.values(commands).map((command) => command.usage.length));
  return [
    `CLI de demonstração (alvo: ${BASE_URL}; mude com BASE_URL ou use --replica N para falar com a réplica N do Docker). Acrescente --raw a qualquer comando para ver a resposta completa em JSON.`,
    '',
    ...Object.values(commands).map((command) => `  ${command.usage.padEnd(width)}   ex.: ${command.example}`),
    '  help',
  ].join('\n');
}

// --- main ----------------------------------------------------------------------------------------------------------

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const raw = argv.includes('--raw');
  const rest: string[] = [];
  let replica: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--raw') continue;
    if (arg === '--replica') {
      replica = argv[++i] ?? '';
    } else if (arg.startsWith('--replica=')) {
      replica = arg.slice('--replica='.length);
    } else {
      rest.push(arg);
    }
  }
  const [name, ...args] = rest;

  if (name === undefined || name === 'help' || name === '--help' || name === '-h') {
    console.log(help());
    return;
  }
  const command = commands[name];
  if (command === undefined) {
    throw new UsageError(`Comando desconhecido "${name}".\n\n${help()}`);
  }
  if (replica !== undefined) {
    BASE_URL = resolveReplicaUrl(replica);
  }

  const output = await command.run(args, { raw });
  if (raw && output.reply !== undefined) {
    console.log(JSON.stringify({ status: output.reply.status, body: output.reply.body }, null, 2));
  } else {
    console.log(output.lines.join('\n'));
  }
  if (output.reply !== undefined && output.reply.status >= 500) {
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof UsageError ? error.message : error);
  process.exit(1);
});
