# Many Notes Yjs service

Hocuspocus service for live note editing. The browser connects to it through
the app's reverse proxy at `/yjs`; the service port is internal.

## Local run

```shell
cp .env.example .env
# set YJS_JWT_SECRET and YJS_INTERNAL_TOKEN (same values as Laravel)
npm ci
npm run dev
```

The Laravel database defaults to `../database/sqlite/database.sqlite`. The Yjs
binary state is stored separately in `YJS_DB_PATH` (SQLite, WAL mode).

## Scripts

- `npm run dev` — watch mode with `tsx`
- `npm run build` — compile TypeScript to `dist/`
- `npm start` — run the compiled service
- `npm run typecheck` — TypeScript check
- `npm test` — Vitest integration tests (real WebSocket clients, temp databases)

## Endpoints

- `GET /health` — liveness and document/connection counts
- `GET /internal/documents/exists?name=...` — requires `X-Internal-Token`
- `DELETE /internal/documents` — requires `X-Internal-Token`
- `POST /internal/revoke` — requires `X-Internal-Token`; closes a user's live
  connections for a vault

Read `../docs/collaboration.md` for the full architecture, authentication, seed
and snapshot rules.
