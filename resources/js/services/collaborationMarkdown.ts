import { diff3Merge } from 'node-diff3';
import type * as Y from 'yjs';

export interface TextChange {
    start: number;
    removed: number;
    inserted: string;
}

/**
 * TipTap installs an empty paragraph as soon as its collaboration binding
 * mounts. A serialized Y.XmlFragment containing only that placeholder is not
 * note content and must not block the initial Markdown seed.
 */
export function hasMeaningfulFragmentContent(serialized: string): boolean {
    return serialized.replace(/<paragraph(?:\s[^>]*)?><\/paragraph>/g, '').trim().length > 0;
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
 * Applies only the rich editor's local change to the shared Y.Text. The
 * previous rich Markdown is the base; any raw text which arrived meanwhile
 * is retained and the local offset is shifted around it.
 *
 * A full replace is not safe here: if a raw user appended text while the rich
 * editor was typing, the rich client may not have seen that append yet.
 * Replacing the full document would delete the raw insert.
 */
/**
 * Approximate a ProseMirror text position in the shared Markdown. The rich
 * editor hides Markdown syntax, so use the last visible characters before the
 * caret as an anchor and search them in the source. This is intentionally
 * best-effort: an off-by-a-few-characters caret is still useful, while a caret
 * that disappears entirely is not.
 */
export function visibleMarkdownProjection(markdown: string): { text: string; map: number[] } {
    let text = '';
    const map: number[] = [];

    for (let index = 0; index < markdown.length; index++) {
        const character = markdown[index]!;
        const lineStart = index === 0 || markdown[index - 1] === '\n';

        if (character === '\\' && index + 1 < markdown.length) {
            index++;
            text += markdown[index];
            map.push(index);
            continue;
        }

        if (character === '`') {
            let fenceLength = 1;

            while (markdown[index + fenceLength] === '`') {
                fenceLength++;
            }

            if (fenceLength >= 3 && lineStart) {
                // A fenced code block: skip the language/info string and copy
                // the body verbatim. The language label is not part of the
                // shared document text in the rich editor.
                let cursor = index + fenceLength;

                while (cursor < markdown.length && markdown[cursor] !== '\n') {
                    cursor++;
                }

                cursor++;
                const contentStart = cursor;
                let closeStart = -1;

                while (cursor < markdown.length) {
                    if (cursor === contentStart || markdown[cursor - 1] === '\n') {
                        let closeLength = 0;

                        while (markdown[cursor + closeLength] === '`') {
                            closeLength++;
                        }

                        if (closeLength >= fenceLength) {
                            closeStart = cursor;
                            break;
                        }
                    }

                    cursor++;
                }

                if (closeStart >= 0) {
                    for (let position = contentStart; position < closeStart; position++) {
                        text += markdown[position];
                        map.push(position);
                    }

                    let after = closeStart + fenceLength;

                    while (after < markdown.length && markdown[after] !== '\n') {
                        after++;
                    }

                    index = after;
                    continue;
                }
            }

            // Inline code: its content is literal. Underscores, asterisks,
            // pipes and links inside it must not be treated as Markdown.
            let close = -1;
            let cursor = index + fenceLength;

            while (cursor < markdown.length) {
                if (markdown[cursor] === '`') {
                    let closeLength = 1;

                    while (markdown[cursor + closeLength] === '`') {
                        closeLength++;
                    }

                    if (closeLength === fenceLength) {
                        close = cursor;
                        break;
                    }

                    cursor += closeLength;
                    continue;
                }

                cursor++;
            }

            if (close >= 0) {
                for (let position = index + fenceLength; position < close; position++) {
                    text += markdown[position];
                    map.push(position);
                }

                index = close + fenceLength - 1;
                continue;
            }

            // Unmatched backticks are syntax, not visible text.
            index += fenceLength - 1;
            continue;
        }

        if (character === '!' && markdown[index + 1] === '[') {
            index++;
            continue;
        }

        if (character === '[') {
            continue;
        }

        if (character === ']') {
            if (markdown[index + 1] === '(') {
                let cursor = index + 2;

                while (cursor < markdown.length && markdown[cursor] !== ')') {
                    cursor++;
                }

                index = cursor;
            }

            continue;
        }

        if (character === '_') {
            const previous = markdown[index - 1] ?? '';
            const next = markdown[index + 1] ?? '';

            // An intraword underscore is part of an identifier such as
            // ACTION_P or int_value, not an emphasis delimiter.
            if (/[\p{L}\p{N}]/u.test(previous) && /[\p{L}\p{N}]/u.test(next)) {
                text += character;
                map.push(index);
            }

            continue;
        }

        if (character === '*' || character === '~' || character === '|') {
            continue;
        }

        if (lineStart && (character === '#' || character === '>')) {
            let cursor = index + 1;

            while (cursor < markdown.length && markdown[cursor] === ' ') {
                cursor++;
            }

            index = cursor - 1;
            continue;
        }

        if (lineStart && (character === '-' || character === '+') && markdown[index + 1] === ' ') {
            index++;
            continue;
        }

        text += character;
        map.push(index);
    }

    return { text, map };
}

export function visibleOffsetForMarkdownOffset(markdown: string, offset: number): number {
    const { map } = visibleMarkdownProjection(markdown);

    if (map.length === 0 || offset <= 0) {
        return 0;
    }

    if (offset >= markdown.length) {
        return map.length;
    }

    let low = 0;
    let high = map.length;

    while (low < high) {
        const middle = Math.floor((low + high) / 2);

        if ((map[middle] ?? 0) < offset) {
            low = middle + 1;
        } else {
            high = middle;
        }
    }

    return low;
}

function markdownOffsetAt(text: string, map: number[], offset: number, markdown: string): number {
    if (text.length === 0 || map.length === 0) {
        return 0;
    }

    if (offset <= 0) {
        return map[0] ?? 0;
    }

    if (offset >= map.length) {
        return markdown.length;
    }

    return map[offset] ?? markdown.length;
}

export function findMarkdownOffsetForVisibleText(markdown: string, visiblePrefix: string): number {
    const snippet = visiblePrefix.slice(-48);

    if (snippet.length === 0) {
        return 0;
    }

    const { text, map } = visibleMarkdownProjection(markdown);
    const index = text.lastIndexOf(snippet);

    if (index >= 0) {
        return markdownOffsetAt(text, map, index + snippet.length, markdown);
    }

    const rawIndex = markdown.lastIndexOf(snippet);

    if (rawIndex >= 0) {
        return rawIndex + snippet.length;
    }

    // Formatting can break a plain-text snippet (for example a bold marker in
    // the middle). Fall back to a shorter suffix and then to the end of the
    // prefix, clamped to the source.
    for (let length = Math.min(24, snippet.length - 1); length >= 8; length -= 4) {
        const shorter = snippet.slice(-length);

        for (const [source, sourceMap] of [
            [text, map],
            [markdown, [] as number[]],
        ] as const) {
            const sourceIndex = source.lastIndexOf(shorter);

            if (sourceIndex >= 0 && sourceMap.length > 0) {
                return markdownOffsetAt(source, sourceMap, sourceIndex + shorter.length, markdown);
            }

            if (sourceIndex >= 0) {
                return sourceIndex + shorter.length;
            }
        }
    }

    return Math.min(visiblePrefix.length, markdown.length);
}

export function applyRichTextChange(
    ytext: Y.Text,
    base: string,
    next: string,
    origin: string
): boolean {
    const localChange = diffText(base, next);

    if (!localChange) {
        return false;
    }

    const current = ytext.toString();
    const remoteChange = diffText(base, current);

    if (!remoteChange) {
        return replaceYText(ytext, next, origin);
    }

    let start = mapTextOffset(localChange.start, remoteChange);
    let end = mapTextOffset(localChange.start + localChange.removed, remoteChange);

    if (start > end) {
        [start, end] = [end, start];
    }

    // A pure insert at the same position as a raw insert keeps both values.
    // For an overlapping replacement, append the rich text instead of
    // deleting a remote change we have not rendered yet.
    const overlapsRemote =
        localChange.removed > 0 &&
        localChange.start < remoteChange.start + remoteChange.removed &&
        remoteChange.start < localChange.start + localChange.removed;

    if (overlapsRemote) {
        start = current.length;
        end = current.length;
    }

    ytext.doc?.transact(() => {
        if (end > start) {
            ytext.delete(start, end - start);
        }

        if (localChange.inserted.length > 0) {
            ytext.insert(start, localChange.inserted);
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
