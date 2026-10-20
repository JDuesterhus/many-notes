import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

interface DocumentRow {
    state: Buffer;
}

interface ExistsRow {
    found: number;
}

export class Storage {
    private readonly yjsDb: Database.Database;
    private readonly laravelDb: Database.Database;

    constructor(dbPath: string, laravelDbPath: string) {
        mkdirSync(dirname(dbPath), { recursive: true });

        this.yjsDb = new Database(dbPath);
        this.yjsDb.pragma('journal_mode = WAL');
        this.yjsDb.pragma('busy_timeout = 5000');
        this.yjsDb.exec(`
            CREATE TABLE IF NOT EXISTS yjs_documents (
                document_name TEXT PRIMARY KEY,
                state BLOB NOT NULL,
                updated_at TEXT NOT NULL
            );
        `);

        this.laravelDb = new Database(laravelDbPath, {
            readonly: true,
            fileMustExist: true,
        });
        this.laravelDb.pragma('busy_timeout = 5000');
    }

    public fetchDocument(documentName: string): Uint8Array | null {
        const row = this.yjsDb
            .prepare('SELECT state FROM yjs_documents WHERE document_name = ?')
            .get(documentName) as DocumentRow | undefined;

        return row ? new Uint8Array(row.state) : null;
    }

    public storeDocument(documentName: string, state: Uint8Array): void {
        this.yjsDb
            .prepare(
                `INSERT INTO yjs_documents (document_name, state, updated_at)
                 VALUES (?, ?, ?)
                 ON CONFLICT(document_name) DO UPDATE SET
                    state = excluded.state,
                    updated_at = excluded.updated_at`
            )
            .run(documentName, Buffer.from(state), new Date().toISOString());
    }

    public deleteDocument(documentName: string): boolean {
        const result = this.yjsDb
            .prepare('DELETE FROM yjs_documents WHERE document_name = ?')
            .run(documentName);

        return result.changes > 0;
    }

    public documentExists(documentName: string): boolean {
        const row = this.yjsDb
            .prepare('SELECT 1 AS found FROM yjs_documents WHERE document_name = ? LIMIT 1')
            .get(documentName) as ExistsRow | undefined;

        return row !== undefined;
    }

    public documentCount(): number {
        const row = this.yjsDb.prepare('SELECT COUNT(*) AS count FROM yjs_documents').get() as {
            count: number;
        };

        return row.count;
    }

    public isAuthorized(userId: number, vaultId: number, nodeId: number): boolean {
        const row = this.laravelDb
            .prepare(
                `SELECT 1 AS found
                 FROM vault_nodes n
                 INNER JOIN vaults v ON v.id = n.vault_id
                 LEFT JOIN user_vault c
                    ON c.vault_id = n.vault_id
                    AND c.user_id = ?
                    AND c.accepted = 1
                 WHERE n.id = ?
                   AND n.vault_id = ?
                   AND n.is_file = 1
                   AND n.extension = 'md'
                   AND (v.created_by = ? OR c.user_id IS NOT NULL)
                 LIMIT 1`
            )
            .get(userId, nodeId, vaultId, userId) as ExistsRow | undefined;

        return row !== undefined;
    }

    public close(): void {
        this.yjsDb.close();
        this.laravelDb.close();
    }
}
