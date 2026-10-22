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
    selection: [anchor: number, head: number];
}>();

const host = ref<HTMLElement | null>(null);

let view: EditorView | null = null;
let undoManager: Y.UndoManager | null = null;
let readyForUserInput = false;

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
    '.cm-cursor, .cm-dropCursor': {
        borderLeftColor: 'currentColor',
    },
    '.cm-selectionBackground, ::selection': {
        backgroundColor: 'color-mix(in srgb, #5893e7 32%, transparent) !important',
    },
    '&.cm-focused .cm-selectionBackground': {
        backgroundColor: 'color-mix(in srgb, #5893e7 38%, transparent) !important',
    },
    '.cm-scroller': {
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        lineHeight: '1.6',
        overflow: 'auto',
        padding: '24px 0 16px',
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
            // yCollab clears the cursor on focusout. Keep the last raw
            // position so another user's presence does not blink out when the
            // writer clicks a toolbar or another window.
            if (field === 'cursor' && value === null) {
                const state = real.getLocalState() as { rawCursor?: unknown } | null;

                if (state?.rawCursor) {
                    return;
                }
            }

            real.setLocalStateField(field === 'cursor' ? 'rawCursor' : field, value);
        },
        on: real.on.bind(real),
        off: real.off.bind(real),
    } as unknown as Awareness;
}

function destroyEditor(): void {
    readyForUserInput = false;
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
                    if (!readyForUserInput) {
                        return;
                    }

                    const remoteSync = update.transactions.some(
                        transaction => transaction.annotation(ySyncAnnotation) !== undefined
                    );

                    if (update.selectionSet) {
                        if (!remoteSync) {
                            emit(
                                'selection',
                                update.state.selection.main.anchor,
                                update.state.selection.main.head
                            );
                        }

                        emit('activity');
                    }

                    const userChange = update.transactions.some(
                        transaction =>
                            transaction.isUserEvent('input') ||
                            transaction.isUserEvent('delete') ||
                            transaction.isUserEvent('paste') ||
                            transaction.isUserEvent('undo') ||
                            transaction.isUserEvent('redo')
                    );

                    if (update.docChanged && !remoteSync && userChange) {
                        emit('activity');
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
    // yCollab performs an initial document sync after mount. That is not a
    // user edit; mark the editor ready only after the initial render settles.
    setTimeout(() => {
        readyForUserInput = true;
        emit(
            'selection',
            view?.state.selection.main.anchor ?? 0,
            view?.state.selection.main.head ?? 0
        );
    }, 100);
}

onMounted(createEditor);

watch(
    () => [props.ytext, props.awareness, props.editable, props.spellcheck],
    () => createEditor()
);

function focusVisibleLine(): void {
    if (!view) {
        return;
    }

    const scrollerRect = view.scrollDOM.getBoundingClientRect();
    const line = [...view.contentDOM.querySelectorAll<HTMLElement>('.cm-line')].find(
        candidate =>
            candidate.getBoundingClientRect().bottom > scrollerRect.top + 1 &&
            (candidate.textContent ?? '').length > 0
    );

    if (!line) {
        return;
    }

    const lineStart = view.posAtDOM(line, 0);
    // A selection exactly at a line boundary is not drawn by all browsers.
    // Put the caret one character inside the first visible line.
    const position = Math.min(view.state.doc.length, lineStart + 1);
    view.dispatch({
        selection: { anchor: position, head: position },
        scrollIntoView: false,
    });
    view.focus();
}

onBeforeUnmount(destroyEditor);

defineExpose({ focusVisibleLine });
</script>

<template>
    <div ref="host" class="h-full overflow-hidden"></div>
</template>
