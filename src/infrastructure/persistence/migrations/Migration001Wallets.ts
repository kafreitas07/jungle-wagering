import { Migration } from '@mikro-orm/migrations';

const FAILURE_CODES = [
  'INSUFFICIENT_FUNDS',
  'REVERSAL_INSUFFICIENT_FUNDS',
  'REFERENCE_NOT_FOUND',
  'REFERENCE_MISMATCH',
  'INVALID_REFERENCE_KIND',
  'REFERENCE_NOT_PROCESSED',
  'REFERENCE_ALREADY_REVERSED',
  'AMOUNT_MISMATCH',
  'PROCESSING_FAILED',
];

const quoted = (values: string[]) => values.map((value) => `'${value}'`).join(', ');

export class Migration001Wallets extends Migration {
  override up(): void {
    this.addSql(`
      create table wallets (
        id uuid primary key,
        player_id uuid not null,
        currency char(3) not null,
        balance numeric(20,2) not null,
        version integer not null,
        created_at timestamptz not null,
        updated_at timestamptz not null,
        constraint wallets_balance_non_negative check (balance >= 0),
        constraint wallets_version_positive check (version >= 1),
        constraint wallets_player_currency_key unique (player_id, currency),
        constraint wallets_identity_key unique (id, currency, player_id),
        constraint wallets_currency_key unique (id, currency)
      );`);

    this.addSql(`
      create table wager_transactions (
        id uuid primary key,
        provider_id varchar(255) not null,
        external_transaction_id varchar(255) not null,
        idempotency_key varchar(255) not null,
        payload_hash char(64) not null,
        wallet_id uuid not null,
        player_id uuid not null,
        round_id varchar(255) not null,
        game_id varchar(255) not null,
        kind varchar(16) not null,
        amount numeric(20,2) not null,
        currency char(3) not null,
        reference_external_transaction_id varchar(255),
        reference_transaction_id uuid,
        status varchar(24) not null,
        failure_code varchar(40),
        balance_after numeric(20,2),
        reference_attempts integer not null default 0,
        next_attempt_at timestamptz,
        created_at timestamptz not null,
        processed_at timestamptz,
        updated_at timestamptz not null,
        constraint wager_transactions_idempotency_key unique (provider_id, idempotency_key),
        constraint wager_transactions_external_id unique (provider_id, external_transaction_id),
        constraint wager_transactions_wallet_identity_fkey
          foreign key (wallet_id, currency, player_id) references wallets (id, currency, player_id),
        constraint wager_transactions_reference_fkey
          foreign key (reference_transaction_id) references wager_transactions (id),
        constraint wager_transactions_kind_valid
          check (kind in ('BET','WIN','LOSS','REFUND','ROLLBACK','OPENING')),
        constraint wager_transactions_status_valid
          check (status in ('PENDING','PROCESSED','REJECTED','PENDING_REFERENCE','FAILED')),
        constraint wager_transactions_reference_required
          check (kind not in ('REFUND','ROLLBACK') or reference_external_transaction_id is not null),
        constraint wager_transactions_amount_positive
          check (amount >= 0 and (kind = 'LOSS' or amount > 0)),
        constraint wager_transactions_failure_code_matches_status
          check ((status in ('REJECTED','FAILED')) = (failure_code is not null)),
        constraint wager_transactions_failure_code_valid
          check (failure_code is null or failure_code in (${quoted(FAILURE_CODES)})),
        constraint wager_transactions_balance_after_non_negative
          check (balance_after is null or balance_after >= 0)
      );`);

    // A reference can be reversed once in total: REFUND and ROLLBACK compete for the same slot.
    this.addSql(`
      create unique index wager_transactions_single_reversal
        on wager_transactions (reference_transaction_id)
        where kind in ('REFUND','ROLLBACK') and status = 'PROCESSED';`);

    this.addSql(`
      create index wager_transactions_pending_reference
        on wager_transactions (next_attempt_at)
        where status = 'PENDING_REFERENCE';`);

    this.addSql(`
      create function wager_transactions_guard_terminal() returns trigger as $$
      begin
        raise exception 'wager_transactions row % is in terminal status % and cannot be updated', old.id, old.status
          using errcode = 'check_violation';
      end;
      $$ language plpgsql;`);

    this.addSql(`
      create trigger wager_transactions_terminal_is_immutable
        before update on wager_transactions
        for each row
        when (old.status in ('PROCESSED','REJECTED','FAILED'))
        execute function wager_transactions_guard_terminal();`);
  }

  override down(): void {
    this.addSql('drop table if exists wager_transactions;');
    this.addSql('drop function if exists wager_transactions_guard_terminal();');
    this.addSql('drop table if exists wallets;');
  }
}
