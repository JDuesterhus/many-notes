<script setup lang="ts">
import { defaultKeymap, indentWithTab } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { EditorState } from '@codemirror/state';
import {
    drawSelection,
    dropCursor,
    EditorView,
    highlightSpecialChars,
    keymap,
} from '@codemirror/view';
import type { Awareness } from 'y-protocols/awareness';
import { yCollab, ySyncAnnotation, yUndoManagerKeymap } from 'y-codemirror.next';
import * as Y from 'yjs';
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';

const props = defineProps<{
    ytext: Y.Text | null;
    awareness: Awareness | null;
    editable: boolean;
    spellcheck: boolean;
}>();

const emit = defineEmits<{
    focus: [];
    blur: [];
    activity: [];
    change: [];
}>();

const host = ref<HTMLElement | null>(null);

let view: EditorView | null = null;
let undoManager: Y.UndoManager | null = null;

const editorTheme = EditorView.theme({
    '&': {
        backgroundColor: 'transparent',
        color: 'inherit',
        fontSize: '13px',
        height: '100%',
    },
    '&.cm-focused': {
        outline: 'none',
    },
    '.cm-content': {
        caretColor: 'currentColor',
        padding: '0 16px',
    },
    '.cm-scroller': {
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        lineHeight: '1.6',
        overflow: 'auto',
        padding: '16px 0',
    },
    '.cm-gutters': {
        backgroundColor: 'transparent',
        border: 'none',
        color: 'color-mix(in srgb, currentColor 35%, transparent)',
    },
    '.cm-activeLine': {
        backgroundColor: 'color-mix(in srgb, currentColor 4%, transparent)',
    },
    '.cm-activeLineGutter': {
        backgroundColor: 'transparent',
    },
    '.cm-ySelectionInfo': {
        borderRadius: '3px 3px 3px 0',
        fontSize: '9px',
        fontWeight: '600',
        lineHeight: '1',
        opacity: '1',
        padding: '1px 3px',
        transition: 'none',
    },
});

/**
 * y-codemirror.next stores its text cursors in the `cursor` awareness field.
 * TipTap already owns that field with Yjs relative positions, so translate the
 * CodeMirror cursor to `rawCursor` and back. This keeps both editors independent
 * without a second Awareness instance.
 */
function cursorAwareness(real: Awareness): Awareness {
    return {
        clientID: real.clientID,
        doc: real.doc,
        getStates: () => {
            const states = new Map();

            real.getStates().forEach((state, clientId) => {
                const presence = state as { rawCursor?: unknown };

                states.set(clientId, { ...state, cursor: presence.rawCursor ?? null });
            });

            return states;
        },
        getLocalState: () => {
            const state = real.getLocalState();

            if (!state) {
                return null;
            }

            const presence = state as { rawCursor?: unknown };

            return { ...state, cursor: presence.rawCursor ?? null };
        },
        setLocalStateField: (field: string, value: unknown) => {
            real.setLocalStateField(field === 'cursor' ? 'rawCursor' : field, value);
        },
        on: real.on.bind(real),
        off: real.off.bind(real),
    } as unknown as Awareness;
}

function destroyEditor(): void {
    view?.destroy();
    view = null;
    undoManager?.destroy();
    undoManager = null;
}

function createEditor(): void {
    destroyEditor();

    if (!host.value || !props.ytext || !props.awareness) {
        return;
    }

    undoManager = new Y.UndoManager(props.ytext);

    view = new EditorView({
        parent: host.value,
        state: EditorState.create({
            doc: props.ytext.toString(),
            extensions: [
                highlightSpecialChars(),
                drawSelection(),
                dropCursor(),
                EditorView.lineWrapping,
                markdown(),
                keymap.of([...yUndoManagerKeymap, ...defaultKeymap, indentWithTab]),
                yCollab(props.ytext, cursorAwareness(props.awareness), { undoManager }),
                EditorView.editable.of(props.editable),
                EditorView.contentAttributes.of({
                    spellcheck: props.spellcheck ? 'true' : 'false',
                }),
                EditorView.updateListener.of(update => {
                    const remoteSync = update.transactions.some(
                        transaction => transaction.annotation(ySyncAnnotation) !== undefined
                    );

                    if (update.selectionSet) {
                        emit('activity');
                    }

                    if (update.docChanged && !remoteSync) {
                        emit('activity');
                        emit('change');
                    }
                }),
                EditorView.domEventHandlers({
                    focus: () => emit('focus'),
                    blur: () => emit('blur'),
                }),
                editorTheme,
            ],
        }),
    });

    view.focus();
}

onMounted(createEditor);

watch(
    () => [props.ytext, props.awareness, props.editable, props.spellcheck],
    () => createEditor()
);

onBeforeUnmount(destroyEditor);
</script>

<template>
    <div ref="host" class="h-full overflow-hidden"></div>
</template>
