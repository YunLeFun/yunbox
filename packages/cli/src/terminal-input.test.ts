import type { PassThrough } from 'node:stream'
import { Buffer } from 'node:buffer'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readTerminalLine } from './terminal-input.ts'

const consoleMock = vi.hoisted(() => ({
  open: vi.fn<(path: string, flags: string) => number>(),
  close: vi.fn(),
  inputs: [] as PassThrough[],
  outputs: [] as PassThrough[],
}))

vi.mock('node:process', () => ({ default: { platform: 'win32' } }))
vi.mock('node:fs', () => ({ openSync: consoleMock.open, closeSync: consoleMock.close }))
vi.mock('node:tty', async () => {
  const { PassThrough } = await import('node:stream')
  return {
    ReadStream: class extends PassThrough {
      constructor() {
        super()
        consoleMock.inputs.push(this)
      }
    },
    WriteStream: class extends PassThrough {
      constructor() {
        super()
        consoleMock.outputs.push(this)
      }
    },
  }
})

beforeEach(() => {
  consoleMock.open.mockReset().mockReturnValue(42)
  consoleMock.close.mockReset()
  consoleMock.inputs.length = 0
  consoleMock.outputs.length = 0
})

describe('windows controlling console', () => {
  it('reads a Unicode answer from the console devices, independent of redirected stdin', async () => {
    const answer = readTerminalLine('继续？[y/N] ')
    const bytes = Buffer.from('y 美术已确认\r\n')
    // Split inside a multibyte character, as a real console stream may do.
    consoleMock.inputs[0]!.write(bytes.subarray(0, 3))
    consoleMock.inputs[0]!.write(bytes.subarray(3))
    expect(await answer).toBe('y 美术已确认')
    expect(consoleMock.open.mock.calls).toEqual([['\\\\.\\CONIN$', 'r+'], ['\\\\.\\CONOUT$', 'r+']])
    expect(consoleMock.inputs[0]!.destroyed).toBe(true)
    expect(consoleMock.outputs[0]!.destroyed).toBe(true)
    expect(consoleMock.close).not.toHaveBeenCalled() // TTY streams own the handles.
  })

  it('allows an empty line to cancel, and treats EOF as no confirmation', async () => {
    const empty = readTerminalLine('继续？')
    consoleMock.inputs[0]!.write('\r\n')
    expect(await empty).toBe('')
    const eof = readTerminalLine('继续？')
    consoleMock.inputs[1]!.end()
    expect(await eof).toBeUndefined()
    const partial = readTerminalLine('继续？')
    consoleMock.inputs[2]!.end('y')
    expect(await partial).toBeUndefined()
  })

  it('fails closed without a console or after an input error', async () => {
    consoleMock.open.mockImplementationOnce(() => {
      throw new Error('no console')
    })
    expect(await readTerminalLine('继续？')).toBeUndefined()
    const failed = readTerminalLine('继续？')
    consoleMock.inputs[0]!.destroy(new Error('console closed'))
    expect(await failed).toBeUndefined()
    expect(consoleMock.outputs[0]!.destroyed).toBe(true)
  })

  it('closes the input if opening the output fails', async () => {
    consoleMock.open.mockReturnValueOnce(42).mockImplementationOnce(() => {
      throw new Error('no screen buffer')
    })
    expect(await readTerminalLine('继续？')).toBeUndefined()
    expect(consoleMock.inputs[0]!.destroyed).toBe(true)
  })
})
