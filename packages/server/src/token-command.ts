// @env node

import type { TokenPermission, TokenSummary } from './tokens.ts'
import { parseArgs } from 'node:util'
import { resolveStorageSettings } from './config.ts'
import { configureStorage } from './storage-config.ts'
import { assertRepositoryPattern, createToken, listTokens, revokeToken } from './tokens.ts'

/** Where token commands print and which environment they read. */
export interface CommandIo {
  stdout: (line: string) => void
  env: NodeJS.ProcessEnv
}

export const tokenHelp = `Manage YunBox personal tokens. Run on the deployment host or an administrator machine.

Usage:
  yunbox-server token create --name <name> [--read <repo>]... [--write <repo>]... [storage options]
  yunbox-server token list [storage options]
  yunbox-server token revoke <id-or-name> [storage options]

<repo> is <owner>/<repo>, or <owner>/* for every repository of an owner (quote
it in the shell). write implies read; an exact repository entry overrides the
owner wildcard.

Storage options (must match the server; command-line options override the
environment variables):
  --storage       local or cos; YUNBOX_STORAGE (default: local)
  --storage-dir   Local storage directory; YUNBOX_STORAGE_DIR (default: .yunbox-data)

create prints the token once. Only its SHA-256 hash is stored, so it cannot be
shown again; revoke and create a new one if it is lost.
`

/** Run `yunbox-server token <subcommand>`. */
export async function runTokenCommand(args: string[], io: CommandIo): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      'name': { type: 'string' },
      'read': { type: 'string', multiple: true },
      'write': { type: 'string', multiple: true },
      'storage': { type: 'string' },
      'storage-dir': { type: 'string' },
      'help': { type: 'boolean', short: 'h' },
    },
  })
  const [subcommand, ...rest] = positionals
  if (values.help || subcommand === undefined) {
    io.stdout(tokenHelp)
    return
  }
  const settings = resolveStorageSettings(values, io.env)
  const { tokens } = configureStorage({ kind: settings.kind, storageDirectory: settings.storageDirectory, env: io.env })

  switch (subcommand) {
    case 'create': {
      if (values.name === undefined)
        throw new TypeError('token create needs --name')
      const repos: Record<string, TokenPermission> = {}
      for (const [permission, patterns] of [['read', values.read], ['write', values.write]] as const) {
        for (const pattern of patterns ?? []) {
          assertRepositoryPattern(pattern)
          if (repos[pattern] !== 'write')
            repos[pattern] = permission
        }
      }
      if (Object.keys(repos).length === 0)
        throw new TypeError('token create needs at least one --read or --write repository')
      const { secret, token } = await createToken(tokens, { name: values.name, repos })
      io.stdout(`Created ${describe(token)}`)
      io.stdout('')
      io.stdout(`  ${secret}`)
      io.stdout('')
      io.stdout('This is the only time the token is shown. Store it in a Git credential helper as the password')
      io.stdout('for the YunBox URL (any user name works), and never commit it.')
      return
    }
    case 'list': {
      const listed = await listTokens(tokens)
      if (listed.length === 0)
        io.stdout('No tokens.')
      for (const token of listed)
        io.stdout(describe(token))
      return
    }
    case 'revoke': {
      const target = rest[0]
      if (target === undefined)
        throw new TypeError('token revoke needs a token id or name')
      const revoked = await revokeToken(tokens, target)
      if (revoked === undefined)
        throw new Error(`no token matches ${target}`)
      io.stdout(`Revoked ${describe(revoked)}`)
      io.stdout('Running servers stop accepting it within their token cache TTL; URLs it already obtained expire within the action TTL.')
      return
    }
    default:
      throw new TypeError(`unknown token subcommand: ${subcommand}`)
  }
}

function describe(token: TokenSummary): string {
  const repos = Object.entries(token.repos).map(([pattern, permission]) => `${pattern}:${permission}`).join(', ')
  return `${token.id}  ${token.name}  created ${token.createdAt}  ${repos}`
}
