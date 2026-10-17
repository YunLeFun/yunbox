import type { TokenRecord, TokenStore } from '../src/tokens.ts'

/** In-memory {@link TokenStore} for tests, with read counting and failure injection. */
export class MemoryTokenStore implements TokenStore {
  records: TokenRecord[] = []
  reads = 0
  failReads = false

  async read(): Promise<TokenRecord[]> {
    this.reads += 1
    if (this.failReads)
      throw new Error('simulated token store outage')
    return structuredClone(this.records)
  }

  async write(records: TokenRecord[]): Promise<void> {
    this.records = structuredClone(records)
  }
}
