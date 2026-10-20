import type { useNoteCollaboration } from '@/composables/useCollaboration';
import type { Editor } from '@tiptap/core';
import type { ShallowRef } from 'vue';

export interface EditorContext {
    editor: ShallowRef<Editor | null>;
    setContent: (markdown: string) => Promise<void>;
    replaceContent: (markdown: string) => Promise<void>;
    rewriteVaultLinks: (originalPath: string, replacementPath: string, extension: string) => void;
    onMarkdownChanged: (markdown: string) => Promise<void>;
    readMarkdown: () => string;
    isCollaborative: boolean;
    collaboration: ReturnType<typeof useNoteCollaboration>;
    updateSnapshotSeq: (sequence: number) => void;
}
