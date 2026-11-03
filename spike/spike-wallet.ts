// Plain domain-style class: no ORM or Nest imports, private constructor + factories.
export class SpikeWallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    private _balanceCents: bigint,
    private _version: number,
  ) {}

  static open(id: string, playerId: string, balanceCents: bigint): SpikeWallet {
    if (balanceCents < 0n) throw new Error('negative opening balance');
    return new SpikeWallet(id, playerId, balanceCents, 1);
  }

  static rehydrate(s: { id: string; playerId: string; balanceCents: bigint; version: number }): SpikeWallet {
    return new SpikeWallet(s.id, s.playerId, s.balanceCents, s.version);
  }

  get balanceCents(): bigint {
    return this._balanceCents;
  }

  get version(): number {
    return this._version;
  }

  debit(cents: bigint): void {
    if (cents > this._balanceCents) throw new Error('insufficient funds');
    this._balanceCents -= cents;
    this._version += 1;
  }
}
