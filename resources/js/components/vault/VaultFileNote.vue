<script setup lang="ts">
import VaultNodeController from '@/actions/App/Http/Controllers/VaultNodeController';
import CollaborationStatus from '@/components/editor/CollaborationStatus.vue';
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
import { computed, inject, onMounted, onUnmounted, ref, ShallowRef } from 'vue';

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
const { isEditMode, isEditingMarkdown, isSpellcheckEnabled, toggleEditingMarkdown } =
    useTiptapPreferences();

const form = useRequest<{ content: string }>({ content: props.node.content ?? '' });

const noteEditorRef = ref<HTMLElement | null>(null);
const noteMarkdownRef = ref<HTMLElement | null>(null);

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
    updateSnapshotSeq,
} = collaboration;

const effectiveEditMode = computed(
    () => isEditMode.value && (!isLive.value || (isReady.value && canEdit.value))
);

const showMarkdownEditor = computed(() => !isLive.value && isEditingMarkdown.value);

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
        onBlur: () => {
            if (isLive.value) {
                void collaboration.flush();
            }
        },
        onUpdate: (markdown: string) => {
            if (isLive.value) {
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
    if (isLive.value && isEditingMarkdown.value) {
        // A live note has exactly one document: the Yjs document edited through
        // TipTap. The raw Markdown pane would be a second source of truth.
        toggleEditingMarkdown();
    }

    editorContext.value = {
        editor,
        setContent,
        replaceContent,
        rewriteVaultLinks,
        onMarkdownChanged,
        readMarkdown,
        isCollaborative: isLive.value,
        collaboration,
        updateSnapshotSeq,
    };
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

        <div
            v-if="!isLive"
            ref="noteMarkdownRef"
            class="h-full px-4 break-words whitespace-break-spaces focus:outline-none"
            :class="showMarkdownEditor ? '' : 'hidden'"
            :contenteditable="isEditMode ? 'plaintext-only' : 'false'"
            :spellcheck="isSpellcheckEnabled"
            @input="onMarkdownChanged(noteMarkdownRef?.textContent ?? '')"
        />
    </div>
</template>
