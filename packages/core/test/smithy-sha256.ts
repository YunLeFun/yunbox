import type { Buffer } from 'node:buffer'
import { createHash, createHmac } from 'node:crypto'

/**
 * The hash constructor `@smithy/signature-v4` (the AWS SDK's signer) takes,
 * built on node:crypto. Tests use that signer as an independent check of
 * YunBox's own SigV4 code.
 */
export class SmithySha256 {
  readonly #hash: ReturnType<typeof createHash> | ReturnType<typeof createHmac>

  constructor(secret?: string | Uint8Array | ArrayBuffer | ArrayBufferView) {
    this.#hash = secret === undefined ? createHash('sha256') : createHmac('sha256', toBytes(secret))
  }

  update(data: string | Uint8Array | ArrayBuffer | ArrayBufferView): void {
    this.#hash.update(toBytes(data))
  }

  async digest(): Promise<Uint8Array> {
    return this.#hash.digest() as Buffer
  }
}

function toBytes(data: string | Uint8Array | ArrayBuffer | ArrayBufferView): string | Uint8Array {
  if (typeof data === 'string' || data instanceof Uint8Array)
    return data
  if (ArrayBuffer.isView(data))
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
  return new Uint8Array(data)
}
