# file2url

An MCP server on Cloudflare Workers that turns any file (images, video, audio, PDFs, archives, text, anything) into a short, temporary, public download link.

- Files are stored on UploadThing.
- Metadata is stored in Cloudflare D1.
- A cron job runs every 10 minutes and deletes expired files.

**MCP endpoint** (Streamable HTTP, stateless): `https://file2url.campusloop.workers.dev/mcp`

Short links look like `https://file2url.campusloop.workers.dev/Ab3xK9q.png`. Append `?download=1` to force a download.

## Authentication: bring your own UploadThing account

Pass your own `UPLOADTHING_TOKEN` (the base64 token from the UploadThing dashboard, under API Keys). Uploads then go to your UploadThing app, and you only see and manage your own files.

There are three equivalent ways to pass it:

| Method | Value |
|---|---|
| Header | `Authorization: Bearer <UPLOADTHING_TOKEN>` |
| Header | `x-api-key: <UPLOADTHING_TOKEN>` |
| URL query | `https://file2url.campusloop.workers.dev/mcp?token=<UPLOADTHING_TOKEN>` |

Use the query form for clients that cannot set headers, such as Claude.ai custom connectors.

- With no token, the server's shared default account is used. Anyone can list or delete those files, so use it only for throwaway files.
- Tokens are never returned to the model.
- To auto-delete expired files later, the server stores your app's API key encrypted (AES-GCM) in D1.

## Connect a client

**Claude Code**

```bash
claude mcp add --transport http file2url https://file2url.campusloop.workers.dev/mcp --header "Authorization: Bearer <UPLOADTHING_TOKEN>"
```

**Claude.ai / Claude Desktop** (custom connector): Settings -> Connectors -> Add custom connector, with URL:

```
https://file2url.campusloop.workers.dev/mcp?token=<UPLOADTHING_TOKEN>
```

**Composio**: add a custom MCP server with URL `https://file2url.campusloop.workers.dev/mcp`, auth type "API key / Bearer token", and value `<UPLOADTHING_TOKEN>`.

**Cursor, VS Code, and other JSON-configured clients**:

```json
{
  "mcpServers": {
    "file2url": {
      "url": "https://file2url.campusloop.workers.dev/mcp",
      "headers": { "Authorization": "Bearer <UPLOADTHING_TOKEN>" }
    }
  }
}
```

## Tools

| Tool | What it does | Key params |
|---|---|---|
| `upload_from_url` | Copy a file from a public URL. Streamed, so large videos work (up to 512 MB). | `url`, `filename?`, `content_type?`, `headers?`, `expires_in?`, `max_downloads?` |
| `upload_text` | Save text (markdown, JSON, CSV, HTML, code) as a file | `content`, `filename`, `content_type?`, `expires_in?`, `max_downloads?` |
| `upload_base64` | Upload a small binary as base64 or a `data:` URL (a few MB max) | `data`, `filename`, `content_type?`, `expires_in?`, `max_downloads?` |
| `create_upload_url` | Returns a ready-to-run curl command for a local file of any type (up to 100 MB). The JSON reply contains the link. | `filename`, `expires_in?`, `max_downloads?` |
| `get_file` | Links, size, type, expiry, and download count for one file | `file` |
| `list_files` | Live files, newest first | `limit?`, `offset?` |
| `delete_files` | Delete one or more files immediately | `files` (array) |
| `update_file` | Change expiry (counted from now), download limit, or filename | `file`, `expires_in?`, `max_downloads?`, `filename?` |
| `get_usage` | Storage used and limit, plus server limits | none |

- `headers` on `upload_from_url` are sent to the source URL, and only to its own origin.
- `file` accepts the short link, the id, the `direct_url`, or the storage key.

## Options

**`expires_in`** accepts `10m`, `1h`, `1d`, `1w`, `30d`, plain seconds, or `never`. The default is `1d`. The minimum is 60 seconds and the maximum is 365 days.

**`max_downloads`** stops serving the short link after N downloads. `1` means burn after reading. Files with a limit are always served whole.

Every upload returns:

| Field | Meaning |
|---|---|
| `url` | Short link |
| `download_url` | Same link, forces a download |
| `direct_url` | UploadThing CDN link. Fast, but not covered by `max_downloads`, and it stays up until the cron deletes the file. |
| `filename`, `content_type`, `size` | File metadata |
| `expires_at`, `expires_in` | When the file is deleted |

HTML, SVG, XML, and scripts are always served as downloads and never rendered.

## Direct HTTP upload (no MCP)

Stream a file of up to 100 MB:

```bash
curl -T ./video.mp4 "https://file2url.campusloop.workers.dev/upload/video.mp4?expires_in=1w" -H "Authorization: Bearer <UPLOADTHING_TOKEN>"
```

Multipart form upload, for files up to 16 MB:

```bash
curl -F file=@./photo.png -F expires_in=1h https://file2url.campusloop.workers.dev/upload
```

Response shape:

```json
{
  "success": true,
  "data": {
    "url": "https://file2url.campusloop.workers.dev/Ab3xK9q.png",
    "download_url": "https://file2url.campusloop.workers.dev/Ab3xK9q.png?download=1",
    "direct_url": "https://<uploadthing CDN link>",
    "expires_at": "2026-11-13T12:00:00.000Z"
  }
}
```

## Limits

| Path | Limit |
|---|---|
| URL import (`upload_from_url`) | 512 MB (`MAX_FILE_MB`) |
| Direct upload (`/upload/<name>`) | 100 MB (Cloudflare request limit) |
| Inline text and base64 (per call) | About 8 MB (12 MB request body) |
| Multipart upload (`/upload`) | 16 MB |

## Self-hosting

1. Install dependencies: `npm install`
2. Create the D1 database: `npx wrangler d1 create file2url`. Put the returned `database_id` into `wrangler.jsonc`.
3. Apply migrations: `npm run db:migrate`
4. Optional shared default account: `npx wrangler secret put UPLOADTHING_TOKEN`. Omit this to require every caller to bring their own token.
5. Required: `npx wrangler secret put TOKEN_ENCRYPTION_KEY`. Use any long random string, for example from `openssl rand -base64 32`. It encrypts stored API keys and signs upload tickets.
6. Deploy: `npm run deploy`

Config vars in `wrangler.jsonc`:

| Var | Purpose |
|---|---|
| `DEFAULT_EXPIRY` | Expiry used when a call omits `expires_in` (default `"1d"`) |
| `MAX_FILE_MB` | Largest accepted file in MB (default `"512"`) |
| `PUBLIC_BASE_URL` | Optional custom domain used in links |

## Development

```bash
npm test               # run the test suite (vitest)
npm run test:coverage  # tests with coverage
npm run typecheck      # tsc --noEmit
npm run dev            # wrangler dev (local server)
```

Project layout: `src/index.ts` (routing, auth, cron), `src/mcp.ts` (tools), `src/service.ts` (upload, lookup, delete logic), `src/http.ts` (download proxy and direct upload), `src/store.ts` (D1), `src/uploadthing.ts` (storage client), `src/cleanup.ts` (expiry cron), `src/crypto.ts` (encryption), `src/util.ts` (helpers).

## Security notes

- Your account is tied to the secret API key inside your token, not to the app id (app ids are public). Rotating the key starts a fresh, empty file list.
- A token passed as `?token=` is part of the URL and can end up in logs; prefer the `Authorization` header where the client allows it.

- There is no rate limiting.
- The shared default account is open to everyone.
- Links use unguessable 7-character random ids, but anyone who has a link can download the file.
- Do not upload secrets. Files are not encrypted for you, and anyone with the link can read them.
