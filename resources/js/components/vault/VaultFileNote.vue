<script setup lang="ts">
import VaultNodeController from '@/actions/App/Http/Controllers/VaultNodeController';
import CollaborationStatus from '@/components/editor/CollaborationStatus.vue';
import RawMarkdownEditor from '@/components/editor/RawMarkdownEditor.vue';
import { useEditor } from '@/composables/useEditor';
import { useNoteCollaboration } from '@/composables/useCollaboration';
import { useTiptapPreferences } from '@/composables/useTiptapPreferences';
import { useRequest } from '@/composables/useRequest';
import { useVaultActions } from '@/composables/useVaultActions';
import { useVaultFileUpload } from '@/composables/useVaultFileUpload';
import { useLayoutStore } from '@/stores/layout';
import { AppPageProps } from '@/types';
import { EditorContext } from '@/types/editor';
import { VaultNode } from '@/types/vault';
import { usePage } from '@inertiajs/vue3';
import { computed, inject, nextTick, onMounted, onUnmounted, ref, ShallowRef, watch } from 'vue';

interface VaultFileNodeProps {
    node: VaultNode;
}

interface VaultFileNodeEmits {
    contentUpdated: [content: string];
}

const props = defineProps<VaultFileNodeProps>();
const emit = defineEmits<VaultFileNodeEmits>();

const editorContext = inject<ShallowRef<EditorContext | null>>('editorContext');

if (!editorContext) {
    throw new Error('editorContext is not provided');
}

const page = usePage<AppPageProps>();
const layoutStore = useLayoutStore();
const vaultActions = useVaultActions();
const { importFiles } = useVaultFileUpload();
const { isEditMode, isEditingMarkdown, isSpellcheckEnabled } = useTiptapPreferences();

const form = useRequest<{ content: string }>({ content: props.node.content ?? '' });

const noteEditorRef = ref<HTMLElement | null>(null);
const noteMarkdownRef = ref<HTMLElement | null>(null);
const rawEditorRef = ref<{ focusVisibleLine: () => void } | null>(null);

let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let isUnmounted = false;

const collaborationConfig = computed(
    () => page.props.collaboration ?? { enabled: false, url: '/yjs' }
);
const isMarkdownNote = props.node.type === 'note' && props.node.extension === 'md';
const collaboration = useNoteCollaboration({
    vaultId: props.node.vault_id,
    nodeId: props.node.id,
    markdown: props.node.content ?? '',
    user: {
        id: page.props.app?.user?.id ?? 0,
        name: page.props.app?.user?.name ?? 'Unknown user',
    },
    enabled: collaborationConfig.value.enabled && isMarkdownNote,
    url: collaborationConfig.value.url,
    isEditMode,
    isMarkdownMode: isEditingMarkdown,
});

const {
    isLive,
    status,
    isReady,
    canEdit,
    snapshotError,
    tokenError,
    participants,
    attachEditor,
    onContentChange,
    updateRichBase,
    updateRichCursor,
    updateRawCursor,
    getMarkdown,
    beginEditing,
    noteEditingActivity,
    endEditing,
    clearRawCursor,
    updateSnapshotSeq,
    ytext,
    provider,
} = collaboration;

const effectiveEditMode = computed(
    () => isEditMode.value && (!isLive.value || (isReady.value && canEdit.value))
);

const showMarkdownEditor = computed(() => isEditingMarkdown.value);
const rawAwareness = computed(() => provider.value?.awareness ?? null);

function findScrollableAncestor(element: Element | null): HTMLElement | null {
    let current = element?.parentElement ?? null;

    while (current) {
        const style = getComputedStyle(current);

        if (
            (style.overflowY === 'auto' || style.overflowY === 'scroll') &&
            current.scrollHeight > current.clientHeight + 1
        ) {
            return current;
        }

        current = current.parentElement;
    }

    return null;
}

function scrollElementFor(rawMode: boolean): HTMLElement | null {
    if (rawMode) {
        return document.querySelector<HTMLElement>('.cm-scroller');
    }

    return findScrollableAncestor(document.querySelector('.ProseMirror'));
}

function captureScrollRatio(rawMode: boolean): number | null {
    const scroller = scrollElementFor(rawMode);

    if (!scroller) {
        return null;
    }

    const maxScroll = scroller.scrollHeight - scroller.clientHeight;

    return maxScroll > 0 ? scroller.scrollTop / maxScroll : null;
}

async function restoreScrollRatio(rawMode: boolean, ratio: number | null): Promise<void> {
    if (ratio === null) {
        return;
    }

    await nextTick();

    // CodeMirror creates its scroller one tick after the pane is mounted.
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));

    const scroller = scrollElementFor(rawMode);

    if (!scroller) {
        return;
    }

    const maxScroll = scroller.scrollHeight - scroller.clientHeight;

    if (maxScroll > 0) {
        scroller.scrollTop = ratio * maxScroll;
    }
}

interface ScrollAnchor {
    key: string;
    offset: number;
}

function scrollAnchorKey(text: string): string {
    return text
        .replace(/^#+\s*/, '')
        .replace(/^[-*+]\s+\[[ x]\]\s*/i, '')
        .replace(/^[-*+]\s+/, '')
        .replace(/^\d+\.\s+/, '')
        .replace(/^\|/, '')
        .replace(/\|/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 64);
}

function captureScrollAnchor(rawMode: boolean): ScrollAnchor | null {
    const scroller = scrollElementFor(rawMode);

    if (!scroller) {
        return null;
    }

    const top = scroller.getBoundingClientRect().top;
    const candidates = rawMode
        ? [...scroller.querySelectorAll<HTMLElement>('.cm-line')]
        : [...document.querySelectorAll<HTMLElement>('.ProseMirror > *')];

    for (const candidate of candidates) {
        const rect = candidate.getBoundingClientRect();
        const key = scrollAnchorKey(candidate.textContent ?? '');

        if (rect.bottom > top + 1 && key.length > 0) {
            return { key, offset: rect.top - top };
        }
    }

    return null;
}

async function restoreScrollAnchor(
    rawMode: boolean,
    anchor: ScrollAnchor | null,
    ratio: number | null
): Promise<void> {
    if (anchor === null) {
        return;
    }

    await nextTick();

    const scroller = scrollElementFor(rawMode);

    if (!scroller) {
        return;
    }

    if (ratio !== null) {
        const maxScroll = scroller.scrollHeight - scroller.clientHeight;

        if (maxScroll > 0) {
            scroller.scrollTop = ratio * maxScroll;
        }

        await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    }

    const candidates = rawMode
        ? [...scroller.querySelectorAll<HTMLElement>('.cm-line')]
        : [...document.querySelectorAll<HTMLElement>('.ProseMirror > *')];
    const target = candidates.find(candidate =>
        scrollAnchorKey(candidate.textContent ?? '').includes(anchor.key)
    );

    if (!target) {
        return;
    }

    const targetTop = target.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
    scroller.scrollTop += targetTop - anchor.offset;
}

function handleLegacyRawInput(): void {
    if (!isLive.value) {
        void onMarkdownChanged(noteMarkdownRef.value?.textContent ?? '');
    }
}

function handleRawFocus(): void {
    if (isLive.value) {
        beginEditing();
    }
}

function handleRawBlur(): void {
    if (isLive.value) {
        endEditing();
        void collaboration.flush();
    }
}

function handleRawSelection(anchor: number, head: number): void {
    if (isLive.value) {
        updateRawCursor(anchor, head);
    }
}
const { editor, setContent, replaceContent, rewriteVaultLinks, onMarkdownChanged, readMarkdown } =
    useEditor({
        vaultId: String(props.node.vault_id),
        element: noteEditorRef,
        markdownElement: noteMarkdownRef,
        autofocus: false,
        content: isLive.value ? '' : (props.node.content ?? ''),
        isEditMode: effectiveEditMode,
        collaboration: collaboration.editorOptions.value,
        onEditorReady: attachEditor,
        onRemoteUpdate: updateRichBase,
        onFocus: () => {
            if (isLive.value) {
                beginEditing();
            }
        },
        onActivity: () => {
            if (isLive.value) {
                noteEditingActivity();
            }
        },
        onSelectionChange: (anchor, head) => {
            if (isLive.value) {
                updateRichCursor(anchor, head);
            }
        },
        onBlur: () => {
            if (isLive.value) {
                endEditing();
                void collaboration.flush();
            }
        },
        onUpdate: (markdown: string) => {
            if (isLive.value) {
                // useEditor suppresses remote ySync/projection transactions,
                // so this mirror write only turns local rich edits into
                // Markdown. Remote projections must not overwrite raw source.
                onContentChange(markdown);

                return;
            }

            if (debounceTimer) {
                clearTimeout(debounceTimer);
            }

            debounceTimer = setTimeout(() => {
                const url = VaultNodeController.update.url({
                    vault: props.node.vault_id,
                    node: props.node.id,
                });

                layoutStore.setVaultNodeUpdating(true);

                form.content = markdown;

                form.patch(url, {
                    onFailure: () => {
                        if (isUnmounted) {
                            return;
                        }

                        emit('contentUpdated', props.node.content ?? '');
                        editorContext.value?.setContent(props.node.content ?? '');
                    },
                    onSuccess: (response: { data: VaultNode }) => {
                        emit('contentUpdated', response.data.content ?? '');
                    },
                    onFinish: () => {
                        layoutStore.setVaultNodeUpdating(false);
                    },
                });
            }, 1000);
        },
        openFilePath: vaultActions.openFilePath,
        uploadFiles: request =>
            importFiles({
                vaultId: props.node.vault_id,
                parentId: props.node.parent_id,
                files: request.files,
                onSuccess: request.onSuccess,
                onFinish: request.onFinish,
            }),
    });

onMounted(() => {
    editorContext.value = {
        editor,
        setContent,
        replaceContent,
        rewriteVaultLinks,
        onMarkdownChanged,
        readMarkdown: () => (isLive.value ? getMarkdown() : readMarkdown()),
        isCollaborative: isLive.value,
        collaboration,
        updateSnapshotSeq,
    };
});

watch(isEditingMarkdown, (markdownMode, previousMode) => {
    if (!isLive.value) {
        return;
    }

    // Carry the first visible block across panes so the same text stays at
    // the same screen position. Fall back to a relative scroll ratio when the
    // visible block cannot be identified (for example an empty editor).
    const scrollAnchor = captureScrollAnchor(previousMode);
    const scrollRatio = captureScrollRatio(previousMode);

    if (markdownMode) {
        endEditing();
    } else {
        endEditing();
        clearRawCursor();
        noteEditingActivity();
    }

    void (async () => {
        if (scrollAnchor) {
            await restoreScrollAnchor(markdownMode, scrollAnchor, scrollRatio);
        } else {
            await restoreScrollRatio(markdownMode, scrollRatio);
        }

        if (markdownMode) {
            await nextTick();
            await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
            rawEditorRef.value?.focusVisibleLine();
        }
    })();
});

onUnmounted(() => {
    isUnmounted = true;

    if (debounceTimer) {
        clearTimeout(debounceTimer);
    }
});
</script>

<template>
    <div class="flex h-full w-full flex-col">
        <CollaborationStatus
            v-if="isLive"
            :status="status"
            :participants="participants"
            :snapshot-error="snapshotError"
            :token-error="tokenError"
            :can-edit="canEdit"
        />

        <div
            ref="noteEditorRef"
            class="h-full px-4"
            :class="showMarkdownEditor ? 'hidden' : ''"
            :spellcheck="isSpellcheckEnabled"
        ></div>

        <RawMarkdownEditor
            v-if="isLive && showMarkdownEditor"
            ref="rawEditorRef"
            :ytext="ytext"
            :awareness="rawAwareness"
            :editable="effectiveEditMode"
            :spellcheck="isSpellcheckEnabled"
            @focus="handleRawFocus"
            @blur="handleRawBlur"
            @activity="noteEditingActivity"
            @selection="handleRawSelection"
        />

        <div
            v-else-if="!isLive"
            ref="noteMarkdownRef"
            class="h-full px-4 py-6 font-mono text-sm leading-6 break-words whitespace-break-spaces focus:outline-none"
            :class="showMarkdownEditor ? '' : 'hidden'"
            :contenteditable="effectiveEditMode ? 'plaintext-only' : 'false'"
            :spellcheck="isSpellcheckEnabled"
            @input="handleLegacyRawInput"
            @focus="handleRawFocus"
            @blur="handleRawBlur"
        />
    </div>
</template>
