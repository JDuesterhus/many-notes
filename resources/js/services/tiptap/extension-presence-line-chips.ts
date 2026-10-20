import type { PresenceUser } from '@/types/collaboration';
import type { HocuspocusProvider } from '@hocuspocus/provider';
import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet, EditorView } from '@tiptap/pm/view';
import {
    relativePositionToAbsolutePosition,
    ySyncPluginKey,
    type RelativePosition,
} from '@tiptap/y-tiptap';

interface PresenceLineChipsOptions {
    awareness: NonNullable<HocuspocusProvider['awareness']> | null;
    localClientId: number | null;
}

interface AwarenessState {
    user?: PresenceUser;
    cursor?: { anchor?: unknown; head?: unknown } | null;
}

const presenceLineChipsKey = new PluginKey<DecorationSet>('presenceLineChips');

function cursorPosition(view: EditorView, cursor: unknown): number | null {
    if (typeof cursor !== 'object' || cursor === null) {
        return null;
    }

    const anchor = (cursor as { anchor?: unknown }).anchor;

    if (typeof anchor !== 'object' || anchor === null) {
        return null;
    }

    const syncState = ySyncPluginKey.getState(view.state);

    if (!syncState) {
        return null;
    }

    return relativePositionToAbsolutePosition(
        syncState.doc,
        syncState.type,
        anchor as RelativePosition,
        syncState.binding.mapping
    );
}

function blockStart(view: EditorView, position: number): number | null {
    const bounded = Math.max(0, Math.min(position, view.state.doc.content.size));
    const resolved = view.state.doc.resolve(bounded);

    let depth = resolved.depth;

    while (depth > 0 && !resolved.node(depth).isTextblock) {
        depth--;
    }

    if (depth === 0) {
        return null;
    }

    return resolved.start(depth);
}

function buildDecorations(view: EditorView, options: PresenceLineChipsOptions): DecorationSet {
    const awareness = options.awareness;

    if (!awareness) {
        return DecorationSet.empty;
    }

    const byPosition = new Map<number, PresenceUser[]>();

    awareness.getStates().forEach((rawState, clientId) => {
        if (clientId === options.localClientId) {
            return;
        }

        const state = rawState as AwarenessState;

        if (!state.user || !state.cursor) {
            return;
        }

        const position = cursorPosition(view, state.cursor);

        if (position === null) {
            return;
        }

        const start = blockStart(view, position);

        if (start === null) {
            return;
        }

        const users = byPosition.get(start) ?? [];
        users.push(state.user);
        byPosition.set(start, users);
    });

    const decorations: Decoration[] = [];

    for (const [position, users] of byPosition) {
        users
            .sort((first, second) => first.id.localeCompare(second.id))
            .forEach((user, index) => {
                const chip = document.createElement('span');
                chip.className = 'presence-line-chip';
                chip.contentEditable = 'false';
                chip.setAttribute('aria-hidden', 'true');
                chip.dataset.presenceUserId = user.id;
                chip.style.setProperty('--presence-color', user.color);
                chip.style.setProperty('--presence-index', String(index));

                const label = document.createElement('span');
                label.className = 'presence-line-chip__label';
                label.textContent = user.initials;
                label.title = user.name;
                chip.appendChild(label);

                decorations.push(
                    Decoration.widget(position, chip, {
                        side: -1,
                        key: `presence-${user.id}-${position}-${index}`,
                    })
                );
            });
    }

    return DecorationSet.create(view.state.doc, decorations);
}

export const PresenceLineChips = Extension.create<PresenceLineChipsOptions>({
    name: 'presenceLineChips',

    addOptions() {
        return {
            awareness: null,
            localClientId: null,
        };
    },

    addProseMirrorPlugins() {
        const options = this.options;
        const awareness = options.awareness;

        if (!awareness) {
            return [];
        }

        return [
            new Plugin<DecorationSet>({
                key: presenceLineChipsKey,
                state: {
                    init: () => DecorationSet.empty,
                    apply(transaction, decorations) {
                        const next = transaction.getMeta(presenceLineChipsKey) as
                            DecorationSet | undefined;

                        if (next) {
                            return next;
                        }

                        return decorations.map(transaction.mapping, transaction.doc);
                    },
                },
                props: {
                    decorations(state) {
                        return presenceLineChipsKey.getState(state) ?? DecorationSet.empty;
                    },
                },
                view(view) {
                    let timer: ReturnType<typeof setTimeout> | null = null;
                    let destroyed = false;

                    const rebuild = (): void => {
                        if (destroyed || view.isDestroyed) {
                            return;
                        }

                        view.dispatch(
                            view.state.tr.setMeta(
                                presenceLineChipsKey,
                                buildDecorations(view, options)
                            )
                        );
                    };

                    const schedule = (): void => {
                        if (timer) {
                            return;
                        }

                        timer = setTimeout(() => {
                            timer = null;
                            rebuild();
                        }, 80);
                    };

                    awareness.on('change', schedule);
                    schedule();

                    return {
                        destroy() {
                            destroyed = true;
                            awareness.off('change', schedule);

                            if (timer) {
                                clearTimeout(timer);
                            }
                        },
                    };
                },
            }),
        ];
    },
});
