import { jwtVerify } from 'jose';
import type { YjsServerConfig } from './config.js';

export interface TokenClaims {
    sub: string;
    name: string;
    vault_id: number;
    node_id: number;
    room: string;
    can_edit: boolean;
    iss: string;
    aud: string;
    iat: number;
    exp: number;
    jti?: string;
}

export interface AuthenticatedUser {
    id: number;
    name: string;
    vaultId: number;
    nodeId: number;
    canEdit: boolean;
}

export interface ConnectionContext {
    user: AuthenticatedUser;
    expiresAt: number;
}

function isPositiveInteger(value: unknown): value is number {
    return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

export async function verifyToken(
    token: string,
    config: YjsServerConfig
): Promise<TokenClaims | null> {
    if (token.length === 0 || token.length > 4096) {
        return null;
    }

    try {
        const { payload } = await jwtVerify(token, new TextEncoder().encode(config.jwtSecret), {
            algorithms: ['HS256'],
            issuer: config.jwtIssuer,
            audience: config.jwtAudience,
            clockTolerance: 5,
        });

        const userId = Number.parseInt(String(payload.sub ?? ''), 10);

        if (
            !Number.isSafeInteger(userId) ||
            userId < 1 ||
            typeof payload.name !== 'string' ||
            typeof payload.room !== 'string' ||
            !isPositiveInteger(payload.vault_id) ||
            !isPositiveInteger(payload.node_id) ||
            typeof payload.can_edit !== 'boolean' ||
            typeof payload.exp !== 'number'
        ) {
            return null;
        }

        return {
            sub: String(payload.sub),
            name: payload.name,
            vault_id: payload.vault_id,
            node_id: payload.node_id,
            room: payload.room,
            can_edit: payload.can_edit,
            iss: String(payload.iss ?? ''),
            aud: String(payload.aud ?? ''),
            iat: Number(payload.iat ?? 0),
            exp: payload.exp,
            jti: typeof payload.jti === 'string' ? payload.jti : undefined,
        };
    } catch {
        return null;
    }
}

export function contextFromClaims(claims: TokenClaims): ConnectionContext {
    return {
        user: {
            id: Number.parseInt(claims.sub, 10),
            name: claims.name,
            vaultId: claims.vault_id,
            nodeId: claims.node_id,
            canEdit: claims.can_edit,
        },
        expiresAt: claims.exp * 1000,
    };
}
