<?php

declare(strict_types=1);

return [
    /*
    |--------------------------------------------------------------------------
    | Collaboration
    |--------------------------------------------------------------------------
    |
    | Yjs/Hocuspocus is the live source of truth for note content. Disable it
    | only for installations that intentionally keep the legacy full-document
    | editor; notes are read-only while collaboration is enabled but the
    | service is not configured correctly.
    |
    */

    'enabled' => (bool) env('YJS_ENABLED', false),

    /*
    |--------------------------------------------------------------------------
    | JWT
    |--------------------------------------------------------------------------
    |
    | This secret is shared with the Hocuspocus service. It must never reach
    | the browser. Tokens are short lived and are only sent over the
    | authenticated WebSocket connection.
    |
    */

    'jwt_secret' => (string) env('YJS_JWT_SECRET', ''),
    'jwt_issuer' => 'many-notes',
    'jwt_audience' => 'many-notes-yjs',
    'token_ttl' => (int) env('YJS_TOKEN_TTL', 300),

    /*
    |--------------------------------------------------------------------------
    | Internal service
    |--------------------------------------------------------------------------
    |
    | The Hocuspocus port is never exposed publicly. Laravel talks to it over
    | the internal network for document existence checks and access revocation.
    |
    */

    'internal_url' => (string) env('YJS_INTERNAL_URL', 'http://127.0.0.1:1234'),
    'internal_token' => (string) env('YJS_INTERNAL_TOKEN', ''),
    'internal_timeout' => (int) env('YJS_INTERNAL_TIMEOUT', 1),

    /*
    |--------------------------------------------------------------------------
    | Seed claim
    |--------------------------------------------------------------------------
    |
    | Existing Markdown notes are seeded into their first Yjs document by a
    | single client. The claim is an atomic lease so two clients opening the
    | same note cannot seed it twice.
    |
    */

    'seed_claim_ttl' => (int) env('YJS_SEED_CLAIM_TTL', 30),

    /*
    |--------------------------------------------------------------------------
    | Client URL
    |--------------------------------------------------------------------------
    |
    | Same-origin by default. Only the path is exposed to the browser, which
    | keeps the app wrapper friendly and avoids hard-coded container hosts.
    |
    */

    'public_url' => (string) env('VITE_YJS_URL', '/yjs'),
];
