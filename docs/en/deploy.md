# Server mode

Most teams don't need a server: in the default mode, described in the [quick start](./guide/), each person's machine uploads assets straight to COS with their own sub-account key. Server mode is for teams that want to **issue and revoke access tokens centrally** instead of handing out COS keys.

In server mode you run `yunbox-server`, a small Git LFS server, and point the repository's `lfs.url` at it:

```text
git-lfs ──HTTPS──▶ yunbox-server ──▶ presigned PUT / GET ──▶ your private COS bucket
```

- The server only answers the LFS batch and verify requests and a health check. Assets still travel directly between git-lfs and COS through presigned URLs; they never pass through the server.
- Collaborators authenticate with tokens the server issues (`yunbox-server token create`, `token revoke`), each limited to the repositories it was granted.
- Token, grant, lock and audit records are kept in a document database (CloudBase in the reference deployment). Only SHA-256 hashes of tokens are stored.
- You can switch a repository from server mode to direct COS later; see [Migrating from GitHub LFS](./guide/migrate), which covers moving off any LFS server.

::: warning Only in Chinese for now
The full deployment guide targets Tencent CloudBase Run and is written in Chinese: image, configuration, least-privilege CAM policies, TLS and a launch checklist. Read it at [Deploying to CloudBase Run](/deploy) (in Chinese).
:::

Running the server locally and managing tokens are covered in the [English README](../../README.en.md#run-a-local-server).
