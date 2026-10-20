import { Database } from '@hocuspocus/extension-database';
import {
    Server,
    type Connection,
    type onAuthenticatePayload,
    type onRequestPayload,
    type onTokenSyncPayload,
} from '@hocuspocus/server';
import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
    contextFromClaims,
    verifyToken,
    type ConnectionContext,
    type TokenClaims,
} from './auth.js';
import { assertConfig, type YjsServerConfig } from './config.js';
import { presenceUser } from './presence.js';
import { parseRoom } from './room.js';
import { Storage } from './storage.js';

interface InternalBody {
    name?: unknown;
    vault_id?: unknown;
    user_id?: unknown;
}

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
    const body = JSON.stringify(payload);

    response.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
        'Cache-Control': 'no-store',
    });
    response.end(body);
}

function readBody(request: IncomingMessage, limit = 1024 * 1024): Promise<string> {
    return new Promise((resolve, reject) => {
        let size = 0;
        const chunks: Buffer[] = [];

        request.on('data', (chunk: Buffer) => {
            size += chunk.length;

            if (size > limit) {
                reject(new Error('Request body too large'));
                request.destroy();

                return;
            }

            chunks.push(chunk);
        });

        request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        request.on('error', reject);
    });
}

function readJsonBody<T>(request: IncomingMessage): Promise<T | null> {
    return readBody(request).then(body => {
        if (body.trim() === '') {
            return null;
        }

        try {
            return JSON.parse(body) as T;
        } catch {
            return null;
        }
    });
}

function safeEqual(a: string, b: string): boolean {
    const first = Buffer.from(a);
    const second = Buffer.from(b);

    return first.length === second.length && timingSafeEqual(first, second);
}

function closeEvent(code: number, reason: string): Error {
    return Object.assign(new Error(reason), { code, reason });
}

export interface RunningYjsServer {
    server: Server<ConnectionContext>;
    storage: Storage;
    port: number;
    close: () => Promise<void>;
}

export async function createYjsServer(config: YjsServerConfig): Promise<RunningYjsServer> {
    assertConfig(config);

    const storage = new Storage(config.dbPath, config.laravelDbPath);
    const activeConnections = new Map<string, Connection<ConnectionContext>>();
    const expiryTimers = new Map<string, NodeJS.Timeout>();

    const scheduleExpiry = (
        key: string,
        connection: Connection<ConnectionContext>,
        expiresAt: number
    ): void => {
        const existing = expiryTimers.get(key);

        if (existing) {
            clearTimeout(existing);
        }

        expiryTimers.set(
            key,
            setTimeout(
                () => {
                    expiryTimers.delete(key);
                    connection.webSocket.close(4401, 'token-expired');
                },
                Math.max(0, expiresAt - Date.now())
            )
        );
    };

    const authenticate = async (
        token: string,
        documentName: string
    ): Promise<{ claims: TokenClaims; context: ConnectionContext } | null> => {
        const claims = await verifyToken(token, config);

        if (claims === null) {
            return null;
        }

        const room = parseRoom(documentName);

        if (room === null || claims.room !== documentName) {
            return null;
        }

        if (claims.vault_id !== room.vaultId || claims.node_id !== room.nodeId) {
            return null;
        }

        const userId = Number.parseInt(claims.sub, 10);

        if (!storage.isAuthorized(userId, room.vaultId, room.nodeId)) {
            return null;
        }

        return { claims, context: contextFromClaims(claims) };
    };

    const server = new Server<ConnectionContext>({
        name: 'many-notes-yjs',
        address: config.host,
        port: config.port,
        quiet: true,
        stopOnSignals: false,
        debounce: config.debounce,
        maxDebounce: config.maxDebounce,
        extensions: [
            new Database({
                fetch: async ({ documentName }) => storage.fetchDocument(documentName),
                store: async ({ documentName, state }) => {
                    storage.storeDocument(documentName, state);
                },
            }),
        ],

        async onAuthenticate({
            token,
            documentName,
            connectionConfig,
        }: onAuthenticatePayload<ConnectionContext>): Promise<ConnectionContext> {
            const result = await authenticate(token, documentName);

            if (result === null) {
                throw new Error('Not authorized');
            }

            connectionConfig.readOnly = !result.context.user.canEdit;

            return result.context;
        },

        async onTokenSync({
            token,
            documentName,
            context,
            connectionConfig,
            connection,
            socketId,
        }: onTokenSyncPayload<ConnectionContext>): Promise<ConnectionContext> {
            const result = await authenticate(token, documentName);

            if (result === null || result.context.user.id !== context.user.id) {
                throw closeEvent(4401, 'token-expired');
            }

            context.expiresAt = result.context.expiresAt;
            context.user.canEdit = result.context.user.canEdit;
            connectionConfig.readOnly = !context.user.canEdit;
            scheduleExpiry(`${socketId}:${documentName}`, connection, context.expiresAt);

            return context;
        },

        async beforeHandleMessage({ context }): Promise<void> {
            if (Date.now() >= context.expiresAt) {
                throw closeEvent(4401, 'token-expired');
            }
        },

        async beforeHandleAwareness({ states, context }): Promise<void> {
            if (!context) {
                return;
            }

            const user = presenceUser(String(context.user.id), context.user.name);

            // Never trust client-supplied identity fields.
            for (const state of states.values()) {
                state.user = user;

                if (!context.user.canEdit) {
                    delete state.cursor;
                }
            }
        },

        async connected({ socketId, documentName, context, connection }): Promise<void> {
            const key = `${socketId}:${documentName}`;
            activeConnections.set(key, connection);
            scheduleExpiry(key, connection, context.expiresAt);
        },

        async onDisconnect({ socketId, documentName }): Promise<void> {
            const key = `${socketId}:${documentName}`;
            const timer = expiryTimers.get(key);

            if (timer) {
                clearTimeout(timer);
                expiryTimers.delete(key);
            }

            activeConnections.delete(key);
        },

        async onRequest({ request, response }: onRequestPayload): Promise<void> {
            const url = new URL(request.url ?? '/', 'http://internal');
            const isHealth = request.method === 'GET' && url.pathname === '/health';

            if (isHealth) {
                try {
                    sendJson(response, 200, {
                        status: 'ok',
                        documents: storage.documentCount(),
                        connections: activeConnections.size,
                    });
                } catch {
                    sendJson(response, 503, { status: 'unavailable' });
                }

                throw undefined;
            }

            if (!url.pathname.startsWith('/internal/')) {
                return;
            }

            const providedToken = request.headers['x-internal-token'];
            const token = Array.isArray(providedToken) ? providedToken[0] : providedToken;

            if (typeof token !== 'string' || !safeEqual(token, config.internalToken)) {
                sendJson(response, 401, { message: 'Unauthorized' });
                throw undefined;
            }

            if (request.method === 'GET' && url.pathname === '/internal/documents/exists') {
                const name = url.searchParams.get('name') ?? '';

                if (parseRoom(name) === null) {
                    sendJson(response, 422, { message: 'Invalid document name' });
                } else {
                    sendJson(response, 200, { exists: storage.documentExists(name) });
                }

                throw undefined;
            }

            if (request.method === 'POST' && url.pathname === '/internal/revoke') {
                const body = await readJsonBody<InternalBody>(request);

                if (
                    body === null ||
                    !Number.isSafeInteger(body.vault_id) ||
                    !Number.isSafeInteger(body.user_id)
                ) {
                    sendJson(response, 422, { message: 'Invalid request' });
                    throw undefined;
                }

                const vaultId = body.vault_id as number;
                const userId = body.user_id as number;
                let revoked = 0;

                for (const [socketId, connection] of activeConnections) {
                    if (
                        connection.context.user.vaultId === vaultId &&
                        connection.context.user.id === userId
                    ) {
                        const timer = expiryTimers.get(socketId);

                        if (timer) {
                            clearTimeout(timer);
                            expiryTimers.delete(socketId);
                        }

                        connection.webSocket.close(4403, 'access-revoked');
                        activeConnections.delete(socketId);
                        revoked += 1;
                    }
                }

                sendJson(response, 200, { revoked });
                throw undefined;
            }

            if (request.method === 'DELETE' && url.pathname === '/internal/documents') {
                const body = await readJsonBody<InternalBody>(request);
                const name = typeof body?.name === 'string' ? body.name : '';

                if (parseRoom(name) === null) {
                    sendJson(response, 422, { message: 'Invalid document name' });
                } else {
                    sendJson(response, 200, { deleted: storage.deleteDocument(name) });
                }

                throw undefined;
            }

            sendJson(response, 404, { message: 'Not found' });
            throw undefined;
        },
    });

    await server.listen(config.port);

    let closed = false;

    return {
        server,
        storage,
        port: server.address.port,
        close: async (): Promise<void> => {
            if (closed) {
                return;
            }

            closed = true;

            for (const timer of expiryTimers.values()) {
                clearTimeout(timer);
            }

            expiryTimers.clear();
            await server.destroy();
            storage.close();
        },
    };
}
