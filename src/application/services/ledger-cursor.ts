/** Opaque cursor: base64url of `{"v": walletVersion}` of the last entry already seen. */
export function encodeLedgerCursor(walletVersion: number): string {
  return Buffer.from(JSON.stringify({ v: walletVersion })).toString('base64url');
}

/** The wallet version to continue from, or `undefined` when the cursor is not one this system issued. */
export function decodeLedgerCursor(cursor: string): number | undefined {
  try {
    const decoded: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (typeof decoded === 'object' && decoded !== null && !Array.isArray(decoded)) {
      const version = (decoded as { v?: unknown }).v;
      if (typeof version === 'number' && Number.isInteger(version) && version >= 1) {
        return version;
      }
    }
  } catch {
    // Not base64url JSON: falls through to invalid.
  }
  return undefined;
}
