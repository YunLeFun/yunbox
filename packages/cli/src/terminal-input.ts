import { Buffer } from 'node:buffer'
import { closeSync, openSync } from 'node:fs'
import { open } from 'node:fs/promises'
import process from 'node:process'
import { StringDecoder } from 'node:string_decoder'
import { ReadStream, WriteStream } from 'node:tty'

/**
 * Ask on the controlling terminal, never stdin (pre-push uses it for Git refs).
 * Windows console handles work even when a hook's standard input is redirected.
 * Returns undefined on EOF, device errors or when no console is attached.
 */
export async function readTerminalLine(question: string): Promise<string | undefined> {
  return process.platform === 'win32' ? readWindowsConsole(question) : readPosixTerminal(question)
}

async function readWindowsConsole(question: string): Promise<string | undefined> {
  let inputFd: number | undefined
  let outputFd: number | undefined
  let input: ReadStream | undefined
  let output: WriteStream | undefined
  try {
    // r+ gives libuv the read/write console access needed for input mode changes.
    // The device namespace avoids accidentally creating files called CONOUT$.
    inputFd = openSync('\\\\.\\CONIN$', 'r+')
    input = new ReadStream(inputFd)
    inputFd = undefined // The TTY stream owns this fd on Windows.
    outputFd = openSync('\\\\.\\CONOUT$', 'r+')
    output = new WriteStream(outputFd)
    outputFd = undefined
    // Cooked console input supplies line editing, echo and Unicode via ReadConsoleW.
    input.setEncoding('utf8')
    return await new Promise<string | undefined>((resolve) => {
      let answer = ''
      input!.on('data', (chunk: string) => {
        answer += chunk
        if (answer.length > 8192)
          resolve(undefined)
        else if (/[\r\n]/.test(answer))
          resolve(answer.split(/[\r\n]/)[0])
      })
      // A partial "y" at EOF is not an Enter-confirmed answer.
      input!.once('end', () => resolve(undefined))
      input!.once('close', () => resolve(undefined))
      input!.once('error', () => resolve(undefined))
      output!.once('error', () => resolve(undefined))
      output!.write(question)
    })
  }
  catch {
    return undefined
  }
  finally {
    input?.destroy()
    output?.destroy()
    if (inputFd !== undefined)
      closeSync(inputFd)
    if (outputFd !== undefined)
      closeSync(outputFd)
  }
}

async function readPosixTerminal(question: string): Promise<string | undefined> {
  let tty
  try {
    tty = await open('/dev/tty', 'r+')
    await tty.write(question)
    const buffer = Buffer.alloc(256)
    const decoder = new StringDecoder('utf8')
    let answer = ''
    while (!answer.includes('\n')) {
      const { bytesRead } = await tty.read(buffer, 0, buffer.length, null)
      if (!bytesRead)
        return undefined
      answer += decoder.write(buffer.subarray(0, bytesRead))
      if (answer.length > 8192)
        return undefined
    }
    return answer.split('\n')[0]!
  }
  catch {
    return undefined
  }
  finally {
    await tty?.close()
  }
}
