import { HocuspocusProvider } from '@hocuspocus/provider';
import Database from 'better-sqlite3';
import { SignJWT } from 'jose';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import * as Y from 'yjs';
import type { YjsServerConfig } from '../src/config.js';
import { createYjsServer, type RunningYjsServer } from '../src/server.js';

export interface TestEnvironment {
    directory: string;
    laravelDbPath: string;
    yjsDbPath: string;
    config: YjsServerConfig;
    running: RunningYjsServer;
    port: number;
    token: (userId: string, room: string, options?: TokenOptions) => Promise<string>;
    close: () => Promise<void>;
}

export interface TokenOptions {
    expiresIn?: string;
    issuer?: string;
    audience?: string;
    vaultId?: number;
    nodeId?: number;
}

export function createLaravelDatabase(path: string): void {
    const db = new Database(path);
    db.exec(`
        CREATE TABLE users (
            id INTEGER PRIMARY KEY,
            name TEXT NOT NULL
        );
        CREATE TABLE vaults (
            id INTEGER PRIMARY KEY,
            name TEXT NOT NULL,
            created_by INTEGER NOT NULL
        );
        CREATE TABLE vault_nodes (
            id INTEGER PRIMARY KEY,
            vault_id INTEGER NOT NULL,
            parent_id INTEGER,
            is_file INTEGER NOT NULL,
            name TEXT NOT NULL,
            extension TEXT
        );
        CREATE TABLE user_vault (
            user_id INTEGER NOT NULL,
            vault_id INTEGER NOT NULL,
            accepted INTEGER NOT NULL,
            PRIMARY KEY (user_id, vault_id, accepted)
        );
    `);

    db.prepare('INSERT INTO users (id, name) VALUES (?, ?)').run(1, 'Owner');
    db.prepare('INSERT INTO users (id, name) VALUES (?, ?)').run(2, 'Collaborator');
    db.prepare('INSERT INTO users (id, name) VALUES (?, ?)').run(3, 'Stranger');
    db.prepare('INSERT INTO users (id, name) VALUES (?, ?)').run(4, 'Other owner');

    db.prepare('INSERT INTO vaults (id, name, created_by) VALUES (?, ?, ?)').run(1, 'Vault A', 1);
    db.prepare('INSERT INTO vaults (id, name, created_by) VALUES (?, ?, ?)').run(2, 'Vault B', 4);

    db.prepare('INSERT INTO user_vault (user_id, vault_id, accepted) VALUES (?, ?, ?)').run(
        2,
        1,
        1
    );

    db.prepare(
        'INSERT INTO vault_nodes (id, vault_id, is_file, name, extension) VALUES (?, ?, ?, ?, ?)'
    ).run(10, 1, 1, 'note', 'md');
    db.prepare(
        'INSERT INTO vault_nodes (id, vault_id, is_file, name, extension) VALUES (?, ?, ?, ?, ?)'
    ).run(11, 1, 0, 'folder', null);
    db.prepare(
        'INSERT INTO vault_nodes (id, vault_id, is_file, name, extension) VALUES (?, ?, ?, ?, ?)'
    ).run(12, 1, 1, 'image', 'png');
    db.prepare(
        'INSERT INTO vault_nodes (id, vault_id, is_file, name, extension) VALUES (?, ?, ?, ?, ?)'
    ).run(20, 2, 1, 'other', 'md');

    db.close();
}

export async function startTestEnvironment(): Promise<TestEnvironment> {
    const directory = mkdtempSync(join(tmpdir(), 'many-notes-yjs-'));
    const laravelDbPath = join(directory, 'laravel.sqlite');
    const yjsDbPath = join(directory, 'yjs.sqlite');

    createLaravelDatabase(laravelDbPath);

    const config: YjsServerConfig = {
        host: '127.0.0.1',
        port: 0,
        dbPath: yjsDbPath,
        laravelDbPath,
        jwtSecret: 'test-jwt-secret-that-is-long-enough-for-hs256',
        jwtIssuer: 'many-notes',
        jwtAudience: 'many-notes-yjs',
        internalToken: 'test-internal-token-that-is-long-enough',
        debounce: 50,
        maxDebounce: 200,
    };

    const running = await createYjsServer(config);

    const token = async (
        userId: string,
        room: string,
        options: TokenOptions = {}
    ): Promise<string> => {
        const now = Math.floor(Date.now() / 1000);

        return new SignJWT({
            name: `User ${userId}`,
            vault_id: options.vaultId ?? 1,
            node_id: options.nodeId ?? 10,
            room,
            can_edit: true,
        })
            .setProtectedHeader({ alg: 'HS256' })
            .setSubject(userId)
            .setIssuedAt(now)
            .setExpirationTime(options.expiresIn ?? '5m')
            .setIssuer(options.issuer ?? config.jwtIssuer)
            .setAudience(options.audience ?? config.jwtAudience)
            .sign(new TextEncoder().encode(config.jwtSecret));
    };

    return {
        directory,
        laravelDbPath,
        yjsDbPath,
        config,
        running,
        port: running.port,
        token,
        close: async (): Promise<void> => {
            await running.close();
            rmSync(directory, { recursive: true, force: true });
        },
    };
}

export interface ConnectedClient {
    provider: HocuspocusProvider;
    document: Y.Doc;
    close: () => void;
}

export interface ConnectHandlers {
    onClose?: (code: number, reason: string) => void;
}

export function connect(
    port: number,
    room: string,
    token: string,
    document = new Y.Doc(),
    handlers: ConnectHandlers = {}
): Promise<ConnectedClient> {
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            provider.destroy();
            document.destroy();
            reject(new Error('Timed out while connecting to the Yjs server'));
        }, 5000);

        const provider = new HocuspocusProvider({
            url: `ws://127.0.0.1:${port}`,
            name: room,
            document,
            token,
            WebSocketPolyfill: WebSocket,
            onSynced: ({ state }) => {
                if (state) {
                    clearTimeout(timeout);
                    resolve({
                        provider,
                        document,
                        close: () => {
                            provider.destroy();
                            document.destroy();
                        },
                    });
                }
            },
            onAuthenticationFailed: ({ reason }) => {
                clearTimeout(timeout);
                provider.destroy();
                document.destroy();
                reject(new Error(`Authentication failed: ${reason}`));
            },
            onClose: ({ event }) => handlers.onClose?.(event.code, event.reason),
            onDisconnect: ({ event }) => handlers.onClose?.(event.code, event.reason),
        });
    });
}

export function waitFor(predicate: () => boolean, timeout = 5000, interval = 20): Promise<void> {
    return new Promise((resolve, reject) => {
        const started = Date.now();
        const timer = setInterval(() => {
            if (predicate()) {
                clearInterval(timer);
                resolve();
            } else if (Date.now() - started > timeout) {
                clearInterval(timer);
                reject(new Error('Timed out while waiting for a condition'));
            }
        }, interval);
    });
}
