# Live collaboration (Yjs / Hocuspocus)

Many Notes uses a dedicated Hocuspocus service for live note editing. Yjs is the
live source of truth while a note is open; Markdown remains the materialized
storage format used by search, backlinks, tags, the filesystem and exports.

## Architecture

```text
Browser A ── TipTap XML fragment + Markdown Y.Text ──┐
                                                     ├── HocuspocusProvider ── WSS /yjs ── Hocuspocus
Browser B ── raw Markdown editor + Markdown Y.Text ──┘                                      │
                                                                                             ├── yjs.sqlite (binary state)
                                                                                             │
Client debounced snapshot ── Markdown Y.Text ── Laravel ── vault_nodes.content + file
                                                                    │
                                                                    └── Typesense / backlinks / tags
```

- **Live truth:** the Yjs document for the open note. It contains the rich
  `default` XML fragment and a `markdown` Y.Text. Both represent the same note;
  a mode lease decides which representation may be edited at a given moment.
- **Materialized truth:** `vault_nodes.content` and the Markdown file on disk.
- **Metadata events:** Laravel Reverb still broadcasts tree, tag, notification,
  collaboration and snapshot-sequence events.
- **Never:** a full-document Reverb broadcast while a note is live.

### Components

| Component | Responsibility |
| --- | --- |
| `resources/js/composables/useCollaboration.ts` | Y.Doc, provider, token refresh, seed handshake, Markdown mirror, mode lease, snapshot scheduling, connection status |
| `resources/js/composables/useEditor.ts` | TipTap + Collaboration + CollaborationCaret |
| `resources/js/services/collaborationMarkdown.ts` | Minimal Markdown diff for Y.Text and the raw caret |
| `resources/js/components/vault/VaultFileNote.vue` | Rich/raw panes and the collaborative raw editor |
| `app/Http/Controllers/YjsTokenController.php` | Short-lived JWT for one note |
| `app/Http/Controllers/YjsSeedClaimController.php` | Atomic one-time seed lease |
| `app/Http/Controllers/VaultNodeSnapshotController.php` | Monotonic Markdown snapshots |
| `yjs-server/` | Hocuspocus service, binary persistence, authorization, revoke endpoint |
| `database/migrations/*create_collaboration_documents_table.php` | Snapshot sequence and seed bookkeeping |

## Room format

```text
vault:{vaultId}:node:{nodeId}
```

Examples: `vault:12:node:345`.

Both ids must be positive integers. The service rejects anything else, and the
client never gets to choose a room that differs from the one in its token.
Rooms are only allowed for `vault_nodes` rows with `is_file = 1` and
`extension = 'md'`. Folders, PDFs, images, videos and audio files are rejected.

## Authentication flow

1. The browser calls `POST /api/yjs/token` with `{ vault_id, node_id }` using its
   existing Laravel session and CSRF token.
2. Laravel checks:
   - the user is logged in;
   - `VaultPolicy@update` allows access to the vault;
   - the node exists **inside that vault** (scoped query, so cross-vault ids
     return 404);
   - the node is a Markdown file.
3. Laravel returns a five-minute HS256 JWT (`YJS_TOKEN_TTL`), the room,
   `snapshot_seq`, `seeded`, `yjs_state_exists` and the expiry time.
4. The provider sends the token only in the Hocuspocus authentication message,
   never in a query string or URL.
5. Hocuspocus verifies signature, `exp`, `iss` and `aud`, compares the token
   room with the requested document name, and re-checks the database:
   the user must still be the vault owner or an accepted collaborator, and the
   note must still belong to that vault and be a Markdown file.
6. Tokens are refreshed before expiry with `provider.sendToken()`. An expired
   token closes the connection with code `4401` and the client reconnects with a
   fresh token. A revoked collaborator is closed with code `4403`.
7. `POST /internal/revoke` (protected by `X-Internal-Token`) is called by
   `DeleteVaultCollaboration`. It closes every live connection for that user and
   vault immediately.

The internal service token is separate from user JWTs. Neither secret is ever
sent to the browser.

## Seed and recovery rules

Existing notes have Markdown but no Yjs state. The rules are:

1. If a Yjs document exists and is non-empty, Yjs wins. Markdown is
   re-materialized from it by the next snapshot.
2. If the Yjs document exists but is empty, the note is treated as intentionally
   empty; it is not seeded again.
3. If the Yjs document does not exist, the note is seeded from the current
   `vault_nodes.content`.
4. If both are missing, the note is empty.

The seed is a **one-time client seed with a server-side lease**:

- The first client that sees an empty Yjs document and no state calls
  `POST /api/yjs/seed-claim`.
- Laravel performs an atomic conditional update on
  `collaboration_documents.seed_claimed_at`. Only one client gets
  `claimed: true`.
- The winner writes the Markdown into both the rich XML fragment and the
  `markdown` Y.Text, sets the `many-notes-meta` `seeded` marker inside the
  Y.Doc, and calls `POST /api/yjs/seed-complete`.
- Other clients watch the marker/fragment/text and never seed a second copy.
- If the winner disappears before writing, the 30-second lease expires and
  another client can claim.
- `seed-complete` requires the claim id, so a client that lost the race cannot
  mark the document as seeded.

The Yjs document contains a `many-notes-meta` map with a `seeded` flag. This is
metadata only; it is not part of the note content.

Older documents may only contain the rich fragment. On open, the client derives
the missing `markdown` text from TipTap. A document that only has `markdown`
after a raw edit is parsed into the rich fragment before the editor is enabled.

## Markdown snapshots

Yjs is live, but the rest of the application needs Markdown. The client:

- keeps the shared `markdown` Y.Text in sync with TipTap and with the raw pane;
- snapshots that Y.Text (2-second debounce), so rich and raw edits take the
  same persistence path;
- sends `PATCH /api/vaults/{vault}/nodes/{node}/snapshot` with
  `{ content, base_seq }`;
- flushes immediately on blur, `visibilitychange` (via `sendBeacon`) and the
  final unmount;
- never snapshots on awareness-only changes;
- does not send a snapshot when the content is unchanged.

Laravel writes `vault_nodes.content`, the Markdown file, backlinks, tags and the
search index (`UpdateVaultNode`), then increments `snapshot_seq` and broadcasts a
metadata-only `VaultNodeSnapshotUpdatedEvent`.

### Stale snapshot protection

Every snapshot carries the last sequence the client saw. Laravel locks the
`collaboration_documents` row, compares `base_seq` with `snapshot_seq`, and:

- **accepts** only when they match, incrementing the sequence;
- **rejects with 409** when they differ, returning the current sequence and
  logging a warning. The client refreshes its sequence and retries with its
  current (already merged) Yjs content.

This is optimistic concurrency. A stale offline snapshot can never overwrite a
newer snapshot. Snapshots are only sent while the provider is synced, so a
client that reconnects cannot push stale content before syncing.

### Rename/move link rewrites

Renaming or moving a target rewrites link/image paths in backlink notes in the
database. Because a live note is sourced from Yjs, Laravel also broadcasts a
metadata-only `VaultNodeLinksRewrittenEvent`. Open editors apply the same path
rewrite to their link marks and image nodes, which produces a Yjs update; the
next Markdown snapshot therefore keeps the rewritten path instead of reverting
it. No note content is sent in this event.

### Export behavior

Vault export and the file on disk use the last accepted snapshot. Navigating
away from a note flushes the snapshot, so a normal export after closing the note
is current. If another tab is still editing, its debounced snapshot may not have
landed yet; the export reflects the last snapshot, not unflushed keystrokes. This
is intentional: exports never read an in-memory Yjs document from another
process.

## Presence

Awareness carries:

```js
{
  user: { id, name, initials, color },
  cursor: { anchor, head }, // rich mode only
  mode: 'rich' | 'raw',
  editing: true,
  editingSince: 1760000000000
}
```

`cursor.anchor` and `cursor.head` are Yjs relative positions. They encode both
the caret (`anchor === head`) and the selected range (`anchor !== head`); a
separate `selection` field would duplicate the same positions in every
awareness update, so V1 intentionally keeps the single `cursor` field.

- Colors are deterministic from the user id and use a palette readable in light
  and dark themes.
- The server overwrites client-supplied identity fields, so a client cannot
  impersonate another user.
- `CollaborationCaret` renders the colored caret, the name label above the
  caret and the selection highlight.
- The editor status row shows compact initials avatars for every connected
  user, with the full name as a tooltip.
- Color is never the only identifier: the name label and avatar tooltip are
  always available.
- In raw mode, the status row avatars and the read-only/locked notice carry
  presence; the raw pane does not draw in-text remote carets.
- Disconnecting removes the awareness state, caret and top avatar.

`editing` is a short lease (five seconds of inactivity) used to keep rich and raw
editors from writing over each other. A client may view the other mode, but it
is read-only while a user in the other mode is editing. Multiple users in the
same mode co-edit normally.

Awareness is never persisted. The Hocuspocus provider batches outgoing
document/awareness messages in an 80 ms window, which also throttles caret and
selection updates.

## Connection status

The editor shows one of:

- `Live` — connected and synced;
- `Connecting…` / `Reconnecting…`;
- `Offline – changes are kept locally` — edits stay in the local Y.Doc, no
  snapshot is attempted until reconnect;
- `No permission` — the token endpoint or server rejected access;
- `Session expired` — refresh the page or wait for the controlled reconnect;
- `Collaboration unavailable` — service or configuration problem.

Snapshot failures are shown in the same status row and retried. They are never
silently discarded.

## Raw Markdown mode

Raw Markdown is available for live notes. The toolbar toggle switches the same
Yjs note between:

- the rich TipTap pane, backed by the `default` XML fragment;
- the raw `contenteditable` pane, backed by the `markdown` Y.Text.

Both representations live in one Y.Doc. The rich editor writes its serialized
Markdown into `markdown`; the raw editor writes into `markdown`; the missing side
is projected before the note becomes editable. Automatic snapshots always read
`markdown`, so a note has one materialized representation regardless of which
pane is open.

Because Markdown and a rich document cannot be merged character-by-character
across representations, the note has a **mode edit lease**:

- multiple rich users can edit together;
- multiple raw users can edit together through `Y.Text`;
- a raw user and a rich user can view the same note at the same time, but only
  the lease owner may type;
- the other pane shows `Read only` with the owner's name and mode;
- the lease is released on blur or after five seconds without input.

Only one raw editor (the lowest awareness client id among active raw editors)
projects `markdown` into the rich fragment. Every raw client writing a full
fragment replacement would race and duplicate content; a single projector keeps
the rich view current while Y.Text remains the raw-side CRDT.

This prevents a full-document raw replacement from overwriting concurrent rich
edits. Installations with `YJS_ENABLED=false`, and non-Markdown files such as
`.txt`, keep the legacy raw editor and its existing save path.

## Deployment

### Environment

Laravel:

```dotenv
YJS_ENABLED=true
YJS_JWT_SECRET=<at least 32 random characters>
YJS_JWT_ISSUER=many-notes
YJS_JWT_AUDIENCE=many-notes-yjs
YJS_TOKEN_TTL=300
YJS_INTERNAL_URL=http://yjs:1234
YJS_INTERNAL_TOKEN=<a different random secret>
YJS_SEED_CLAIM_TTL=30
VITE_YJS_URL=/yjs
```

Hocuspocus:

```dotenv
YJS_PORT=1234
YJS_DB_PATH=/data/yjs.sqlite
LARAVEL_DB_PATH=/laravel-db/database.sqlite
YJS_JWT_SECRET=<same as Laravel>
YJS_INTERNAL_TOKEN=<same as Laravel>
YJS_STORE_DEBOUNCE=2000
YJS_STORE_MAX_DEBOUNCE=10000
```

Generate secrets with `openssl rand -hex 32`. `YJS_JWT_SECRET` and
`YJS_INTERNAL_TOKEN` are different secrets.

### Docker Compose

`compose.yaml` at the repository root starts the app, the Yjs service and an
Nginx proxy. Set `YJS_JWT_SECRET` and `YJS_INTERNAL_TOKEN` in the shell or a
`.env` file next to `compose.yaml`, and set `MANY_NOTES_IMAGE` to the image
built from this fork. The repository does not ship an app-image build pipeline;
the default `brufdev/many-notes:latest` contains upstream code, so build and tag
the fork image first (the existing upstream deployment pipeline can be reused).

```shell
export YJS_JWT_SECRET="$(openssl rand -hex 32)"
export YJS_INTERNAL_TOKEN="$(openssl rand -hex 32)"
docker compose up -d --build
```

The Yjs port `1234` is only exposed on the internal Docker network. The proxy
publishes `/yjs` and `/ws`; the app is on `http://localhost`.

The Yjs service reads `vault_nodes` and `user_vault` directly from the Laravel
SQLite database, mounted read-only. **SQLite is the supported database for the
direct authorization check in V1.** If you run MySQL/PostgreSQL, adapt
`yjs-server/src/storage.ts` to the same schema and set the connection
environment accordingly; see the limitations below.

Because the membership check is a read-only database query, V1 does not use a
`LARAVEL_INTERNAL_URL` callback. The service only needs the shared Yjs JWT secret
and the internal service token; it never needs the Laravel session or APP_KEY.

### Reverse proxy

`deploy/docker/nginx/many-notes-proxy.conf` is the complete compose proxy.
`deploy/docker/nginx/yjs.conf` is the equivalent snippet for an existing app
container proxy.

Nginx requirements:

```nginx
location /yjs {
    rewrite ^/yjs/?(.*)$ /$1 break;
    proxy_pass http://yjs:1234;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $http_host;
    proxy_set_header X-Forwarded-Host $http_host;
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
    proxy_buffering off;
}
```

Caddy:

```caddy
handle /yjs* {
    uri strip_prefix /yjs
    reverse_proxy yjs:1234
}
```

Cloudflare Tunnel: allow WebSockets for the hostname, route `/yjs` to the
Hocuspocus service (or to the app proxy), and test both `/ws` and `/yjs` after a
cold start. Use WSS under HTTPS. Do not enable response buffering on these
routes.

## Graceful degradation and offline behavior

- The provider reconnects with backoff and keeps the local Y.Doc in memory.
- No page reload is forced on disconnect.
- Local changes are never replaced by an older Reverb full-document event.
- An offline reload loses unsnapshotted in-memory Yjs edits. `y-indexeddb` is
  intentionally not enabled in V1 because it would keep note content in browser
  storage and require per-user cleanup on logout and note deletion. The status
  row warns that changes are local while offline.
- A service restart flushes pending stores on `SIGTERM` (`server.destroy()`), so
  a normal restart does not lose state. A hard crash within the store debounce
  window can lose the last few seconds; keep the debounce at the default 2 s.

## Known V1 limitations

- Only `.md` notes are collaborative. `.txt` notes keep the legacy editor and
  are not co-editable, matching the room/file restriction.
- Raw mode has no in-text remote carets; presence is shown by the status-row
  avatars and the mode lock notice.
- Rich and raw editing are mutually exclusive per note while a lease is active.
- Only SQLite is supported by the Hocuspocus authorization check out of the box.
- No read-only collaborator role; every accepted collaborator can edit.
- No public sharing, E2EE, comments or collaborative titles.
- Awareness is not persisted.
- No offline-first local database; offline edits survive only while the tab is
  open.
- The compose stack uses `CACHE_STORE=file` for a single app container. A
  multi-container/scale-out deployment must use a shared cache (for example
  Redis) instead.
- The final `sendBeacon` flush is subject to the browser's beacon payload limit;
  very large notes rely on the 2-second debounced snapshot for the last write.
- If a client is offline while a target file is renamed or moved, it can miss
  the metadata-only link rewrite event. Reload the open note after reconnecting
  before continuing to edit it.
- No Electron/Tauri/Capacitor wrapper yet.

## Wrapper readiness

- The frontend uses `VITE_YJS_URL` with a same-origin `/yjs` default; there are
  no container hostnames or `localhost` URLs in the browser bundle.
- The token endpoint is same-origin and uses the existing Laravel session.
- Authentication does not depend on third-party cookies or popups.
- HTTPS/WSS is required in production.
- The layout is usable at 360 px; presence labels are compact on small screens.
- The PWA manifest and service worker are unchanged. Note that the service
  worker only caches JS/CSS/images, never note content or Yjs state.

## Manual two-user test

1. Create two users and one vault owned by user A.
2. Invite user B to the vault and accept the invitation as B.
3. Open the same note as both users in two normal browser windows (not two tabs
   in the same profile, so awareness is independent).
4. Confirm the status shows `Live` in both windows.
5. Type in one window; the text appears in the other without a reload.
6. Move the cursor; the colored caret, its name label and the connected-user
   avatar appear in the other window.
7. Toggle Markdown in one window. The raw pane shows the same note with its
   Markdown syntax; type there and confirm the rich window updates live.
8. Switch that window back to rich text. It shows the raw edit. While the raw
   editor is active, the rich window must say `Read only` and name the raw
   editor; after blur or five seconds it becomes editable again.
9. Wait two seconds, then check `vault_nodes.content`, the Markdown file and the
   tags/backlinks panel.
10. Reload one window; the content must remain and must not be duplicated.
11. Stop the Yjs service, type in one window, restart the service, and confirm
    the edits merge after reconnect.
12. Remove user B from the vault; their status must change to `No permission`
    and the connection must close.

## Verification commands

```shell
# Laravel
php vendor/bin/pest --parallel
php vendor/bin/phpstan analyse --no-progress
php vendor/bin/pint --test

# Frontend
npm test
npm run lint
npm run format
npm run typecheck
npm run build

# Hocuspocus
cd yjs-server
npm run typecheck
npm test
```

## Verification performed for this fork

Environment: Windows for the build/test host, PHP 8.4.26, Node 22.23.3, SQLite,
Chromium via Playwright 1.62.1, plus the OMV NAS Docker host. PHP, Node and
Playwright were installed into a temporary tool directory for the run; they are
not committed.

| Check | Result |
| --- | --- |
| `composer analyse` (Rector, Pint, PHPCS, PHPStan level 10, type coverage) | passed; type coverage 100 % |
| `composer test` (Pest, parallel) | 213 passed, 555 assertions |
| `npm test` (Vitest, Markdown diff/merge) | 10 passed |
| `npm run lint` / `npm run format` / `npm run typecheck` / `npm run build` | passed |
| `yjs-server`: `npm run typecheck` | passed |
| `yjs-server`: `npm test` | 19 passed |
| Two/three-user Playwright E2E | 15/15 checks passed |
| Five-user concurrent editing | all five markers converged; one seed only |
| Large note (300 blocks) | opened in ~3.2 s; edits synced |
| Note switching (8 round trips between notes) | no page errors; 0 connections left after close |
| Yjs service restart | in-memory session and persisted state survived |
| Short token TTL | controlled reconnect, editor remained usable |
| Mobile viewport 390×844 | no horizontal overflow |
| Revoked collaborator | status `No permission`, editor read-only, other user unchanged |
| Both clients offline, both edit, reconnect | both edits merged, one seed only |
| Two users edit different paragraphs | both markers present in both editors |
| Raw Markdown on a live note | raw edits appeared in the rich pane; both raw users saw each other |
| Rich/raw mode lease | rich pane became read-only with the raw editor's name, then editable on release |
| Raw Markdown snapshot | `vault_nodes.content` and the Markdown file contained the raw edit |
| Disconnect removes presence | caret and top avatar disappeared for the remaining user |
| Large note (300 real blocks) | opened in ~1.5 s; edits synced |
| Live link rewrite on rename | open editor link changed to the renamed path; snapshot kept it |
| Live Typesense search after snapshot | unique phrase found the note |
| Vault ZIP export after snapshot | exported Markdown contained the phrase |
| NAS deployment (Docker Compose) | app + Yjs + Nginx proxy healthy at port 8070 |

Playwright checks covered: live typing in both directions, caret name labels,
connected-user avatars, rich/raw switching, raw Markdown co-editing, the
mode edit lease, database and file snapshots, reload, offline-edit/reconnect
merge, revoke, provider cleanup, service restart and token expiry.

### NAS deployment verification

The fork was deployed to the OMV NAS with Docker Compose:

- `many-notes:fork` (app), `many-notes-yjs:fork` (Hocuspocus) and an Nginx proxy.
- `docker compose up -d --build` completed; all three services are healthy.
- App `/up` returned `200`; `/yjs/health` returned `{"status":"ok"}`.
- Reverb WebSocket upgrades, Typesense health and the live Typesense search
  query were verified on the NAS.
- Production data was preserved: the existing `.env` was byte-identical, the
  SQLite integrity check returned `ok`, and users/vaults/nodes were unchanged.
- A test vault was used for the two-user, offline, large-note, search, export and
  revoke scenarios, then removed together with its Yjs document.

Remaining deployment caveat:

- **MySQL/PostgreSQL authorization query**: only SQLite was exercised. The
  Hocuspocus authorization check is written against the SQLite schema; see the
  limitation above.
