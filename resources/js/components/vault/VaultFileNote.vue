<script setup lang="ts">
import VaultNodeController from '@/actions/App/Http/Controllers/VaultNodeController';
import CollaborationStatus from '@/components/editor/CollaborationStatus.vue';
import { useEditor } from '@/composables/useEditor';
import { useNoteCollaboration } from '@/composables/useCollaboration';
import { useTiptapPreferences } from '@/composables/useTiptapPreferences';
import { useRequest } from '@/composables/useRequest';
import { useVaultActions } from '@/composables/useVaultActions';
import { useVaultFileUpload } from '@/composables/useVaultFileUpload';
import { diffText, mapTextOffset } from '@/services/collaborationMarkdown';
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

let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let isUnmounted = false;
let isRawComposing = false;

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
    markdownVersion,
    modeLocked,
    modeLockedBy,
    modeLockedMode,
    attachEditor,
    onContentChange,
    onRawMarkdownChange,
    getMarkdown,
    beginEditing,
    noteEditingActivity,
    endEditing,
    updateSnapshotSeq,
} = collaboration;

const effectiveEditMode = computed(
    () =>
        isEditMode.value && (!isLive.value || (isReady.value && canEdit.value && !modeLocked.value))
);

const showMarkdownEditor = computed(() => isEditingMarkdown.value);

function selectionOffsets(): { anchor: number; focus: number } | null {
    const element = noteMarkdownRef.value;
    const selection = window.getSelection();

    if (!element || !selection || selection.rangeCount === 0) {
        return null;
    }

    const range = selection.getRangeAt(0);

    if (!element.contains(range.startContainer) || !element.contains(range.endContainer)) {
        return null;
    }

    const beforeStart = document.createRange();
    beforeStart.selectNodeContents(element);
    beforeStart.setEnd(range.startContainer, range.startOffset);

    const beforeEnd = document.createRange();
    beforeEnd.selectNodeContents(element);
    beforeEnd.setEnd(range.endContainer, range.endOffset);

    return {
        anchor: beforeStart.toString().length,
        focus: beforeEnd.toString().length,
    };
}

function setRawSelection(anchor: number, focus: number): void {
    const element = noteMarkdownRef.value;
    const node = element?.firstChild;

    if (!element || !node) {
        return;
    }

    const length = element.textContent?.length ?? 0;
    const selection = window.getSelection();

    if (!selection) {
        return;
    }

    selection.setBaseAndExtent(
        node,
        Math.min(Math.max(anchor, 0), length),
        node,
        Math.min(Math.max(focus, 0), length)
    );
}

function setRawMarkdown(markdown: string, preserveCaret = false): void {
    const element = noteMarkdownRef.value;

    if (!element || element.textContent === markdown) {
        return;
    }

    const offsets = preserveCaret ? selectionOffsets() : null;
    const change = diffText(element.textContent ?? '', markdown);

    element.textContent = markdown;

    if (offsets && change) {
        setRawSelection(
            mapTextOffset(offsets.anchor, change),
            mapTextOffset(offsets.focus, change)
        );
    }
}

function handleRawInput(): void {
    const element = noteMarkdownRef.value;

    if (!element || isRawComposing) {
        return;
    }

    const markdown = element.textContent ?? '';

    if (!isLive.value) {
        void onMarkdownChanged(markdown);

        return;
    }

    if (!beginEditing()) {
        setRawMarkdown(getMarkdown());

        return;
    }

    noteEditingActivity();
    onRawMarkdownChange(markdown);
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

function handleRawCompositionStart(): void {
    isRawComposing = true;
}

function handleRawCompositionEnd(): void {
    isRawComposing = false;
    handleRawInput();
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
        onBlur: () => {
            if (isLive.value) {
                endEditing();
                void collaboration.flush();
            }
        },
        onUpdate: (markdown: string) => {
            if (isLive.value) {
                // Remote TipTap renderings and the initial Yjs sync also emit
                // updates, but the mirror write is idempotent. Only a focused
                // editor claims the lease, through onActivity above.
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

    if (isLive.value && isEditingMarkdown.value) {
        void nextTick(() => {
            setRawMarkdown(getMarkdown());
            noteMarkdownRef.value?.focus();
        });
    }
});

watch([markdownVersion, isReady], ([, ready]) => {
    if (!isLive.value || !ready) {
        return;
    }

    void nextTick(() => {
        if (!isRawComposing && isEditingMarkdown.value) {
            setRawMarkdown(getMarkdown(), true);
        }
    });
});

watch(isEditingMarkdown, markdownMode => {
    if (!isLive.value) {
        return;
    }

    if (markdownMode) {
        endEditing();
        void nextTick(() => {
            setRawMarkdown(getMarkdown());
            noteMarkdownRef.value?.focus();
        });
    } else {
        endEditing();
        noteEditingActivity();
    }
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
            :mode-locked="modeLocked"
            :mode-locked-by="modeLockedBy"
            :mode-locked-mode="modeLockedMode"
        />

        <div
            ref="noteEditorRef"
            class="h-full px-4"
            :class="showMarkdownEditor ? 'hidden' : ''"
            :spellcheck="isSpellcheckEnabled"
        ></div>

        <div
            ref="noteMarkdownRef"
            class="h-full px-4 py-6 font-mono text-sm leading-6 break-words whitespace-break-spaces focus:outline-none"
            :class="showMarkdownEditor ? '' : 'hidden'"
            :contenteditable="effectiveEditMode ? 'plaintext-only' : 'false'"
            :spellcheck="isSpellcheckEnabled"
            @input="handleRawInput"
            @focus="handleRawFocus"
            @blur="handleRawBlur"
            @click="noteEditingActivity"
            @keydown="noteEditingActivity"
            @compositionstart="handleRawCompositionStart"
            @compositionend="handleRawCompositionEnd"
        />
    </div>
</template>
