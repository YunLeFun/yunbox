// @env node

import type { ConfiguredStorage } from './storage-config.ts'
import type { TokenPermission, TokenSummary } from './tokens.ts'
import { parseArgs } from 'node:util'
import { resolveStorageSettings } from './config.ts'
import { migrateLegacyTokens } from './legacy-tokens.ts'
import { assertRepositoryPattern } from './metadata.ts'
import { configureStorage } from './storage-config.ts'
import { createToken, listTokens, parseDuration, revokeToken, setGrant } from './tokens.ts'

/** Where token commands print and which environment they read. */
export interface CommandIo {
  stdout: (line: string) => void
  env: NodeJS.ProcessEnv
}

const storageOptionsHelp = `Storage options (must match the server; command-line options override the
environment variables):
  --storage       local or cos; YUNBOX_STORAGE (default: local)
  --storage-dir   Local storage directory; YUNBOX_STORAGE_DIR (default: .yunbox-data)
  --metadata      Where tokens and grants live: local or cloudbase; YUNBOX_METADATA
                  (default: cloudbase with COS storage, local otherwise)
  --metadata-dir  Local metadata directory; YUNBOX_METADATA_DIR
                  (default: <storage-dir>/_yunbox/metadata)
`

export const tokenHelp = `Manage YunBox personal tokens. Run on the deployment host or an administrator machine.

Usage:
  yunbox-server token create --name <name> [--user <user>] [--read <repo>]... [--write <repo>]...
                             [--expires-in <duration>] [storage options]
  yunbox-server token list [storage options]
  yunbox-server token revoke <id-or-name> [storage options]
  yunbox-server token migrate [--expires-in <duration>] [storage options]
  yunbox-server grant list [storage options]
  yunbox-server grant set <user> [--read <repo>]... [--write <repo>]... [storage options]

A token acts for a user (--user, default: the token name) and can access what
that user is granted. --read / --write on token create add to the user's
grants and never reduce them; grant set replaces them (without --read or
--write it removes them, which disables every token of the user).

<repo> is <owner>/<repo>, or <owner>/* for every repository of an owner (quote
it in the shell). write implies read; an exact repository entry overrides the
owner wildcard.

Tokens expire after --expires-in (such as 90d, 12h or 30m; default 90d).
create prints the token once. Only its SHA-256 hash is stored, so it cannot be
shown again; revoke and create a new one if it is lost.

migrate copies the tokens of the earlier tokens.json (<storage-dir>/_yunbox/tokens.json
or <prefix>/_yunbox/tokens.json in COS) into the metadata store. Tokens keep
working with the same secret; each gets a user of the same name with the
token's repositories and expires --expires-in after the migration. Running it
again skips tokens it already migrated, even revoked ones.

${storageOptionsHelp}`

const options = {
  'name': { type: 'string' },
  'user': { type: 'string' },
  'read': { type: 'string', multiple: true },
  'write': { type: 'string', multiple: true },
  'expires-in': { type: 'string' },
  'storage': { type: 'string' },
  'storage-dir': { type: 'string' },
  'metadata': { type: 'string' },
  'metadata-dir': { type: 'string' },
  'help': { type: 'boolean', short: 'h' },
} as const

function parse(args: string[]): ReturnType<typeof parseArgs<{ args: string[], allowPositionals: true, options: typeof options }>> {
  return parseArgs({ args, allowPositionals: true, options })
}

function configure(values: ReturnType<typeof parse>['values'], io: CommandIo): ConfiguredStorage {
  const settings = resolveStorageSettings(values, io.env)
  return configureStorage({ ...settings, env: io.env })
}

function collectRepos(values: ReturnType<typeof parse>['values']): Record<string, TokenPermission> {
  const repos: Record<string, TokenPermission> = {}
  for (const [permission, patterns] of [['read', values.read], ['write', values.write]] as const) {
    for (const pattern of patterns ?? []) {
      assertRepositoryPattern(pattern)
      if (repos[pattern] !== 'write')
        repos[pattern] = permission
    }
  }
  return repos
}

/** Run `yunbox-server token <subcommand>`. */
export async function runTokenCommand(args: string[], io: CommandIo): Promise<void> {
  const { values, positionals } = parse(args)
  const [subcommand, ...rest] = positionals
  if (values.help || subcommand === undefined) {
    io.stdout(tokenHelp)
    return
  }
  if (!['create', 'list', 'revoke', 'migrate'].includes(subcommand))
    throw new TypeError(`unknown token subcommand: ${subcommand}`)
  const lifetimeMs = values['expires-in'] === undefined ? undefined : parseDuration(values['expires-in'])
  const { metadata, legacyTokens } = configure(values, io)

  switch (subcommand) {
    case 'create': {
      if (values.name === undefined)
        throw new TypeError('token create needs --name')
      const { secret, token } = await createToken(metadata, {
        name: values.name,
        user: values.user,
        repos: collectRepos(values),
        lifetimeMs,
      })
      const grant = await metadata.grants.get(token.user)
      io.stdout(`Created ${describe(token, Date.now())}`)
      io.stdout(`User ${token.user} can access ${describeRepos(grant?.repos ?? {})}`)
      io.stdout('')
      io.stdout(`  ${secret}`)
      io.stdout('')
      io.stdout('This is the only time the token is shown. Store it in a Git credential helper as the password')
      io.stdout('for the YunBox URL (any user name works), and never commit it.')
      return
    }
    case 'list': {
      const listed = await listTokens(metadata)
      if (listed.length === 0)
        io.stdout('No tokens.')
      const now = Date.now()
      for (const token of listed)
        io.stdout(describe(token, now))
      return
    }
    case 'revoke': {
      const target = rest[0]
      if (target === undefined)
        throw new TypeError('token revoke needs a token id or name')
      const revoked = await revokeToken(metadata, target)
      if (revoked === undefined)
        throw new Error(`no token matches ${target}`)
      io.stdout(`Revoked ${describe(revoked, Date.now())}`)
      io.stdout('Running servers stop accepting it within their token cache TTL; URLs it already obtained expire within the action TTL.')
      return
    }
    default: {
      const report = await migrateLegacyTokens(legacyTokens, metadata, { lifetimeMs })
      const total = report.migrated.length + report.skipped.length + report.conflicts.length
      if (total === 0) {
        io.stdout(`No earlier tokens found in ${legacyTokens.description}.`)
        return
      }
      for (const record of report.migrated)
        io.stdout(`Migrated ${record.id}  ${record.name}`)
      for (const record of report.skipped)
        io.stdout(`Already migrated ${record.id}  ${record.name}`)
      for (const record of report.conflicts)
        io.stdout(`Conflict ${record.id}  ${record.name}: a different token with this id exists; left untouched`)
      io.stdout(`${report.migrated.length} migrated, ${report.skipped.length} already migrated, ${report.conflicts.length} conflicts, from ${legacyTokens.description}.`)
      if (report.conflicts.length > 0)
        throw new Error('some tokens could not be migrated')
    }
  }
}

/** Run `yunbox-server grant <subcommand>`. */
export async function runGrantCommand(args: string[], io: CommandIo): Promise<void> {
  const { values, positionals } = parse(args)
  const [subcommand, user] = positionals
  if (values.help || subcommand === undefined) {
    io.stdout(tokenHelp)
    return
  }
  if (subcommand !== 'list' && subcommand !== 'set')
    throw new TypeError(`unknown grant subcommand: ${subcommand}`)
  const { metadata } = configure(values, io)
  if (subcommand === 'list') {
    const grants = await metadata.grants.list()
    if (grants.length === 0)
      io.stdout('No grants.')
    for (const grant of grants)
      io.stdout(`${grant.user}  ${describeRepos(grant.repos)}  updated ${grant.updatedAt}`)
    return
  }
  if (user === undefined)
    throw new TypeError('grant set needs a user')
  const grant = await setGrant(metadata, user, collectRepos(values))
  io.stdout(grant === undefined
    ? `Removed every grant of ${user}; the user's tokens no longer give access to anything.`
    : `${user} can access ${describeRepos(grant.repos)}`)
  io.stdout('Running servers apply the change within their token cache TTL.')
}

function describeRepos(repos: Record<string, TokenPermission>): string {
  const entries = Object.entries(repos).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
  return entries.length === 0 ? 'nothing' : entries.map(([pattern, permission]) => `${pattern}:${permission}`).join(', ')
}

function describe(token: TokenSummary, now: number): string {
  const expired = Date.parse(token.expiresAt) <= now ? ' (expired)' : ''
  return `${token.id}  ${token.name}  user ${token.user}  created ${token.createdAt}  expires ${token.expiresAt}${expired}  last used ${token.lastUsedAt ?? 'never'}`
}
