import type {
    YjsSeedClaimResponse,
    YjsSnapshotResponse,
    YjsTokenResponse,
} from '@/types/collaboration';

export class CollaborationRequestError extends Error {
    public constructor(
        message: string,
        public readonly status: number,
        public readonly payload: unknown = null
    ) {
        super(message);
        this.name = 'CollaborationRequestError';
    }
}

interface RequestOptions {
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
    body?: Record<string, unknown>;
    keepalive?: boolean;
}

function csrfToken(): string {
    return document.querySelector<HTMLMetaElement>('meta[name="csrf-token"]')?.content ?? '';
}

function xsrfCookie(): string | null {
    const match = document.cookie.match(/(?:^|;\s*)XSRF-TOKEN=([^;]+)/);

    return match?.[1] ? decodeURIComponent(match[1]) : null;
}

export function csrfFormToken(): string {
    return csrfToken();
}

export async function collaborationRequest<T>(url: string, options: RequestOptions): Promise<T> {
    const headers: Record<string, string> = {
        Accept: 'application/json',
    };

    // The cookie is refreshed on every Laravel response; the meta tag can lag
    // behind a session regeneration during Inertia navigation.
    const cookieToken = xsrfCookie();

    if (cookieToken) {
        headers['X-XSRF-TOKEN'] = cookieToken;
    } else {
        headers['X-CSRF-TOKEN'] = csrfToken();
    }

    if (options.body !== undefined) {
        headers['Content-Type'] = 'application/json';
    }

    const response = await fetch(url, {
        method: options.method,
        credentials: 'same-origin',
        keepalive: options.keepalive ?? false,
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });

    const payload: unknown = await response.json().catch(() => null);

    if (!response.ok) {
        throw new CollaborationRequestError(
            `Collaboration request failed with status ${response.status}`,
            response.status,
            payload
        );
    }

    return payload as T;
}

export function fetchYjsToken(
    url: string,
    vaultId: number,
    nodeId: number
): Promise<YjsTokenResponse> {
    return collaborationRequest<YjsTokenResponse>(url, {
        method: 'POST',
        body: { vault_id: vaultId, node_id: nodeId },
    });
}

export function claimYjsSeed(
    url: string,
    vaultId: number,
    nodeId: number
): Promise<YjsSeedClaimResponse> {
    return collaborationRequest<YjsSeedClaimResponse>(url, {
        method: 'POST',
        body: { vault_id: vaultId, node_id: nodeId },
    });
}

export function completeYjsSeed(
    url: string,
    vaultId: number,
    nodeId: number,
    claimId: string
): Promise<{ completed: boolean }> {
    return collaborationRequest<{ completed: boolean }>(url, {
        method: 'POST',
        body: { vault_id: vaultId, node_id: nodeId, claim_id: claimId },
    });
}

export async function sendSnapshot(
    url: string,
    content: string,
    baseSeq: number
): Promise<YjsSnapshotResponse> {
    return collaborationRequest<YjsSnapshotResponse>(url, {
        method: 'PATCH',
        body: { content, base_seq: baseSeq },
        keepalive: true,
    });
}

/**
 * Best-effort snapshot on visibilitychange/pagehide. sendBeacon cannot read a
 * response, so a conflict is resolved by the next regular snapshot.
 */
export function beaconSnapshot(url: string, content: string, baseSeq: number): boolean {
    if (typeof navigator.sendBeacon !== 'function') {
        return false;
    }

    const body = new URLSearchParams({
        _token: csrfFormToken(),
        content,
        base_seq: String(baseSeq),
    });

    return navigator.sendBeacon(url, body);
}
