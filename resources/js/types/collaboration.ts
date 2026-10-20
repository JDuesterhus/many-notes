export type CollaborationStatus =
    | 'connecting'
    | 'connected'
    | 'reconnecting'
    | 'offline'
    | 'no-permission'
    | 'token-expired'
    | 'error'
    | 'disabled';

export interface PresenceUser {
    id: string;
    name: string;
    initials: string;
    color: string;
    mode?: 'rich' | 'raw';
}

export interface AwarenessCursor<T = unknown> {
    anchor: T;
    head: T;
}

export interface AwarenessUserState {
    user?: PresenceUser;
    cursor?: AwarenessCursor | null;
    rawCursor?: AwarenessCursor | null;
    mode?: 'rich' | 'raw';
    editing?: boolean;
    editingSince?: number;
}

export interface YjsTokenResponse {
    token: string;
    room: string;
    expires_at: string;
    snapshot_seq: number;
    snapshot_updated_at: string | null;
    seeded: boolean;
    yjs_state_exists: boolean | null;
    can_edit: boolean;
}

export interface YjsSeedClaimResponse {
    claimed: boolean;
    claim_id: string | null;
    retry_after: number | null;
    snapshot_seq: number;
    seeded: boolean;
}

export interface YjsSnapshotResponse {
    data: {
        snapshot_seq: number;
        snapshot_updated_at: string;
        updated_at: string | null;
    };
}

export interface CollaborationPageProps {
    enabled: boolean;
    url: string;
}

export interface EditorCollaboration {
    document: import('yjs').Doc;
    provider: import('@hocuspocus/provider').HocuspocusProvider;
    user: PresenceUser;
}
