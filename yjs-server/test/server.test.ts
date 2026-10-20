import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { createYjsServer } from '../src/server.js';
import { connect, startTestEnvironment, waitFor, type TestEnvironment } from './helpers.js';

const environments: TestEnvironment[] = [];

async function environment(): Promise<TestEnvironment> {
    const env = await startTestEnvironment();
    environments.push(env);

    return env;
}

afterEach(async () => {
    while (environments.length > 0) {
        const env = environments.pop();

        if (env) {
            await env.close().catch(() => {});
        }
    }
});

describe('authentication', () => {
    it('connects a valid token', async () => {
        const env = await environment();
        const room = 'vault:1:node:10';
        const token = await env.token('1', room);
        const client = await connect(env.port, room, token);

        expect(client.provider.isAuthenticated).toBe(true);
        client.close();
    });

    it('rejects an invalid token', async () => {
        const env = await environment();

        await expect(connect(env.port, 'vault:1:node:10', 'not-a-token')).rejects.toThrow(
            /Authentication failed/
        );
    });

    it('rejects an expired token', async () => {
        const env = await environment();
        const token = await env.token('1', 'vault:1:node:10', { expiresIn: '-10s' });

        await expect(connect(env.port, 'vault:1:node:10', token)).rejects.toThrow(
            /Authentication failed/
        );
    });

    it('rejects a wrong issuer and audience', async () => {
        const env = await environment();
        const wrongIssuer = await env.token('1', 'vault:1:node:10', { issuer: 'other' });
        const wrongAudience = await env.token('1', 'vault:1:node:10', {
            audience: 'other',
        });

        await expect(connect(env.port, 'vault:1:node:10', wrongIssuer)).rejects.toThrow(
            /Authentication failed/
        );
        await expect(connect(env.port, 'vault:1:node:10', wrongAudience)).rejects.toThrow(
            /Authentication failed/
        );
    });

    it('closes an active connection when its token expires', async () => {
        const env = await environment();
        const room = 'vault:1:node:10';
        let resolveClosed: (code: number) => void = () => {};
        const closed = new Promise<number>(resolve => {
            resolveClosed = resolve;
        });

        await connect(env.port, room, await env.token('1', room, { expiresIn: '1s' }), undefined, {
            onClose: code => resolveClosed(code),
        });

        await expect(closed).resolves.toBe(4401);
    });

    it('rejects a token whose room differs from the requested document', async () => {
        const env = await environment();
        const token = await env.token('1', 'vault:1:node:10');

        await expect(connect(env.port, 'vault:1:node:12', token)).rejects.toThrow(
            /Authentication failed/
        );
    });

    it('rejects a folder note', async () => {
        const env = await environment();
        const token = await env.token('1', 'vault:1:node:11');

        await expect(connect(env.port, 'vault:1:node:11', token)).rejects.toThrow(
            /Authentication failed/
        );
    });

    it('rejects a cross-vault note even with a matching room', async () => {
        const env = await environment();
        const token = await env.token('1', 'vault:2:node:20', {
            vaultId: 2,
            nodeId: 20,
        });

        await expect(connect(env.port, 'vault:2:node:20', token)).rejects.toThrow(
            /Authentication failed/
        );
    });

    it('rejects an accepted collaborator from another vault', async () => {
        const env = await environment();
        const token = await env.token('2', 'vault:2:node:20', {
            vaultId: 2,
            nodeId: 20,
        });

        await expect(connect(env.port, 'vault:2:node:20', token)).rejects.toThrow(
            /Authentication failed/
        );
    });
});

describe('collaboration', () => {
    it('syncs two clients in the same room', async () => {
        const env = await environment();
        const room = 'vault:1:node:10';
        const first = await connect(env.port, room, await env.token('1', room));
        const second = await connect(env.port, room, await env.token('2', room));

        first.document.getText('content').insert(0, 'Hello from the owner');

        await waitFor(
            () => second.document.getText('content').toString() === 'Hello from the owner'
        );

        expect(first.document.getText('content').toString()).toBe('Hello from the owner');

        first.close();
        second.close();
    });

    it('merges concurrent edits without overwriting', async () => {
        const env = await environment();
        const room = 'vault:1:node:10';
        const first = await connect(env.port, room, await env.token('1', room));
        const second = await connect(env.port, room, await env.token('2', room));

        first.document.getText('content').insert(0, 'A');
        second.document.getText('content').insert(0, 'B');

        await waitFor(() => {
            const text = first.document.getText('content').toString();

            return text.includes('A') && text.includes('B');
        });

        const text = first.document.getText('content').toString();
        expect(text).toHaveLength(2);
        expect(text).toContain('A');
        expect(text).toContain('B');

        first.close();
        second.close();
    });

    it('removes presence when a client disconnects', async () => {
        const env = await environment();
        const room = 'vault:1:node:10';
        const first = await connect(env.port, room, await env.token('1', room));
        const second = await connect(env.port, room, await env.token('2', room));

        first.provider.setAwarenessField('user', { name: 'Owner', color: '#2563eb' });
        second.provider.setAwarenessField('user', {
            name: 'Collaborator',
            color: '#c2410c',
        });

        await waitFor(() => (second.provider.awareness?.getStates().size ?? 0) >= 2);

        first.close();

        await waitFor(() => (second.provider.awareness?.getStates().size ?? 0) === 1);

        second.close();
    });
});

describe('persistence', () => {
    it('stores the Yjs state and restores it after a restart', async () => {
        const env = await environment();
        const room = 'vault:1:node:10';
        const client = await connect(env.port, room, await env.token('1', room));

        client.document.getText('content').insert(0, 'Persisted content');

        await waitFor(() => env.running.storage.documentExists(room));
        client.close();
        await env.running.close();

        const restarted = await createYjsServer({ ...env.config, port: 0 });

        try {
            const restored = await connect(restarted.port, room, await env.token('1', room));

            await waitFor(
                () => restored.document.getText('content').toString() === 'Persisted content'
            );

            expect(restored.document.getText('content').toString()).toBe('Persisted content');
            restored.close();
        } finally {
            await restarted.close();
        }
    });

    it('stores a TipTap compatible XML fragment', async () => {
        const env = await environment();
        const room = 'vault:1:node:10';
        const client = await connect(env.port, room, await env.token('1', room));
        const paragraph = new Y.XmlElement('paragraph');
        paragraph.insert(0, [new Y.XmlText('Hello')]);
        client.document.getXmlFragment('default').insert(0, [paragraph]);

        await waitFor(() => env.running.storage.documentExists(room));
        const state = env.running.storage.fetchDocument(room);

        expect(state).not.toBeNull();

        const replay = new Y.Doc();
        Y.applyUpdate(replay, state!);

        expect(replay.getXmlFragment('default').length).toBe(1);

        client.close();
        replay.destroy();
    });
});

describe('internal endpoints', () => {
    it('reports health', async () => {
        const env = await environment();
        const response = await fetch(`http://127.0.0.1:${env.port}/health`);
        const payload = (await response.json()) as { status: string };

        expect(response.status).toBe(200);
        expect(payload.status).toBe('ok');
    });

    it('requires the internal token', async () => {
        const env = await environment();
        const response = await fetch(
            `http://127.0.0.1:${env.port}/internal/documents/exists?name=vault:1:node:10`
        );

        expect(response.status).toBe(401);
    });

    it('reports whether a document exists', async () => {
        const env = await environment();
        const response = await fetch(
            `http://127.0.0.1:${env.port}/internal/documents/exists?name=vault:1:node:10`,
            {
                headers: { 'X-Internal-Token': env.config.internalToken },
            }
        );
        const payload = (await response.json()) as { exists: boolean };

        expect(response.status).toBe(200);
        expect(payload.exists).toBe(false);
    });

    it('deletes a document', async () => {
        const env = await environment();
        const room = 'vault:1:node:10';
        const client = await connect(env.port, room, await env.token('1', room));
        client.document.getText('content').insert(0, 'To delete');
        await waitFor(() => env.running.storage.documentExists(room));
        client.close();

        const response = await fetch(`http://127.0.0.1:${env.port}/internal/documents`, {
            method: 'DELETE',
            headers: {
                'Content-Type': 'application/json',
                'X-Internal-Token': env.config.internalToken,
            },
            body: JSON.stringify({ name: room }),
        });

        expect(response.status).toBe(200);
        expect(env.running.storage.documentExists(room)).toBe(false);
    });

    it('revokes only the matching user', async () => {
        const env = await environment();
        const room = 'vault:1:node:10';
        let resolveClosed: (code: number) => void = () => {};
        const closed = new Promise<number>(resolve => {
            resolveClosed = resolve;
        });
        const _owner = await connect(env.port, room, await env.token('1', room), undefined, {
            onClose: code => resolveClosed(code),
        });
        const collaborator = await connect(env.port, room, await env.token('2', room));

        const response = await fetch(`http://127.0.0.1:${env.port}/internal/revoke`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Internal-Token': env.config.internalToken,
            },
            body: JSON.stringify({ vault_id: 1, user_id: 1 }),
        });
        const payload = (await response.json()) as { revoked: number };

        expect(response.status).toBe(200);
        expect(payload.revoked).toBe(1);
        expect(await closed).toBe(4403);
        expect(collaborator.provider.isAuthenticated).toBe(true);
    });
});
