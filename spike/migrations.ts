import { Migration } from '@mikro-orm/migrations';

export class Migration20261103000000SpikeWallets extends Migration {
  override up(): void {
    this.addSql(`
      create table spike_wallets (
        id uuid primary key,
        player_id uuid not null,
        balance numeric(20,2) not null check (balance >= 0),
        version integer not null default 1
      );`);
  }

  override down(): void {
    this.addSql('drop table spike_wallets;');
  }
}
