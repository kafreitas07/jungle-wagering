import { Migration } from '@mikro-orm/migrations';

export class Migration002LedgerInboxOutbox extends Migration {
  override up(): void {
    this.addSql(`
      create table wallet_ledger_entries (
        id uuid primary key,
        wallet_id uuid not null,
        currency char(3) not null,
        transaction_id uuid not null,
        direction varchar(6) not null,
        amount numeric(20,2) not null,
        balance_before numeric(20,2) not null,
        balance_after numeric(20,2) not null,
        wallet_version integer not null,
        created_at timestamptz not null,
        constraint wallet_ledger_entries_transaction_key unique (transaction_id),
        constraint wallet_ledger_entries_wallet_version_key unique (wallet_id, wallet_version),
        constraint wallet_ledger_entries_wallet_currency_fkey
          foreign key (wallet_id, currency) references wallets (id, currency),
        constraint wallet_ledger_entries_transaction_fkey
          foreign key (transaction_id) references wager_transactions (id),
        constraint wallet_ledger_entries_direction_valid check (direction in ('CREDIT','DEBIT')),
        constraint wallet_ledger_entries_amount_positive check (amount > 0),
        constraint wallet_ledger_entries_balances_non_negative
          check (balance_before >= 0 and balance_after >= 0),
        constraint wallet_ledger_entries_version_positive check (wallet_version >= 1),
        constraint wallet_ledger_entries_arithmetic
          check (balance_after = balance_before + case direction when 'CREDIT' then amount else -amount end)
      );`);

    this.addSql(`
      create function wallet_ledger_entries_forbid_change() returns trigger as $$
      begin
        raise exception 'wallet_ledger_entries is immutable: % is not allowed', tg_op
          using errcode = 'check_violation';
      end;
      $$ language plpgsql;`);

    this.addSql(`
      create trigger wallet_ledger_entries_no_update_delete
        before update or delete on wallet_ledger_entries
        for each row execute function wallet_ledger_entries_forbid_change();`);

    this.addSql(`
      create trigger wallet_ledger_entries_no_truncate
        before truncate on wallet_ledger_entries
        for each statement execute function wallet_ledger_entries_forbid_change();`);

    this.addSql(`
      create table inbox_messages (
        consumer_name varchar(100) not null,
        message_id varchar(255) not null,
        payload_hash char(64) not null,
        received_at timestamptz not null,
        processed_at timestamptz,
        constraint inbox_messages_pkey primary key (consumer_name, message_id)
      );`);

    this.addSql(`
      create table outbox_messages (
        id uuid primary key,
        aggregate_id uuid not null,
        group_key varchar(255) not null,
        event_type varchar(100) not null,
        payload jsonb not null,
        occurred_at timestamptz not null,
        attempts integer not null default 0,
        next_attempt_at timestamptz not null,
        locked_until timestamptz,
        published_at timestamptz,
        last_error text,
        constraint outbox_messages_attempts_non_negative check (attempts >= 0)
      );`);

    this.addSql(`
      create index outbox_messages_unpublished
        on outbox_messages (next_attempt_at)
        where published_at is null;`);
  }

  override down(): void {
    this.addSql('drop table if exists outbox_messages;');
    this.addSql('drop table if exists inbox_messages;');
    this.addSql('drop table if exists wallet_ledger_entries;');
    this.addSql('drop function if exists wallet_ledger_entries_forbid_change();');
  }
}
