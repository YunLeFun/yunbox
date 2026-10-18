import type { CosCredentials } from '@yunbox/core'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Buffer } from 'node:buffer'
import { randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { signTc3 } from '../src/cos/tencent-api.ts'

export interface FakeCamUser {
  Uin: number
  Name: string
  Remark: string
  keys: CosCredentials
  policies: number[]
}

export interface FakeCamPolicy {
  PolicyId: number
  PolicyName: string
  Description: string
  PolicyDocument: string
}

/**
 * Minimal CAM (API 3.0) double. Every request must be signed (TC3) with the
 * administrator keys; the state is in memory so tests can inspect it.
 */
export class FakeCamServer {
  readonly users = new Map<string, FakeCamUser>()
  readonly policies = new Map<number, FakeCamPolicy>()
  readonly actions: string[] = []
  /** Called with the keys of every new sub-account, e.g. to let a fake COS accept them. */
  onKeysCreated: (keys: CosCredentials) => void = () => {}
  /** Make the next call to this action fail, to test cleanup. */
  failNext: string | undefined
  origin = ''
  readonly #admin: CosCredentials
  #nextId = 100
  readonly #server = createServer((request, response) => {
    void this.#handle(request, response)
  })

  constructor(admin: CosCredentials) {
    this.#admin = admin
  }

  async start(): Promise<this> {
    await new Promise<void>(resolve => this.#server.listen(0, '127.0.0.1', resolve))
    this.origin = `http://127.0.0.1:${(this.#server.address() as AddressInfo).port}`
    return this
  }

  async close(): Promise<void> {
    this.#server.closeAllConnections()
    await new Promise<void>(resolve => this.#server.close(() => resolve()))
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const chunks: Buffer[] = []
    for await (const chunk of request)
      chunks.push(Buffer.from(chunk as Uint8Array))
    const payload = Buffer.concat(chunks).toString('utf8')
    const action = String(request.headers['x-tc-action'])
    const reply = (body: Record<string, unknown>): void => {
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ Response: { ...body, RequestId: 'fake' } }))
    }
    const fail = (code: string, message: string): void => reply({ Error: { Code: code, Message: message } })

    const expected = signTc3({ credentials: this.#admin, service: 'cam', host: String(request.headers.host), action, payload, timestamp: Number(request.headers['x-tc-timestamp']) })
    if (request.headers.authorization !== expected || request.headers['x-tc-token'] !== this.#admin.sessionToken) {
      fail('AuthFailure.SignatureFailure', 'signature mismatch')
      return
    }
    this.actions.push(action)
    if (this.failNext === action) {
      this.failNext = undefined
      fail('InternalError', 'injected failure')
      return
    }
    const params = JSON.parse(payload) as Record<string, any>
    const byUin = (uin: number): FakeCamUser | undefined => [...this.users.values()].find(user => user.Uin === uin)
    switch (action) {
      case 'GetUser': {
        const user = this.users.get(params.Name)
        if (user === undefined)
          return fail('ResourceNotFound.UserNotExist', 'user not exist')
        return reply({ Uin: user.Uin, Name: user.Name, Remark: user.Remark })
      }
      case 'AddUser': {
        const keys = { secretId: `AKID${randomBytes(16).toString('hex')}`, secretKey: randomBytes(16).toString('hex') }
        const user: FakeCamUser = { Uin: this.#nextId++, Name: params.Name, Remark: params.Remark ?? '', keys, policies: [] }
        this.users.set(user.Name, user)
        this.onKeysCreated(keys)
        return reply({ Uin: user.Uin, Name: user.Name, SecretId: keys.secretId, SecretKey: keys.secretKey })
      }
      case 'CreatePolicy': {
        if ([...this.policies.values()].some(policy => policy.PolicyName === params.PolicyName))
          return fail('InvalidParameter.PolicyNameInUse', 'policy name in use')
        const policy = { PolicyId: this.#nextId++, PolicyName: params.PolicyName, Description: params.Description, PolicyDocument: params.PolicyDocument }
        this.policies.set(policy.PolicyId, policy)
        return reply({ PolicyId: policy.PolicyId })
      }
      case 'ListPolicies':
        return reply({ List: [...this.policies.values()].filter(policy => policy.PolicyName.includes(params.Keyword ?? '')).map(({ PolicyDocument: _, ...rest }) => rest) })
      case 'AttachUserPolicy': {
        const user = byUin(params.AttachUin)
        if (user === undefined || !this.policies.has(params.PolicyId))
          return fail('ResourceNotFound.NotExist', 'not exist')
        if (!user.policies.includes(params.PolicyId))
          user.policies.push(params.PolicyId)
        return reply({})
      }
      case 'ListUsers':
        return reply({ Data: [...this.users.values()].map(user => ({ Uin: user.Uin, Name: user.Name, Remark: user.Remark })) })
      case 'ListAttachedUserPolicies': {
        const user = byUin(params.TargetUin)
        // Like the real API: no Description here, GetPolicy has it.
        return reply({ List: (user?.policies ?? []).map(id => this.policies.get(id)!).map(policy => ({ PolicyId: String(policy.PolicyId), PolicyName: policy.PolicyName })) })
      }
      case 'GetPolicy': {
        const policy = this.policies.get(params.PolicyId)
        if (policy === undefined)
          return fail('ResourceNotFound.PolicyIdNotExist', 'policy not exist')
        return reply({ PolicyName: policy.PolicyName, Description: policy.Description, PolicyDocument: policy.PolicyDocument })
      }
      case 'DeleteUser':
        this.users.delete(params.Name)
        return reply({})
      case 'DeletePolicy':
        for (const id of params.PolicyId as number[])
          this.policies.delete(id)
        return reply({})
      default:
        return fail('InvalidAction', action)
    }
  }
}
