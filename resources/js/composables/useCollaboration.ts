import VaultNodeSnapshotController from '@/actions/App/Http/Controllers/VaultNodeSnapshotController';
import YjsSeedClaimController from '@/actions/App/Http/Controllers/YjsSeedClaimController';
import YjsSeedCompleteController from '@/actions/App/Http/Controllers/YjsSeedCompleteController';
import YjsTokenController from '@/actions/App/Http/Controllers/YjsTokenController';
import {
    beaconSnapshot,
    claimYjsSeed,
    CollaborationRequestError,
    completeYjsSeed,
    fetchYjsToken,
    sendSnapshot,
} from '@/services/collaborationRequest';
import { PresenceUser, YjsTokenResponse } from '@/types/collaboration';
import { buildPresenceUser } from '@/utils/presence';
import { HocuspocusProvider, WebSocketStatus } from '@hocuspocus/provider';
import type { Editor } from '@tiptap/core';
import { computed, onBeforeUnmount, ref, shallowRef, type Ref } from 'vue';
import * as Y from 'yjs';

const SNAPSHOT_DEBOUNCE = 2000;
const SNAPSHOT_RETRY_DELAY = 5000;
const SEED_WAIT_TIMEOUT = 15000;

interface UseNoteCollaborationOptions {
    vaultId: number;
    nodeId: number;
    markdown: string;
    user: { id: number; name: string };
    enabled: boolean;
    url: string;
    isEditMode: Readonly<Ref<boolean>>;
}

export type CollaborationStatus =
    | 'connecting'
    | 'connected'
    | 'reconnecting'
    | 'offline'
    | 'no-permission'
    | 'token-expired'
    | 'error'
    | 'disabled';

function sleep(milliseconds: number): Promise<void> {
    return new Promise(resolve => {
        globalThis.setTimeout(resolve, milliseconds);
    });
}

function resolveWebSocketUrl(path: string): string {
    const fallbackProtocol = globalThis.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const fallback = `${fallbackProtocol}//${globalThis.location.host}/yjs`;

    if (!path) {
        return fallback;
    }

    try {
        const url = new URL(path, globalThis.location.href);
        url.protocol = url.protocol === 'https:' || url.protocol === 'wss:' ? 'wss:' : 'ws:';

        return url.toString().replace(/\/$/, '');
    } catch {
        return fallback;
    }
}

export function useNoteCollaboration(options: UseNoteCollaborationOptions) {
    const isLive = ref(options.enabled);
    const status = ref<CollaborationStatus>(options.enabled ? 'connecting' : 'disabled');
    const isReady = ref(!options.enabled);
    const canEdit = ref(true);
    const snapshotError = ref<string | null>(null);
    const tokenError = ref<string | null>(null);
    const awarenessVersion = ref(0);
    const participants = ref<PresenceUser[]>([]);

    const room = `vault:${options.vaultId}:node:${options.nodeId}`;
    const ydoc = options.enabled ? new Y.Doc() : null;
    const meta = ydoc?.getMap<unknown>('many-notes-meta') ?? null;
    const provider = shallowRef<HocuspocusProvider | null>(null);
    const localUser: PresenceUser = buildPresenceUser(options.user.id, options.user.name);

    let editor: Editor | null = null;
    let setEditorContent: ((markdown: string) => Promise<void>) | null = null;
    let getEditorMarkdown: (() => string) | null = null;

    let tokenData: YjsTokenResponse | null = null;
    let lastTokenStatus: CollaborationStatus | null = null;
    let baseSeq = 0;
    let lastMarkdown = options.markdown;
    let lastSentMarkdown = options.markdown;
    let snapshotTimer: ReturnType<typeof setTimeout> | null = null;
    let snapshotRetryTimer: ReturnType<typeof setTimeout> | null = null;
    let tokenRefreshTimer: ReturnType<typeof setInterval> | null = null;
    let seedTimer: ReturnType<typeof setTimeout> | null = null;
    let snapshotInFlight = false;
    let pendingSnapshot = false;
    let seedStarted = false;
    let destroyed = false;
    let hadSynced = false;
    let synced = false;

    const snapshotUrl = VaultNodeSnapshotController.url({
        vault: options.vaultId,
        node: options.nodeId,
    });

    function setStatus(next: CollaborationStatus): void {
        if (destroyed) {
            return;
        }

        status.value = next;
    }

    function updateParticipants(): void {
        const awareness = provider.value?.awareness;

        if (!awareness) {
            participants.value = [];
            return;
        }

        const ownClientId = awareness.clientID;
        const users: PresenceUser[] = [];

        awareness.getStates().forEach((state, clientId) => {
            if (clientId === ownClientId || destroyed) {
                return;
            }

            const user = (state as { user?: PresenceUser }).user;

            if (!user || typeof user.id !== 'string') {
                return;
            }

            users.push({
                id: user.id,
                name: user.name || 'User',
                initials: user.initials || '?',
                color: user.color || '#2563eb',
            });
        });

        participants.value = users.sort((a, b) => a.id.localeCompare(b.id));
        awarenessVersion.value++;
    }

    function refreshTokenTimer(expiresAt: string): void {
        if (tokenRefreshTimer) {
            clearInterval(tokenRefreshTimer);
        }

        const seconds = Math.max(
            30,
            Math.floor((new Date(expiresAt).getTime() - Date.now()) / 1000) * 0.8
        );
        const interval = Math.max(15, seconds) * 1000;

        tokenRefreshTimer = setInterval(() => {
            void (async () => {
                try {
                    await provider.value?.sendToken();
                    setStatus(synced ? 'connected' : 'reconnecting');
                } catch {
                    setStatus('token-expired');
                }
            })();
        }, interval);
    }

    async function requestToken(): Promise<YjsTokenResponse> {
        try {
            const data = await fetchYjsToken(
                YjsTokenController.url(),
                options.vaultId,
                options.nodeId
            );

            tokenData = data;
            baseSeq = Math.max(baseSeq, data.snapshot_seq);
            canEdit.value = data.can_edit;
            tokenError.value = null;
            lastTokenStatus = null;

            if (!data.can_edit) {
                lastTokenStatus = 'no-permission';
                setStatus('no-permission');
            }

            refreshTokenTimer(data.expires_at);

            return data;
        } catch (error) {
            if (error instanceof CollaborationRequestError) {
                if (error.status === 403 || error.status === 404) {
                    lastTokenStatus = 'no-permission';
                    canEdit.value = false;
                    tokenError.value = 'You no longer have permission to edit this note.';
                } else if (error.status === 401 || error.status === 419) {
                    lastTokenStatus = 'token-expired';
                    tokenError.value = 'Your session expired. Reload the page to continue.';
                } else if (error.status >= 500) {
                    lastTokenStatus = 'error';
                    tokenError.value =
                        'Collaboration is not configured or temporarily unavailable.';
                } else {
                    lastTokenStatus = 'offline';
                    tokenError.value = 'Collaboration is temporarily unavailable.';
                }

                setStatus(lastTokenStatus);
            } else {
                lastTokenStatus = 'offline';
                tokenError.value = 'Collaboration is temporarily unavailable.';
                setStatus('offline');
            }

            throw error;
        }
    }

    function finishReady(): void {
        if (destroyed) {
            return;
        }

        isReady.value = true;
        setStatus('connected');

        if (editor) {
            editor.setEditable(canEdit.value && options.isEditMode.value);
        }

        const current = getEditorMarkdown?.() ?? options.markdown;
        lastMarkdown = current;

        if (current !== lastSentMarkdown) {
            lastSentMarkdown = options.markdown;
            scheduleSnapshot();
        } else {
            lastSentMarkdown = current;
        }
    }

    function markSeeded(): void {
        meta?.set('seeded', true);
        meta?.set('seeded_at', Date.now());
    }

    async function claimAndSeed(): Promise<void> {
        const deadline = Date.now() + SEED_WAIT_TIMEOUT;

        while (!destroyed && Date.now() < deadline) {
            if (meta?.get('seeded') === true || (ydoc?.getXmlFragment('default').length ?? 0) > 0) {
                finishReady();

                return;
            }

            try {
                const claim = await claimYjsSeed(
                    YjsSeedClaimController.url(),
                    options.vaultId,
                    options.nodeId
                );

                baseSeq = Math.max(baseSeq, claim.snapshot_seq);

                if (claim.claimed && claim.claim_id) {
                    if (!editor || !setEditorContent) {
                        await sleep(100);
                        continue;
                    }

                    await setEditorContent(options.markdown);
                    markSeeded();

                    await completeYjsSeed(
                        YjsSeedCompleteController.url(),
                        options.vaultId,
                        options.nodeId,
                        claim.claim_id
                    ).catch(() => {
                        // The Yjs document is already marked as seeded and has
                        // state; the bookkeeping can be retried on next open.
                    });

                    lastSentMarkdown = '';
                    finishReady();

                    return;
                }
            } catch (error) {
                if (error instanceof CollaborationRequestError && error.status === 409) {
                    // The note changed while claiming; retry with fresh state.
                } else {
                    snapshotError.value = 'Could not initialize collaboration for this note.';
                }
            }

            if (meta?.get('seeded') === true || (ydoc?.getXmlFragment('default').length ?? 0) > 0) {
                finishReady();

                return;
            }

            await sleep(250);
        }

        if (!destroyed) {
            setStatus('offline');
            snapshotError.value = 'The note content is taking too long to initialize. Retrying...';
            seedTimer = setTimeout(() => {
                seedStarted = false;
                void startSeeding();
            }, 3000);
        }
    }

    async function startSeeding(): Promise<void> {
        if (destroyed || seedStarted) {
            return;
        }

        seedStarted = true;

        if (!tokenData) {
            try {
                await requestToken();
            } catch {
                return;
            }
        }

        const hasContent = (ydoc?.getXmlFragment('default').length ?? 0) > 0;
        const hasMarker = meta?.get('seeded') === true;

        if (hasMarker || hasContent) {
            if (!hasMarker) {
                markSeeded();
            }

            finishReady();

            return;
        }

        if (tokenData?.yjs_state_exists === true) {
            markSeeded();
            finishReady();

            return;
        }

        const shouldSeed =
            tokenData?.yjs_state_exists === false ||
            (tokenData?.yjs_state_exists === null && tokenData?.seeded !== true);

        if (!shouldSeed) {
            markSeeded();
            finishReady();

            return;
        }

        await claimAndSeed();
    }

    function scheduleSnapshot(): void {
        if (!isReady.value || destroyed) {
            return;
        }

        if (snapshotTimer) {
            clearTimeout(snapshotTimer);
        }

        snapshotTimer = setTimeout(() => {
            void flush();
        }, SNAPSHOT_DEBOUNCE);
    }

    async function flush(): Promise<void> {
        if (!isReady.value || destroyed || !canEdit.value) {
            return;
        }

        if (!provider.value?.synced) {
            pendingSnapshot = true;

            return;
        }

        if (lastMarkdown === lastSentMarkdown) {
            return;
        }

        if (snapshotTimer) {
            clearTimeout(snapshotTimer);
            snapshotTimer = null;
        }

        await persistSnapshot();
    }

    async function persistSnapshot(): Promise<void> {
        if (snapshotInFlight) {
            pendingSnapshot = true;

            return;
        }

        snapshotInFlight = true;
        pendingSnapshot = false;
        const content = lastMarkdown;

        try {
            for (let attempt = 0; attempt < 4; attempt++) {
                try {
                    const response = await sendSnapshot(snapshotUrl, content, baseSeq);

                    baseSeq = response.data.snapshot_seq;
                    lastSentMarkdown = content;
                    snapshotError.value = null;

                    if (lastMarkdown !== content) {
                        scheduleSnapshot();
                    }

                    return;
                } catch (error) {
                    if (error instanceof CollaborationRequestError && error.status === 409) {
                        const payload = error.payload as { snapshot_seq?: unknown } | null;

                        if (typeof payload?.snapshot_seq === 'number') {
                            baseSeq = payload.snapshot_seq;
                        }

                        await sleep(100 + Math.floor(Math.random() * 200));
                        continue;
                    }

                    snapshotError.value =
                        'Changes are live, but the Markdown snapshot could not be saved. Retrying...';
                    snapshotRetryTimer = setTimeout(() => {
                        void persistSnapshot();
                    }, SNAPSHOT_RETRY_DELAY);

                    return;
                }
            }

            snapshotError.value = 'The Markdown snapshot is out of date. Retrying...';
            snapshotRetryTimer = setTimeout(() => {
                void persistSnapshot();
            }, SNAPSHOT_RETRY_DELAY);
        } finally {
            snapshotInFlight = false;

            if (pendingSnapshot && lastMarkdown !== lastSentMarkdown) {
                pendingSnapshot = false;
                scheduleSnapshot();
            }
        }
    }

    function onContentChange(markdown: string): void {
        if (!isReady.value || destroyed || !canEdit.value) {
            return;
        }

        if (markdown === lastMarkdown) {
            return;
        }

        lastMarkdown = markdown;
        scheduleSnapshot();
    }

    function attachEditor(
        instance: Editor,
        setContent: (markdown: string) => Promise<void>,
        readMarkdown: () => string
    ): void {
        editor = instance;
        setEditorContent = setContent;
        getEditorMarkdown = readMarkdown;

        if (synced && !seedStarted) {
            void startSeeding();
        }

        if (synced && isReady.value) {
            finishReady();
        }
    }

    function updateSnapshotSeq(sequence: number): void {
        baseSeq = Math.max(baseSeq, sequence);
    }

    function handleSynced(): void {
        synced = true;
        hadSynced = true;

        if (!canEdit.value) {
            return;
        }

        if (isReady.value) {
            if (lastMarkdown !== lastSentMarkdown) {
                void flush();
            }

            return;
        }

        void startSeeding();
    }

    function handleClose(code?: number): void {
        if (destroyed) {
            return;
        }

        synced = false;

        if (code === 4403) {
            canEdit.value = false;
            setStatus('no-permission');
            tokenError.value = 'Access to this vault was revoked.';

            return;
        }

        if (code === 4401) {
            setStatus('token-expired');

            return;
        }

        setStatus(hadSynced ? 'reconnecting' : 'offline');
    }

    function flushOnPageHide(): void {
        if (!isReady.value || destroyed || !canEdit.value) {
            return;
        }

        if (lastMarkdown === lastSentMarkdown) {
            return;
        }

        if (beaconSnapshot(snapshotUrl, lastMarkdown, baseSeq)) {
            lastSentMarkdown = lastMarkdown;
        }
    }

    function onWindowBlur(): void {
        void flush();
    }

    function onVisibilityChange(): void {
        if (document.visibilityState === 'hidden') {
            flushOnPageHide();
        }
    }

    if (options.enabled && ydoc) {
        provider.value = new HocuspocusProvider({
            url: resolveWebSocketUrl(options.url),
            name: room,
            document: ydoc,
            token: async () => (await requestToken()).token,
            flushDelay: 80,
            onStatus: ({ status: websocketStatus }) => {
                if (!canEdit.value) {
                    return;
                }

                if (websocketStatus === WebSocketStatus.Connecting) {
                    setStatus(hadSynced ? 'reconnecting' : 'connecting');
                } else if (websocketStatus === WebSocketStatus.Disconnected) {
                    setStatus('offline');
                }
            },
            onAuthenticated: () => {
                setStatus('connected');
            },
            onAuthenticationFailed: () => {
                const nextStatus = lastTokenStatus ?? 'no-permission';

                if (nextStatus === 'no-permission') {
                    canEdit.value = false;
                }

                setStatus(nextStatus);
            },
            onSynced: ({ state }) => {
                if (state) {
                    handleSynced();
                } else {
                    setStatus('reconnecting');
                }
            },
            onDisconnect: ({ event }) => handleClose(event.code),
            onClose: ({ event }) => handleClose(event.code),
            onAwarenessChange: updateParticipants,
        });

        provider.value.setAwarenessField('user', localUser);
        provider.value.setAwarenessField('mode', 'rich');

        window.addEventListener('blur', onWindowBlur);
        document.addEventListener('visibilitychange', onVisibilityChange);
        window.addEventListener('pagehide', flushOnPageHide);
        window.addEventListener('beforeunload', flushOnPageHide);
    }

    const editorOptions = computed(() =>
        options.enabled && ydoc && provider.value
            ? {
                  document: ydoc,
                  provider: provider.value,
                  user: localUser,
              }
            : null
    );

    onBeforeUnmount(() => {
        destroyed = true;

        if (snapshotTimer) {
            clearTimeout(snapshotTimer);
        }

        if (snapshotRetryTimer) {
            clearTimeout(snapshotRetryTimer);
        }

        if (tokenRefreshTimer) {
            clearInterval(tokenRefreshTimer);
        }

        if (seedTimer) {
            clearTimeout(seedTimer);
        }

        window.removeEventListener('blur', onWindowBlur);
        document.removeEventListener('visibilitychange', onVisibilityChange);
        window.removeEventListener('pagehide', flushOnPageHide);
        window.removeEventListener('beforeunload', flushOnPageHide);

        // Send a final snapshot before tearing down. The fetch is already in
        // flight when the provider and editor disappear; no late update from
        // this editor can arrive after the note switch.
        if (isReady.value && canEdit.value && lastMarkdown !== lastSentMarkdown) {
            const content = lastMarkdown;
            lastSentMarkdown = content;
            void sendSnapshot(snapshotUrl, content, baseSeq).catch(() => {});
        }

        provider.value?.destroy();
        provider.value = null;
        ydoc?.destroy();
    });

    return {
        isLive,
        status,
        isReady,
        canEdit,
        snapshotError,
        tokenError,
        participants,
        awarenessVersion,
        editorOptions,
        localUser,
        attachEditor,
        onContentChange,
        flush,
        updateSnapshotSeq,
        ydoc,
        provider,
    };
}
