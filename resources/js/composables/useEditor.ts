import { markdownToHTML, prepareTiptapHTML } from '@/services/markdown';
import { CustomCodeBlockLowlight } from '@/services/tiptap/extension-custom-code-block-low-light';
import { CustomImage } from '@/services/tiptap/extension-custom-image';
import { CustomLink } from '@/services/tiptap/extension-custom-link';
import { CustomTableCell } from '@/services/tiptap/extension-custom-table-cell';
import { CustomTableColumnAlign } from '@/services/tiptap/extension-custom-table-column-align';
import { CustomTableHeader } from '@/services/tiptap/extension-custom-table-header';
import { CustomTaskItem } from '@/services/tiptap/extension-custom-task-item';
import { Hashtag } from '@/services/tiptap/extension-hashtag';
import { SmartBracket } from '@/services/tiptap/extension-smart-bracket';
import { VaultFileDrop } from '@/services/tiptap/extension-vault-file-drop';
import {
    VaultFileUpload,
    VaultFileUploadRequest,
} from '@/services/tiptap/extension-vault-file-upload';
import { turndownService } from '@/services/turndown';
import type { EditorCollaboration, PresenceUser } from '@/types/collaboration';
import { Editor } from '@tiptap/core';
import Collaboration from '@tiptap/extension-collaboration';
import CollaborationCaret from '@tiptap/extension-collaboration-caret';
import { Table, TableRow } from '@tiptap/extension-table';
import TaskList from '@tiptap/extension-task-list';
import StarterKit from '@tiptap/starter-kit';
import { common, createLowlight } from 'lowlight';
import { onMounted, onUnmounted, Ref, shallowRef, watch } from 'vue';

interface SetupEditorOptions {
    vaultId: string;
    element: Ref<HTMLElement | null>;
    markdownElement: Ref<HTMLElement | null>;
    autofocus?: boolean;
    content: string;
    isEditMode: Readonly<Ref<boolean>>;
    onUpdate: (markdown: string) => void;
    onBlur?: () => void;
    openFilePath: (path: string) => void;
    uploadFiles: (request: VaultFileUploadRequest) => void;
    collaboration?: EditorCollaboration | null;
    onEditorReady?: (
        editor: Editor,
        setContent: (markdown: string) => Promise<void>,
        readMarkdown: () => string
    ) => void;
}

function renderCollaborationCaret(user: PresenceUser): HTMLElement {
    const caret = document.createElement('span');
    caret.className = 'collaboration-carets__caret';
    caret.style.borderColor = user.color;

    const label = document.createElement('span');
    label.className = 'collaboration-carets__label';
    label.style.backgroundColor = user.color;
    label.textContent = user.name;
    label.title = user.name;
    label.setAttribute('aria-label', user.name);

    caret.appendChild(label);

    return caret;
}

export function useEditor(options: SetupEditorOptions) {
    const editor = shallowRef<Editor | null>(null);
    const collaboration = options.collaboration ?? null;
    let isSyncing: boolean = true;

    const content = !collaboration && options.content ? markdownToHTML(options.content) : '';

    const readMarkdown = (): string => {
        const instance = editor.value;

        if (!instance) {
            return '';
        }

        const html = prepareTiptapHTML(instance.getHTML());

        return turndownService.turndown(html);
    };

    onMounted(() => {
        editor.value = new Editor({
            element: options.element.value,
            autofocus: options.autofocus,
            extensions: [
                StarterKit.configure({
                    code: {
                        HTMLAttributes: {
                            class: 'not-prose px-1 py-0.5 text-sm rounded-sm bg-light-base-400 dark:bg-base-700',
                        },
                    },
                    codeBlock: false,
                    link: false,
                    ...(collaboration ? { undoRedo: false } : {}),
                }),
                SmartBracket,
                Hashtag,
                CustomCodeBlockLowlight.configure({
                    defaultLanguage: 'plaintext',
                    lowlight: createLowlight(common),
                }),
                CustomImage.configure({
                    vaultId: options.vaultId,
                }),
                CustomLink.configure({
                    autolink: false,
                    onOpenFile: href => options.openFilePath(href),
                }),
                TaskList,
                CustomTaskItem.configure({
                    nested: true,
                }),
                Table,
                TableRow,
                CustomTableHeader.configure({
                    HTMLAttributes: {
                        class: 'border border-light-base-400 dark:border-base-700 p-2',
                    },
                }),
                CustomTableCell.configure({
                    HTMLAttributes: {
                        class: 'border border-light-base-400 dark:border-base-700 p-2',
                    },
                }),
                CustomTableColumnAlign,
                VaultFileDrop,
                VaultFileUpload.configure({
                    uploadFiles: options.uploadFiles,
                    placeholderClass:
                        'bg-light-base-300 dark:bg-base-800 text-light-base-700 dark:text-base-200 rounded-sm px-1 text-sm',
                }),
                ...(collaboration
                    ? [
                          Collaboration.configure({
                              document: collaboration.document,
                              field: 'default',
                              provider: collaboration.provider,
                          }),
                          CollaborationCaret.configure({
                              provider: collaboration.provider,
                              user: collaboration.user,
                              render: renderCollaborationCaret,
                              selectionRender: (user: PresenceUser) => ({
                                  nodeName: 'span',
                                  class: 'collaboration-carets__selection',
                                  style: `background-color: ${user.color}33`,
                                  'data-user': user.name,
                              }),
                          }),
                      ]
                    : []),
            ],
            content: content,
            editable: options.isEditMode.value,
            editorProps: {
                attributes: {
                    class: 'h-full !max-w-none flow-root focus:outline-none prose dark:prose-invert pt-6',
                },
            },
            onCreate() {
                isSyncing = false;

                if (!collaboration) {
                    setMarkdownContent(options.content);
                }

                const instance = editor.value;

                if (instance && collaboration) {
                    options.onEditorReady?.(instance, setContent, readMarkdown);
                }
            },
            onBlur() {
                options.onBlur?.();
            },
            onUpdate() {
                if (isSyncing) {
                    return;
                }

                isSyncing = true;

                const markdown = readMarkdown();
                setMarkdownContent(markdown);

                isSyncing = false;

                options.onUpdate(markdown);
            },
        });
    });

    function setTiptapContent(html: string): void {
        editor.value?.commands.setContent(html);
    }

    function setMarkdownContent(markdown: string): void {
        if (options.markdownElement.value) {
            options.markdownElement.value.textContent = markdown;
        }
    }

    async function setContent(markdown: string): Promise<void> {
        isSyncing = true;

        setTiptapContent(markdownToHTML(markdown));
        setMarkdownContent(markdown);

        isSyncing = false;
    }

    async function replaceContent(markdown: string): Promise<void> {
        await setContent(markdown);
        options.onUpdate(markdown);
    }

    function rewriteVaultLinks(
        originalPath: string,
        replacementPath: string,
        extension: string
    ): void {
        const instance = editor.value;

        if (!instance || originalPath === replacementPath) {
            return;
        }

        const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const from = originalPath.replace(/^\/+/, '').replace(/\/+$/, '');
        const to = replacementPath.replace(/^\/+/, '').replace(/\/+$/, '');
        const extensionPart =
            extension === 'md' ? '(?:\\.md)?' : extension ? `\\.${escape(extension)}` : '';
        const pattern = new RegExp(`^/?${escape(from)}${extensionPart}$`, 'i');
        const replacement = extension ? `/${to}.${extension}` : `/${to}`;

        const matches = (value: unknown): boolean => {
            if (typeof value !== 'string') {
                return false;
            }

            try {
                return pattern.test(decodeURI(value));
            } catch {
                return pattern.test(value);
            }
        };

        const transaction = instance.state.tr;
        let changed = false;

        instance.state.doc.descendants((node, position) => {
            if (node.isText) {
                const link = node.marks.find(mark => mark.type.name === 'link');

                if (link && matches(link.attrs.href)) {
                    transaction.addMark(
                        position,
                        position + node.nodeSize,
                        link.type.create({ ...link.attrs, href: replacement })
                    );
                    changed = true;
                }

                return;
            }

            if (node.type.name === 'image' && matches(node.attrs.src)) {
                transaction.setNodeMarkup(position, null, {
                    ...node.attrs,
                    src: replacement,
                });
                changed = true;
            }
        });

        if (changed) {
            instance.view.dispatch(transaction);
        }
    }

    async function onMarkdownChanged(markdown: string): Promise<void> {
        if (collaboration || isSyncing) {
            return;
        }

        isSyncing = true;

        setTiptapContent(markdownToHTML(markdown));

        isSyncing = false;

        options.onUpdate(markdown);
    }

    watch(options.isEditMode, value => {
        isSyncing = true;

        editor.value?.setEditable(value);

        isSyncing = false;
    });

    onUnmounted(() => {
        editor.value?.destroy();
        editor.value = null;
    });

    return {
        editor,
        setContent,
        replaceContent,
        rewriteVaultLinks,
        onMarkdownChanged,
        readMarkdown,
    };
}
