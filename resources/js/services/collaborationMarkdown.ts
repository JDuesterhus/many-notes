import { diff3Merge } from 'node-diff3';
import type * as Y from 'yjs';

export interface TextChange {
    start: number;
    removed: number;
    inserted: string;
}

/**
 * Returns the smallest single replacement that turns `current` into `next`.
 * Common prefix and suffix are kept so a normal keystroke only touches one
 * character in the shared Y.Text.
 */
export function diffText(current: string, next: string): TextChange | null {
    if (current === next) {
        return null;
    }

    let start = 0;

    while (start < current.length && start < next.length && current[start] === next[start]) {
        start++;
    }

    let currentEnd = current.length;
    let nextEnd = next.length;

    while (currentEnd > start && nextEnd > start && current[currentEnd - 1] === next[nextEnd - 1]) {
        currentEnd--;
        nextEnd--;
    }

    return {
        start,
        removed: currentEnd - start,
        inserted: next.slice(start, nextEnd),
    };
}

/**
 * Applies a full Markdown value to a Y.Text using one minimal replacement.
 * Returns true when the shared text changed.
 */
export function replaceYText(ytext: Y.Text, next: string, origin: string): boolean {
    const change = diffText(ytext.toString(), next);

    if (!change) {
        return false;
    }

    ytext.doc?.transact(() => {
        if (change.removed > 0) {
            ytext.delete(change.start, change.removed);
        }

        if (change.inserted.length > 0) {
            ytext.insert(change.start, change.inserted);
        }
    }, origin);

    return true;
}

/**
 * Three-way merge for the rich-to-Markdown mirror. `base` is the Markdown the
 * rich editor last represented, `local` is its new serialization and `remote`
 * is the current shared Markdown (which may already contain another user's
 * edit). Non-overlapping changes are kept from both sides; a true conflict
 * keeps the local side, while the rich CRDT remains the live source for the
 * other view.
 */
export function mergeMarkdown(base: string, local: string, remote: string): string {
    const regions = diff3Merge(local, base, remote, { stringSeparator: '\n' });

    return regions.map(region => (region.ok ?? region.conflict?.a ?? []).join('\n')).join('\n');
}

/**
 * Maps a caret offset from the old text into the new text after one change.
 * Offsets inside the replaced range move to the end of the inserted text.
 */
export function mapTextOffset(offset: number, change: TextChange): number {
    if (offset <= change.start) {
        return offset;
    }

    if (offset >= change.start + change.removed) {
        return offset + change.inserted.length - change.removed;
    }

    return change.start + change.inserted.length;
}
