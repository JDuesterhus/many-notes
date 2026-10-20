import VaultNodeSnapshotController from '@/actions/App/Http/Controllers/VaultNodeSnapshotController';
import YjsSeedClaimController from '@/actions/App/Http/Controllers/YjsSeedClaimController';
import YjsSeedCompleteController from '@/actions/App/Http/Controllers/YjsSeedCompleteController';
import YjsTokenController from '@/actions/App/Http/Controllers/YjsTokenController';
import { mergeMarkdown, replaceYText } from '@/services/collaborationMarkdown';
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
import { computed, onBeforeUnmount, ref, shallowRef, watch, type Ref } from 'vue';
import * as Y from 'yjs';

const SNAPSHOT_DEBOUNCE = 2000;
const SNAPSHOT_RETRY_DELAY = 5000;
const SEED_WAIT_TIMEOUT = 15000;
const EDIT_IDLE_TIMEOUT = 5000;
const RICH_ORIGIN = 'many-notes:rich';
const RAW_ORIGIN = 'many-notes:raw';
const SEED_ORIGIN = 'many-notes:seed';

interface UseNoteCollaborationOptions {
    vaultId: number;
    nodeId: number;
    markdown: string;
    user: { id: number; name: string };
    enabled: boolean;
    url: string;
    isEditMode: Readonly<Ref<boolean>>;
    isMarkdownMode: Readonly<Ref<boolean>>;
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
    const markdownVersion = ref(0);
    const modeLocked = ref(false);
    const modeLockedBy = ref<PresenceUser | null>(null);
    const modeLockedMode = ref<'rich' | 'raw' | null>(null);

    const room = `vault:${options.vaultId}:node:${options.nodeId}`;
    const ydoc = options.enabled ? new Y.Doc() : null;
    const meta = ydoc?.getMap<unknown>('many-notes-meta') ?? null;
    const ytext = ydoc?.getText('markdown') ?? null;
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
    let lastRichMarkdown: string | null = null;
    let lastProjectionOwner: number | null = null;
    let editingActive = false;
    let editingTimer: ReturnType<typeof setTimeout> | null = null;
    let richProjectionTimer: ReturnType<typeof setTimeout> | null = null;
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

    interface EditingState {
        clientId: number;
        user: PresenceUser;
        mode: 'rich' | 'raw';
        editingSince: number;
    }

    function updateParticipants(): void {
        const awareness = provider.value?.awareness;

        if (!awareness) {
            participants.value = [];
            modeLocked.value = false;
            modeLockedBy.value = null;
            modeLockedMode.value = null;
            return;
        }

        if (destroyed) {
            return;
        }

        const ownClientId = awareness.clientID;
        const localMode: 'rich' | 'raw' = options.isMarkdownMode.value ? 'raw' : 'rich';
        const users: PresenceUser[] = [];
        const editors: EditingState[] = [];

        awareness.getStates().forEach((rawState, clientId) => {
            const state = rawState as {
                user?: PresenceUser;
                mode?: 'rich' | 'raw';
                editing?: boolean;
                editingSince?: number;
            };
            const user = state.user;

            if (user && typeof user.id === 'string') {
                if (clientId !== ownClientId) {
                    users.push({
                        id: user.id,
                        name: user.name || 'User',
                        initials: user.initials || '?',
                        color: user.color || '#2563eb',
                    });
                }

                if (state.editing === true) {
                    editors.push({
                        clientId,
                        user: {
                            id: user.id,
                            name: user.name || 'User',
                            initials: user.initials || '?',
                            color: user.color || '#2563eb',
                        },
                        mode: state.mode === 'raw' ? 'raw' : 'rich',
                        editingSince:
                            typeof state.editingSince === 'number' ? state.editingSince : 0,
                    });
                }
            }
        });

        participants.value = users.sort((a, b) => a.id.localeCompare(b.id));
        awarenessVersion.value++;

        const rawOwner =
            editors
                .filter(editor => editor.mode === 'raw')
                .sort((a, b) => a.clientId - b.clientId)[0]?.clientId ?? null;
        const previousOwner = lastProjectionOwner;

        if (rawOwner !== previousOwner) {
            if (previousOwner === ownClientId) {
                if (richProjectionTimer) {
                    clearTimeout(richProjectionTimer);
                    richProjectionTimer = null;
                }

                // No raw editor remains: flush this editor's last projection
                // before releasing ownership. If another raw editor took over,
                // that editor will project instead.
                if (rawOwner === null && ytext) {
                    void applyMarkdownToRich(ytext.toString());
                }
            }

            lastProjectionOwner = rawOwner;

            if (rawOwner === ownClientId && options.isMarkdownMode.value) {
                scheduleRichProjection();
            }
        }

        const winner = editors.sort(
            (a, b) => a.editingSince - b.editingSince || a.clientId - b.clientId
        )[0];

        if (winner && winner.clientId !== ownClientId && winner.mode !== localMode) {
            modeLocked.value = true;
            modeLockedBy.value = winner.user;
            modeLockedMode.value = winner.mode;

            if (editingActive) {
                endEditing();
            }
        } else {
            modeLocked.value = false;
            modeLockedBy.value = null;
            modeLockedMode.value = null;
        }
    }

    function setAwarenessField(field: string, value: unknown): void {
        provider.value?.setAwarenessField(field, value);
    }

    function endEditing(): void {
        if (!editingActive) {
            return;
        }

        editingActive = false;
        setAwarenessField('editing', false);
        setAwarenessField('editingSince', 0);

        if (editingTimer) {
            clearTimeout(editingTimer);
            editingTimer = null;
        }
    }

    function resetEditingTimer(): void {
        if (editingTimer) {
            clearTimeout(editingTimer);
        }

        editingTimer = setTimeout(() => {
            endEditing();
        }, EDIT_IDLE_TIMEOUT);
    }

    /**
     * Claims the note-wide edit lease. Rich and raw editors may view a note at
     * the same time, but only one representation is edited at a time.
     */
    function beginEditing(): boolean {
        if (!isReady.value || destroyed || !canEdit.value || modeLocked.value) {
            return false;
        }

        editingActive = true;
        setAwarenessField('editing', true);
        setAwarenessField('editingSince', Date.now());
        resetEditingTimer();

        return true;
    }

    function noteEditingActivity(): void {
        if (!editingActive) {
            beginEditing();

            return;
        }

        resetEditingTimer();
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

    function currentMarkdown(): string {
        const text = ytext?.toString() ?? '';

        if (text.length === 0 && getEditorMarkdown) {
            return getEditorMarkdown();
        }

        return text;
    }

    async function applyMarkdownToRich(markdown: string): Promise<void> {
        if (!editor || !setEditorContent || destroyed || markdown === lastRichMarkdown) {
            return;
        }

        lastRichMarkdown = markdown;

        await setEditorContent(markdown);
    }

    function isProjectionOwner(): boolean {
        const awareness = provider.value?.awareness;

        if (!awareness) {
            return true;
        }

        const ownClientId = awareness.clientID;
        const owner = [...awareness.getStates().entries()]
            .filter(([, state]) => {
                const rawState = state as { mode?: 'rich' | 'raw'; editing?: boolean };

                return rawState.mode === 'raw' && rawState.editing === true;
            })
            .map(([clientId]) => clientId)
            .sort((a, b) => a - b)[0];

        return owner === undefined || owner === ownClientId;
    }

    function scheduleRichProjection(): void {
        if (richProjectionTimer) {
            clearTimeout(richProjectionTimer);
        }

        richProjectionTimer = setTimeout(() => {
            richProjectionTimer = null;

            if (ytext) {
                void applyMarkdownToRich(ytext.toString());
            }
        }, 120);
    }

    function finishReady(): void {
        if (destroyed) {
            return;
        }

        isReady.value = true;

        if (canEdit.value) {
            setStatus('connected');
        }

        if (editor) {
            editor.setEditable(canEdit.value && options.isEditMode.value && !modeLocked.value);
        }

        if (lastRichMarkdown === null && getEditorMarkdown) {
            lastRichMarkdown = getEditorMarkdown();
        }

        const current = currentMarkdown();
        lastMarkdown = current;

        if (current !== lastSentMarkdown) {
            scheduleSnapshot();
        } else {
            lastSentMarkdown = current;
        }
    }

    function getMarkdown(): string {
        return currentMarkdown();
    }

    function markSeeded(): void {
        meta?.set('seeded', true);
        meta?.set('seeded_at', Date.now());
    }

    function hasYjsContent(): boolean {
        return (ydoc?.getXmlFragment('default').length ?? 0) > 0 || (ytext?.length ?? 0) > 0;
    }

    /**
     * Older documents only have the rich fragment; raw-edited documents may
     * only have the Markdown text after a reconnect. Fill the missing side
     * before the editor becomes ready.
     */
    async function ensureMirrors(): Promise<void> {
        if (!ydoc || !ytext) {
            return;
        }

        const richLength = ydoc.getXmlFragment('default').length;
        const textLength = ytext.length;

        if (textLength > 0 && richLength === 0) {
            await applyMarkdownToRich(ytext.toString());

            return;
        }

        if (richLength > 0 && textLength === 0) {
            const markdown = getEditorMarkdown?.() ?? options.markdown;
            lastRichMarkdown = markdown;
            replaceYText(ytext, markdown, SEED_ORIGIN);
        }
    }

    async function claimAndSeed(): Promise<void> {
        const deadline = Date.now() + SEED_WAIT_TIMEOUT;

        while (!destroyed && Date.now() < deadline) {
            if (meta?.get('seeded') === true || hasYjsContent()) {
                await ensureMirrors();
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
                    lastRichMarkdown = options.markdown;

                    if (ytext && ytext.length === 0) {
                        replaceYText(ytext, options.markdown, SEED_ORIGIN);
                    }

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

            if (meta?.get('seeded') === true || hasYjsContent()) {
                await ensureMirrors();
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

        const hasMarker = meta?.get('seeded') === true;

        if (hasMarker || hasYjsContent()) {
            await ensureMirrors();

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

        const current = ytext?.toString() ?? lastMarkdown;
        const merged = mergeMarkdown(lastRichMarkdown ?? current, markdown, current);

        lastRichMarkdown = markdown;

        if (ytext) {
            replaceYText(ytext, merged, RICH_ORIGIN);
        }

        if (merged === lastMarkdown) {
            return;
        }

        lastMarkdown = merged;
        scheduleSnapshot();
    }

    function onRawMarkdownChange(markdown: string): void {
        if (!isReady.value || destroyed || !canEdit.value || !ytext) {
            return;
        }

        noteEditingActivity();
        replaceYText(ytext, markdown, RAW_ORIGIN);
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
            finishReady();

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
        endEditing();
        void flush();
    }

    function onVisibilityChange(): void {
        if (document.visibilityState === 'hidden') {
            endEditing();
            flushOnPageHide();
        }
    }

    function textObserver(_event: Y.YTextEvent, transaction: Y.Transaction): void {
        if (!ytext || destroyed) {
            return;
        }

        const next = ytext.toString();
        lastMarkdown = next;
        markdownVersion.value++;

        if (isReady.value && next !== lastSentMarkdown) {
            scheduleSnapshot();
        }

        if (transaction.origin === RICH_ORIGIN || transaction.origin === SEED_ORIGIN) {
            return;
        }

        if (
            options.isMarkdownMode.value &&
            editingActive &&
            isProjectionOwner() &&
            next !== lastRichMarkdown
        ) {
            scheduleRichProjection();
        }
    }

    if (options.enabled && ydoc) {
        ytext?.observe(textObserver);

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
        provider.value.setAwarenessField('mode', options.isMarkdownMode.value ? 'raw' : 'rich');
        provider.value.setAwarenessField('editing', false);
        provider.value.setAwarenessField('editingSince', 0);

        window.addEventListener('blur', onWindowBlur);
        document.addEventListener('visibilitychange', onVisibilityChange);
        window.addEventListener('pagehide', flushOnPageHide);
        window.addEventListener('beforeunload', flushOnPageHide);
    }

    watch(options.isMarkdownMode, markdownMode => {
        setAwarenessField('mode', markdownMode ? 'raw' : 'rich');
        endEditing();

        // Flush a projection that was still inside its 120 ms debounce before
        // the rich editor becomes editable again. No timer means the active raw
        // editor already projected the current Markdown.
        if (!markdownMode && richProjectionTimer && ytext && !modeLocked.value) {
            clearTimeout(richProjectionTimer);
            richProjectionTimer = null;

            void applyMarkdownToRich(ytext.toString());
        }
    });

    watch(options.isEditMode, editMode => {
        if (!editMode) {
            endEditing();
        }
    });

    watch(modeLocked, locked => {
        if (locked) {
            endEditing();
        }

        editor?.setEditable(canEdit.value && isReady.value && options.isEditMode.value && !locked);
    });

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
        endEditing();
        destroyed = true;

        if (editingTimer) {
            clearTimeout(editingTimer);
        }

        if (richProjectionTimer) {
            clearTimeout(richProjectionTimer);
        }

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

        ytext?.unobserve(textObserver);

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
        markdownVersion,
        modeLocked,
        modeLockedBy,
        modeLockedMode,
        editorOptions,
        localUser,
        attachEditor,
        onContentChange,
        onRawMarkdownChange,
        getMarkdown,
        beginEditing,
        noteEditingActivity,
        endEditing,
        flush,
        updateSnapshotSeq,
        ydoc,
        ytext,
        provider,
    };
}
