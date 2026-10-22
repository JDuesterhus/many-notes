import VaultNodeSnapshotController from '@/actions/App/Http/Controllers/VaultNodeSnapshotController';
import YjsSeedClaimController from '@/actions/App/Http/Controllers/YjsSeedClaimController';
import YjsSeedCompleteController from '@/actions/App/Http/Controllers/YjsSeedCompleteController';
import YjsTokenController from '@/actions/App/Http/Controllers/YjsTokenController';
import {
    applyRichTextChange,
    findMarkdownOffsetForVisibleText,
    hasMeaningfulFragmentContent,
    replaceYText,
    visibleMarkdownProjection,
    visibleOffsetForMarkdownOffset,
} from '@/services/collaborationMarkdown';
import {
    beaconSnapshot,
    claimYjsSeed,
    CollaborationRequestError,
    completeYjsSeed,
    fetchYjsToken,
    keepaliveSnapshot,
    sendSnapshot,
} from '@/services/collaborationRequest';
import { PresenceUser, YjsTokenResponse } from '@/types/collaboration';
import { buildPresenceUser } from '@/utils/presence';
import { HocuspocusProvider, WebSocketStatus } from '@hocuspocus/provider';
import type { Editor } from '@tiptap/core';
import { absolutePositionToRelativePosition, ySyncPluginKey } from '@tiptap/y-tiptap';
import { computed, onBeforeUnmount, ref, shallowRef, watch, type Ref } from 'vue';
import * as Y from 'yjs';

const SNAPSHOT_DEBOUNCE = 2000;
const SNAPSHOT_RETRY_DELAY = 5000;
const SEED_WAIT_TIMEOUT = 15000;
const EDIT_IDLE_TIMEOUT = 1500;
const RICH_ORIGIN = 'many-notes:rich';
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
    let lastProjectedMarkdown: string | null = null;
    let lastRichCursor: unknown = null;
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
    let projectionInFlight = false;
    let pendingProjection: string | null = null;
    let presenceHeartbeatTimer: ReturnType<typeof setInterval> | null = null;
    let participantClearTimer: ReturnType<typeof setTimeout> | null = null;
    let rawRichCursorActive = false;

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
            lastProjectionOwner = null;

            return;
        }

        if (destroyed) {
            return;
        }

        const ownClientId = awareness.clientID;
        const localState = awareness.getLocalState() as { cursor?: unknown } | null;

        if (localState?.cursor) {
            lastRichCursor = localState.cursor;
        }

        const users: PresenceUser[] = [];
        const seenUsers = new Set<string>();
        const editors: EditingState[] = [];

        awareness.getStates().forEach((rawState, clientId) => {
            const state = rawState as {
                user?: PresenceUser;
                mode?: 'rich' | 'raw';
                editing?: boolean;
                editingSince?: number;
            };
            const user = state.user;

            if (!user || typeof user.id !== 'string') {
                return;
            }

            const presence: PresenceUser = {
                id: user.id,
                name: user.name || 'User',
                initials: user.initials || '?',
                color: user.color || '#2563eb',
                mode: state.mode === 'raw' ? 'raw' : 'rich',
            };

            // Several tabs of the same account are one collaborator in the
            // avatar list. In-text carets remain per client.
            if (clientId !== ownClientId && !seenUsers.has(presence.id)) {
                seenUsers.add(presence.id);
                users.push(presence);
            }

            if (state.editing === true) {
                editors.push({
                    clientId,
                    user: presence,
                    mode: presence.mode ?? 'rich',
                    editingSince: typeof state.editingSince === 'number' ? state.editingSince : 0,
                });
            }
        });

        if (users.length > 0) {
            if (participantClearTimer) {
                clearTimeout(participantClearTimer);
                participantClearTimer = null;
            }

            participants.value = users.sort((a, b) => a.id.localeCompare(b.id));
        } else if (participants.value.length > 0 && participantClearTimer === null) {
            // A reconnect briefly publishes an empty awareness map before
            // remote clients re-announce themselves. Keep the last list for a
            // short grace period instead of making avatars blink.
            participantClearTimer = setTimeout(() => {
                participantClearTimer = null;

                const awareness = provider.value?.awareness;
                const ownClientId = awareness?.clientID;
                const hasRemoteUser = [...(awareness?.getStates() ?? [])].some(
                    ([clientId, state]) =>
                        clientId !== ownClientId && !!(state as { user?: PresenceUser }).user
                );

                if (hasRemoteUser) {
                    updateParticipants();

                    return;
                }

                participants.value = [];
            }, 3000);
        }

        awarenessVersion.value++;

        const rawOwner =
            editors
                .filter(editor => editor.mode === 'raw')
                .sort((a, b) => a.clientId - b.clientId)[0]?.clientId ?? null;
        const previousOwner = lastProjectionOwner;

        if (rawOwner !== previousOwner) {
            if (previousOwner === ownClientId && richProjectionTimer) {
                clearTimeout(richProjectionTimer);
                richProjectionTimer = null;
            }

            lastProjectionOwner = rawOwner;

            if (
                (rawOwner === ownClientId || (rawOwner === null && isProjectionOwner())) &&
                ytext &&
                ytext.toString() !== lastProjectedMarkdown
            ) {
                scheduleRichProjection();
            }
        }

        if (
            isProjectionOwner() &&
            ytext &&
            ytext.toString() !== lastProjectedMarkdown &&
            !hasActiveRichEditor()
        ) {
            scheduleRichProjection();
        }
    }

    function setAwarenessField(field: string, value: unknown): void {
        provider.value?.setAwarenessField(field, value);
    }

    function endEditing(): void {
        if (!editingActive) {
            return;
        }

        // Final raw flush on blur/idle, even if a rich user is still typing.
        // This keeps the fragment current when the raw user leaves.
        if (options.isMarkdownMode.value && ytext && isProjectionOwner()) {
            if (richProjectionTimer) {
                clearTimeout(richProjectionTimer);
                richProjectionTimer = null;
            }

            if (ytext.toString() !== lastProjectedMarkdown) {
                void applyMarkdownToRich(ytext.toString());
            }
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
        if (!isReady.value || destroyed || !canEdit.value) {
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
        if (!editor || !setEditorContent || destroyed) {
            return;
        }

        // A raw editor may produce several Y.Text batches while the previous
        // projection is still being parsed. Keep only the newest value and
        // never let two async TipTap replacements overlap.
        pendingProjection = markdown;

        if (projectionInFlight) {
            return;
        }

        projectionInFlight = true;

        try {
            while (pendingProjection !== null && !destroyed) {
                const next = pendingProjection;
                pendingProjection = null;

                if (next === lastRichMarkdown) {
                    continue;
                }

                lastRichMarkdown = next;
                await setEditorContent(next);

                // TipTap/Turndown may normalize constructs such as a soft
                // line break. Use the serialization that the rich editor
                // actually holds as the base for the next local delta; using
                // the raw source as the base makes the first rich keystroke
                // rewrite the whole normalized document in Y.Text.
                const serialized = getEditorMarkdown?.();

                if (serialized !== undefined) {
                    lastRichMarkdown = serialized;
                }

                lastProjectedMarkdown = next;
            }
        } finally {
            projectionInFlight = false;
        }
    }

    function isProjectionOwner(): boolean {
        const awareness = provider.value?.awareness;

        if (!awareness) {
            return true;
        }

        const ownClientId = awareness.clientID;
        const states = [...awareness.getStates().entries()];
        const rawOwner = states
            .filter(([, state]) => {
                const rawState = state as { mode?: 'rich' | 'raw'; editing?: boolean };

                return rawState.mode === 'raw' && rawState.editing === true;
            })
            .map(([clientId]) => clientId)
            .sort((a, b) => a - b)[0];

        if (rawOwner !== undefined) {
            return rawOwner === ownClientId;
        }

        // The raw editor may have stopped typing while rich users were still
        // active. Elect the remaining raw viewer to flush the accumulated
        // Markdown. If every raw viewer left, one remaining client still has
        // to materialize the last raw value into the rich fragment.
        const rawViewer = states
            .filter(([, state]) => {
                const presence = state as { user?: PresenceUser; mode?: 'rich' | 'raw' };

                return !!presence.user && presence.mode === 'raw';
            })
            .map(([clientId]) => clientId)
            .sort((a, b) => a - b)[0];

        if (rawViewer !== undefined) {
            return rawViewer === ownClientId;
        }

        const anyClient = states.map(([clientId]) => clientId).sort((a, b) => a - b)[0];

        return anyClient === undefined || anyClient === ownClientId;
    }

    function hasActiveRichEditor(): boolean {
        const awareness = provider.value?.awareness;

        if (!awareness) {
            return false;
        }

        return [...awareness.getStates().values()].some(state => {
            const presence = state as { mode?: 'rich' | 'raw'; editing?: boolean };

            return presence.mode !== 'raw' && presence.editing === true;
        });
    }

    function scheduleRichProjection(): void {
        if (richProjectionTimer) {
            clearTimeout(richProjectionTimer);
        }

        richProjectionTimer = setTimeout(() => {
            richProjectionTimer = null;

            if (!ytext || ytext.toString() === lastProjectedMarkdown) {
                return;
            }

            // Replacing the fragment while a rich user is in the middle of a
            // transaction can delete their concurrent edit. Raw input is
            // already visible in Y.Text immediately; wait for a short rich
            // idle window and then reconcile the fragment once.
            if (hasActiveRichEditor()) {
                scheduleRichProjection();

                return;
            }

            void applyMarkdownToRich(ytext.toString());
        }, 180);
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
            editor.setEditable(canEdit.value && options.isEditMode.value);
        }

        if (lastRichMarkdown === null && getEditorMarkdown) {
            lastRichMarkdown = getEditorMarkdown();
        }

        const current = currentMarkdown();
        lastMarkdown = current;
        lastProjectedMarkdown = current;

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
        if (!ydoc) {
            return false;
        }

        if ((ytext?.length ?? 0) > 0) {
            return true;
        }

        // TipTap creates an empty paragraph as soon as the collaboration
        // binding mounts. That placeholder must not be mistaken for real
        // note content, otherwise a new note is marked as seeded while its
        // Markdown body is still waiting to be copied from the database.
        return hasMeaningfulFragmentContent(ydoc.getXmlFragment('default').toString());
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

        const text = ytext.toString();
        const richMarkdown = getEditorMarkdown?.() ?? '';

        if (text.length > 0 && richMarkdown.trim() === '') {
            await applyMarkdownToRich(text);

            return;
        }

        if (richMarkdown.length > 0 && text.length === 0) {
            lastRichMarkdown = richMarkdown;
            lastProjectedMarkdown = richMarkdown;
            replaceYText(ytext, richMarkdown, SEED_ORIGIN);

            return;
        }

        // A raw edit can be committed to Y.Text while the tab is closing,
        // before the projector has rebuilt the rich fragment. On the next
        // open the materialized Markdown is newer than the fragment, so
        // rebuild the rich view from it instead of showing stale content.
        if (text.length > 0 && richMarkdown.length > 0 && text !== richMarkdown) {
            await applyMarkdownToRich(text);
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

        // `seeded_at` is the authoritative marker for an intentionally empty
        // note. A Yjs state existing is not enough: Hocuspocus creates an
        // empty document state as soon as the first client connects, and
        // TipTap also inserts an empty paragraph immediately.
        if (tokenData?.seeded === true && tokenData.yjs_state_exists !== false) {
            await ensureMirrors();
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

    function updateRichBase(markdown: string): void {
        lastRichMarkdown = markdown;

        // This callback describes what the rich fragment currently contains,
        // not what Y.Text contains. During simultaneous raw editing those two
        // differ until the projection runs. Marking Y.Text as projected here
        // used to suppress that projection forever.
        lastProjectedMarkdown = markdown;
    }

    function onContentChange(markdown: string): void {
        if (!isReady.value || destroyed || !canEdit.value) {
            return;
        }

        const base = lastRichMarkdown ?? ytext?.toString() ?? lastMarkdown;

        // Apply only the rich delta. `current` can already contain a raw edit
        // which the rich editor has not rendered yet; a full replacement
        // would silently delete it during simultaneous typing.
        if (ytext) {
            applyRichTextChange(ytext, base, markdown, RICH_ORIGIN);
        }

        lastRichMarkdown = markdown;
        lastProjectedMarkdown = markdown;

        const current = ytext?.toString() ?? markdown;

        if (current !== lastMarkdown) {
            lastMarkdown = current;
            scheduleSnapshot();
        }

        if (ytext && current !== markdown && isProjectionOwner()) {
            scheduleRichProjection();
        }
    }

    function clearRawCursor(): void {
        if (destroyed) {
            return;
        }

        setAwarenessField('rawCursor', null);
    }

    /**
     * Publish the rich caret to raw viewers as a Y.Text range. Raw editors
     * only render `rawCursor`; without this a rich collaborator is visible in
     * the avatar row but has no caret in the Markdown pane.
     */
    function updateRichCursor(anchor: number, head: number): void {
        if (destroyed || !ytext || !editor || options.isMarkdownMode.value) {
            return;
        }

        const markdown = ytext.toString();

        if (markdown.length === 0) {
            return;
        }

        const setRawRange = (start: number, end: number): void => {
            const anchorPosition = Y.createRelativePositionFromTypeIndex(ytext, start, -1);
            const headPosition = Y.createRelativePositionFromTypeIndex(ytext, end, 1);

            setAwarenessField('rawCursor', {
                anchor: anchorPosition,
                head: headPosition,
            });
        };

        const offsetFor = (position: number): number => {
            const visible = editor?.state.doc.textBetween(0, position, '\n', '\n') ?? '';

            return Math.max(
                0,
                Math.min(markdown.length, findMarkdownOffsetForVisibleText(markdown, visible))
            );
        };

        const from = Math.min(anchor, head);
        const to = Math.max(anchor, head);
        const selectedText = editor.state.doc.textBetween(from, to, '\n', '\n').trim();
        const approximateAnchor = offsetFor(anchor);

        if (selectedText.length > 0) {
            // Search the selected visible text directly in the Markdown's
            // visible projection. Prefix arithmetic drifts badly in tables
            // and lists; an exact text match gives a correct range or no
            // range at all. For repeated text, use the occurrence closest to
            // the caret's approximate source position.
            const projection = visibleMarkdownProjection(markdown);
            const sourceAt = (visibleOffset: number): number => {
                if (visibleOffset <= 0) {
                    return 0;
                }

                if (visibleOffset >= projection.map.length) {
                    return markdown.length;
                }

                return projection.map[visibleOffset] ?? markdown.length;
            };

            let selectedIndex = -1;
            let selectedDistance = Number.POSITIVE_INFINITY;
            let searchFrom = 0;

            while (searchFrom <= projection.text.length) {
                const candidate = projection.text.indexOf(selectedText, searchFrom);

                if (candidate < 0) {
                    break;
                }

                const candidateDistance = Math.abs(sourceAt(candidate) - approximateAnchor);

                if (candidateDistance < selectedDistance) {
                    selectedIndex = candidate;
                    selectedDistance = candidateDistance;
                }

                searchFrom = candidate + 1;
            }

            if (selectedIndex >= 0) {
                setRawRange(sourceAt(selectedIndex), sourceAt(selectedIndex + selectedText.length));

                return;
            }

            // Multi-cell/table-row selections contain visual spacing that is
            // absent from the table's text nodes. Fall back to the first and
            // last word of the selected text so the full row still becomes a
            // selection instead of a lone caret.
            const words = selectedText.match(/[\p{L}\p{N}_]+/gu) ?? [];

            if (words.length > 1) {
                const firstWord = words[0]!;
                const lastWord = words[words.length - 1]!;
                const firstIndex = projection.text.indexOf(firstWord);
                const lastIndex =
                    firstIndex < 0 ? -1 : projection.text.indexOf(lastWord, firstIndex);

                if (firstIndex >= 0 && lastIndex >= 0) {
                    setRawRange(sourceAt(firstIndex), sourceAt(lastIndex + lastWord.length));

                    return;
                }
            }
        }

        // A collapsed caret, or a selection whose text cannot be located
        // unambiguously, is published as a caret. A wrong range is worse than
        // no range.
        setRawRange(approximateAnchor, approximateAnchor);
    }

    /**
     * Publish a raw caret to rich viewers. The Markdown offset is converted
     * to visible text (syntax markers are skipped), then to a ProseMirror
     * position and finally to a Yjs XML relative position so the existing
     * CollaborationCaret can render it.
     */
    function updateRawCursor(anchor: number, head: number): void {
        if (destroyed || !ytext || !editor || !options.isMarkdownMode.value || !canEdit.value) {
            return;
        }

        const binding = ySyncPluginKey.getState(editor.state)?.binding;

        if (!binding) {
            return;
        }

        const markdown = ytext.toString();
        const doc = editor.state.doc;
        const textPositions: number[] = [];
        let visibleText = '';
        let firstBlock = true;

        doc.descendants((node, position) => {
            if (node.isText) {
                const value = node.text ?? '';

                for (let index = 0; index < value.length; index++) {
                    textPositions.push(position + index);
                }

                visibleText += value;

                return false;
            }

            if (node.isBlock && !firstBlock && visibleText.length > 0) {
                visibleText += '\n';
                textPositions.push(position);
            }

            if (node.isBlock) {
                firstBlock = false;
            }

            return;
        });

        const positionFor = (sourceOffset: number): number => {
            const visibleOffset = visibleOffsetForMarkdownOffset(markdown, sourceOffset);

            if (visibleOffset <= 0) {
                return Math.min((textPositions[0] ?? 0) + 1, doc.content.size);
            }

            if (visibleOffset >= textPositions.length) {
                return Math.max(
                    (textPositions[textPositions.length - 1] ?? doc.content.size) - 1,
                    0
                );
            }

            return textPositions[visibleOffset] ?? doc.content.size;
        };

        const caretPositionFor = (sourceOffset: number): number => {
            const approximate = positionFor(sourceOffset);
            const projection = visibleMarkdownProjection(markdown);
            const visibleOffset = visibleOffsetForMarkdownOffset(markdown, sourceOffset);

            const findNearest = (needle: string, offsetAfter: boolean): number | null => {
                if (!needle) {
                    return null;
                }

                let found = -1;
                let distance = Number.POSITIVE_INFINITY;
                let from = 0;

                while (from <= visibleText.length) {
                    const index = visibleText.indexOf(needle, from);

                    if (index < 0) {
                        break;
                    }

                    const candidate = Math.abs(
                        (textPositions[index] ?? doc.content.size) - approximate
                    );

                    if (candidate < distance) {
                        found = index;
                        distance = candidate;
                    }

                    from = index + 1;
                }

                if (found < 0) {
                    return null;
                }

                const targetIndex = found + (offsetAfter ? needle.length : 0);

                return targetIndex < textPositions.length
                    ? (textPositions[targetIndex] ?? doc.content.size)
                    : doc.content.size;
            };

            // Table pipes and block separators make long prefix matching
            // fragile. A word token immediately before/after the caret is
            // stable across both representations.
            const before = projection.text.slice(0, visibleOffset);
            const after = projection.text.slice(visibleOffset);
            const tokenBefore = /([A-Za-z0-9_\u00C0-\uFFFF]+)$/.exec(before)?.[1] ?? '';
            const tokenAfter = /^([A-Za-z0-9_\u00C0-\uFFFF]+)/.exec(after)?.[1] ?? '';

            return findNearest(tokenBefore, true) ?? findNearest(tokenAfter, false) ?? approximate;
        };

        const rawFrom = Math.min(anchor, head);
        const rawTo = Math.max(anchor, head);
        const selectedVisible = visibleMarkdownProjection(
            markdown.slice(rawFrom, rawTo)
        ).text.trim();
        const approximateAnchor = positionFor(anchor);

        if (selectedVisible.length > 0) {
            let selectedIndex = -1;
            let selectedDistance = Number.POSITIVE_INFINITY;
            let searchFrom = 0;

            while (searchFrom <= visibleText.length) {
                const candidate = visibleText.indexOf(selectedVisible, searchFrom);

                if (candidate < 0) {
                    break;
                }

                const candidateDistance = Math.abs(
                    (textPositions[candidate] ?? doc.content.size) - approximateAnchor
                );

                if (candidateDistance < selectedDistance) {
                    selectedIndex = candidate;
                    selectedDistance = candidateDistance;
                }

                searchFrom = candidate + 1;
            }

            if (selectedIndex >= 0) {
                const start = textPositions[selectedIndex] ?? 0;
                // Use the last selected character plus one. The position just
                // after a table cell's text is the cell boundary; ProseMirror
                // resolves it to the cell edge and moves the name label there.
                const lastCharIndex = selectedIndex + selectedVisible.length - 1;
                const end = Math.min(
                    (textPositions[lastCharIndex] ?? doc.content.size - 1) + 1,
                    doc.content.size
                );
                const anchorPosition = absolutePositionToRelativePosition(
                    start,
                    binding.type,
                    binding.mapping
                );
                const headPosition = absolutePositionToRelativePosition(
                    end,
                    binding.type,
                    binding.mapping
                );

                rawRichCursorActive = true;
                setAwarenessField('cursor', { anchor: anchorPosition, head: headPosition });

                return;
            }

            // A multi-cell/table-row selection may not exist verbatim because
            // cell boundaries are represented as separate blocks. Use the
            // first and last selected word to span the same cells.
            const words = selectedVisible.match(/[\p{L}\p{N}_]+/gu) ?? [];

            if (words.length > 1) {
                const firstWord = words[0]!;
                const lastWord = words[words.length - 1]!;
                const firstIndex = visibleText.indexOf(firstWord);
                const lastIndex = firstIndex < 0 ? -1 : visibleText.indexOf(lastWord, firstIndex);

                if (firstIndex >= 0 && lastIndex >= 0) {
                    const start = textPositions[firstIndex] ?? 0;
                    // Keep the head inside the final table cell. An endpoint
                    // exactly on the table/cell boundary resolves back to the
                    // row start in ProseMirror and puts the name label there.
                    const lastCharIndex = lastIndex + lastWord.length - 1;
                    const end = Math.min(
                        (textPositions[lastCharIndex] ?? doc.content.size - 1) + 1,
                        doc.content.size
                    );
                    const anchorPosition = absolutePositionToRelativePosition(
                        start,
                        binding.type,
                        binding.mapping
                    );
                    const headPosition = absolutePositionToRelativePosition(
                        end,
                        binding.type,
                        binding.mapping
                    );

                    rawRichCursorActive = true;
                    setAwarenessField('cursor', { anchor: anchorPosition, head: headPosition });

                    return;
                }
            }
        }

        const pmAnchor = caretPositionFor(anchor);
        const pmHead = selectedVisible.length > 0 ? pmAnchor : caretPositionFor(head);
        const anchorPosition = absolutePositionToRelativePosition(
            pmAnchor,
            binding.type,
            binding.mapping
        );
        const headPosition = absolutePositionToRelativePosition(
            pmHead,
            binding.type,
            binding.mapping
        );

        rawRichCursorActive = true;
        setAwarenessField('cursor', { anchor: anchorPosition, head: headPosition });
    }

    /**
     * Re-announce the local identity after a reconnect or visibility change.
     * Hocuspocus may publish an empty awareness map during a reconnect, so
     * setting these fields only once at construction lets other users vanish
     * until the page is reloaded.
     */
    function applyLocalPresence(): void {
        const awareness = provider.value?.awareness;

        if (!awareness || destroyed) {
            return;
        }

        awareness.setLocalStateField('user', localUser);
        awareness.setLocalStateField('mode', options.isMarkdownMode.value ? 'raw' : 'rich');

        if (editingActive) {
            awareness.setLocalStateField('editing', true);
        }
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
            void ensureMirrors().then(() => finishReady());
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

        if (
            keepaliveSnapshot(snapshotUrl, lastMarkdown, baseSeq) ||
            beaconSnapshot(snapshotUrl, lastMarkdown, baseSeq)
        ) {
            lastSentMarkdown = lastMarkdown;
        }
    }

    function onWindowBlur(): void {
        // Keep the last cursor. Clearing it on focusout made collaborators
        // blink out whenever the user clicked a toolbar, a link preview or
        // another application.
        endEditing();
        void flush();
    }

    function onVisibilityChange(): void {
        if (document.visibilityState === 'hidden') {
            endEditing();
            flushOnPageHide();

            return;
        }

        applyLocalPresence();
    }

    function textObserver(_event: Y.YTextEvent, _transaction: Y.Transaction): void {
        if (!ytext || destroyed) {
            return;
        }

        const next = ytext.toString();
        lastMarkdown = next;

        if (isReady.value && next !== lastSentMarkdown) {
            scheduleSnapshot();
        }

        // A rich edit writes its serialization into Y.Text. If that merge also
        // contains a raw edit which has not reached the fragment yet, the raw
        // owner still has to project it. Comparing against the last projected
        // value avoids an echo for the rich change itself.
        if (isProjectionOwner() && next !== lastProjectedMarkdown) {
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
                applyLocalPresence();
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
                    applyLocalPresence();
                    handleSynced();
                } else {
                    setStatus('reconnecting');
                }
            },
            onDisconnect: ({ event }) => handleClose(event.code),
            onClose: ({ event }) => handleClose(event.code),
            onAwarenessChange: updateParticipants,
        });

        const awareness = provider.value.awareness;

        if (awareness) {
            const setLocalStateField = awareness.setLocalStateField.bind(awareness);

            // yCursorPlugin clears the local cursor on focusout. Presence should
            // keep the last rich position instead of blinking out when another
            // user or window gets focus.
            awareness.setLocalStateField = (field: string, value: unknown): void => {
                if (
                    field === 'cursor' &&
                    value === null &&
                    ((!options.isMarkdownMode.value && lastRichCursor !== null) ||
                        (options.isMarkdownMode.value && rawRichCursorActive))
                ) {
                    // The hidden TipTap editor still runs yCursorPlugin in raw
                    // mode. It must not clear the approximate rich cursor we
                    // publish for this raw selection.
                    return;
                }

                setLocalStateField(field, value);
            };
        }

        provider.value.setAwarenessField('user', localUser);
        provider.value.setAwarenessField('mode', options.isMarkdownMode.value ? 'raw' : 'rich');
        provider.value.setAwarenessField('editing', false);
        provider.value.setAwarenessField('editingSince', 0);
        provider.value.setAwarenessField('rawCursor', null);

        // Awareness entries are heartbeated by the provider, but a tab that
        // was throttled or briefly offline can be dropped by the server.
        // Re-announcing identity periodically keeps collaborators visible
        // without waiting for a reload.
        presenceHeartbeatTimer = setInterval(applyLocalPresence, 10_000);
        updateParticipants();

        window.addEventListener('blur', onWindowBlur);
        document.addEventListener('visibilitychange', onVisibilityChange);
        window.addEventListener('pagehide', flushOnPageHide);
        window.addEventListener('beforeunload', flushOnPageHide);
    }

    watch(options.isMarkdownMode, markdownMode => {
        rawRichCursorActive = false;
        setAwarenessField('mode', markdownMode ? 'raw' : 'rich');
        clearRawCursor();
        endEditing();
        applyLocalPresence();

        if (markdownMode) {
            // The TipTap caret is meaningless in raw mode; clear it so rich
            // viewers do not show a frozen caret for this user.
            lastRichCursor = null;
            setAwarenessField('cursor', null);
        }

        // Leaving raw mode must not show a stale rich pane. Flush accumulated
        // raw Markdown even if another rich editor is currently typing; the
        // merge already includes the rich side's latest mirror.
        if (!markdownMode && ytext && isProjectionOwner()) {
            if (richProjectionTimer) {
                clearTimeout(richProjectionTimer);
                richProjectionTimer = null;
            }

            if (ytext.toString() !== lastProjectedMarkdown) {
                void applyMarkdownToRich(ytext.toString());
            }

            if (editor) {
                updateRichCursor(editor.state.selection.anchor, editor.state.selection.head);
            }
        }
    });

    watch(options.isEditMode, editMode => {
        if (!editMode) {
            endEditing();
        }
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

        if (presenceHeartbeatTimer) {
            clearInterval(presenceHeartbeatTimer);
            presenceHeartbeatTimer = null;
        }

        if (participantClearTimer) {
            clearTimeout(participantClearTimer);
            participantClearTimer = null;
        }

        pendingProjection = null;
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
        editorOptions,
        localUser,
        attachEditor,
        onContentChange,
        updateRichBase,
        updateRichCursor,
        updateRawCursor,
        clearRawCursor,
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
