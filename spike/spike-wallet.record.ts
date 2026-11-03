import { EntitySchema } from '@mikro-orm/core';

// Persistence record kept separate from the domain class. numeric(20,2) is read as a string.
export interface SpikeWalletRecord {
  id: string;
  playerId: string;
  balance: string;
  version: number;
}

export const SpikeWalletSchema = new EntitySchema<SpikeWalletRecord>({
  name: 'SpikeWalletRecord',
  tableName: 'spike_wallets',
  properties: {
    id: { type: 'uuid', primary: true },
    playerId: { type: 'uuid', fieldName: 'player_id' },
    balance: { type: 'decimal', precision: 20, scale: 2, runtimeType: 'string' },
    version: { type: 'integer', version: true },
  },
});
