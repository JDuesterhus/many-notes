# Live collaboration E2E

The suite starts from an empty collaboration state for fresh notes, then drives
three real browser contexts against a local Laravel + Hocuspocus stack.

## Prerequisites

- PHP 8.4 with the project dependencies installed
- Node.js 22 (the Yjs server's `better-sqlite3` binary is built for it)
- Playwright Chromium installed
- The local app and Yjs service running:
  - `php artisan serve --host=127.0.0.1 --port=8000`
  - `node yjs-server/dist/index.js` with the values from `.env`

## Run

```bash
npm run test:e2e:collab
```

Useful environment variables:

```text
BASE_URL=http://127.0.0.1:8000
PHP_BIN=/path/to/php
MANY_NOTES_DB=/path/to/database/sqlite/database.sqlite
KEEP_LIVE_QA=1          # keep the generated vault for debugging
```

The suite creates a unique vault and four notes (`sync`, `empty`, `fidelity`,
`long`) through `seed-live-collaboration.php`, exercises rich/raw switching,
presence, blur/idle, reload, reconnect, concurrent typing, note switching,
empty-note persistence and long notes, then removes the vault unless
`KEEP_LIVE_QA=1` is set.

`seed-live-collaboration.php` and `cleanup-live-collaboration.php` can also be
run manually.
