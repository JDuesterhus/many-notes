import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
    applyRichTextChange,
    diffText,
    findMarkdownOffsetForVisibleText,
    hasMeaningfulFragmentContent,
    mapTextOffset,
    mergeMarkdown,
    replaceYText,
    visibleMarkdownProjection,
    visibleOffsetForMarkdownOffset,
} from './collaborationMarkdown';

describe('diffText', () => {
    it('returns null for identical text', () => {
        expect(diffText('same', 'same')).toBeNull();
    });

    it('keeps the common prefix and suffix', () => {
        expect(diffText('hello world', 'hello brave world')).toEqual({
            start: 6,
            removed: 0,
            inserted: 'brave ',
        });
    });

    it('represents a replacement with one range', () => {
        expect(diffText('a-b-c', 'a-X-c')).toEqual({
            start: 2,
            removed: 1,
            inserted: 'X',
        });
    });
});

describe('replaceYText', () => {
    it('applies a minimal change and reports it', () => {
        const doc = new Y.Doc();
        const text = doc.getText('markdown');

        text.insert(0, 'hello world');

        expect(replaceYText(text, 'hello brave world', 'test')).toBe(true);
        expect(text.toString()).toBe('hello brave world');
        expect(replaceYText(text, 'hello brave world', 'test')).toBe(false);

        doc.destroy();
    });

    it('merges concurrent raw edits through Yjs', () => {
        const first = new Y.Doc();
        const second = new Y.Doc();
        const firstText = first.getText('markdown');
        const secondText = second.getText('markdown');

        firstText.insert(0, 'alpha beta');

        Y.applyUpdate(second, Y.encodeStateAsUpdate(first));

        replaceYText(firstText, 'alpha X beta', 'first');
        replaceYText(secondText, 'alpha beta Y', 'second');

        Y.applyUpdate(first, Y.encodeStateAsUpdate(second));
        Y.applyUpdate(second, Y.encodeStateAsUpdate(first));

        expect(firstText.toString()).toBe(secondText.toString());
        expect(firstText.toString()).toContain('alpha');
        expect(firstText.toString()).toContain('X');
        expect(firstText.toString()).toContain('Y');

        first.destroy();
        second.destroy();
    });
});

describe('findMarkdownOffsetForVisibleText', () => {
    it('maps visible paragraph text after Markdown syntax', () => {
        const markdown = '# Title\n\nA **bold** sentence.';

        expect(findMarkdownOffsetForVisibleText(markdown, 'A bold sentence.')).toBe(
            markdown.length
        );
    });

    it('uses the last visible snippet as a caret anchor', () => {
        const markdown = '# Title\n\nA paragraph.\n\nSecond paragraph.';

        expect(findMarkdownOffsetForVisibleText(markdown, 'A paragraph.\n\nSecond')).toBe(
            markdown.indexOf('Second') + 'Second'.length
        );
    });

    it('returns zero for an empty prefix', () => {
        expect(findMarkdownOffsetForVisibleText('# Title', '')).toBe(0);
    });
});

describe('visibleMarkdownProjection', () => {
    it('drops table pipes and maps back to source offsets', () => {
        const markdown = '| A | B |\n| --- | --- |\n| cell one | cell two |';
        const projection = visibleMarkdownProjection(markdown);
        const index = projection.text.indexOf('cell one');

        expect(projection.text).not.toContain('|');
        expect(index).toBeGreaterThanOrEqual(0);
        expect(markdown.slice(projection.map[index]).startsWith('cell one')).toBe(true);
    });

    it('keeps identifiers and inline-code underscores', () => {
        const markdown = '| `ACTION_P(Bar, param)` | HAS_m_TEMPLATE_PARAMS | int_value | t_m |';
        const projection = visibleMarkdownProjection(markdown);

        expect(projection.text).toContain('ACTION_P(Bar, param)');
        expect(projection.text).toContain('HAS_m_TEMPLATE_PARAMS');
        expect(projection.text).toContain('int_value');
        expect(projection.text).toContain('t_m');

        const index = projection.text.indexOf('ACTION_P');
        expect(markdown.slice(projection.map[index]!).startsWith('ACTION_P')).toBe(true);
    });

    it('treats inline-code content literally', () => {
        const projection = visibleMarkdownProjection('`a_b | c*d [e](f)`');

        expect(projection.text).toBe('a_b | c*d [e](f)');
    });

    it('strips emphasis underscores but not intraword ones', () => {
        expect(visibleMarkdownProjection('_italic_ and snake_case').text).toBe(
            'italic and snake_case'
        );
    });

    it('skips a fenced-code language label and keeps its body', () => {
        const projection = visibleMarkdownProjection('```js\nconst action_p = 1;\n```');

        expect(projection.text).toContain('const action_p = 1;');
        expect(projection.text).not.toContain('js');
        expect(projection.text).not.toContain('```');
    });
});

describe('visibleOffsetForMarkdownOffset', () => {
    it('skips heading and emphasis syntax', () => {
        const markdown = '# Title\n\nA **bold** sentence.';

        expect(visibleOffsetForMarkdownOffset(markdown, 2)).toBe(0);
        expect(visibleOffsetForMarkdownOffset(markdown, markdown.indexOf('**'))).toBe(
            'Title\n\nA '.length
        );
        expect(visibleOffsetForMarkdownOffset(markdown, markdown.length)).toBe(
            'Title\n\nA bold sentence.'.length
        );
    });
});

describe('applyRichTextChange', () => {
    it('keeps a raw append which the rich client had not rendered yet', () => {
        const doc = new Y.Doc();
        const text = doc.getText('markdown');
        text.insert(0, 'alpha\n');

        // Raw user appends before the rich editor reports its own change.
        text.insert(text.length, 'RAW\n');

        expect(applyRichTextChange(text, 'alpha\n', 'alpha\nRICH\n', 'rich')).toBe(true);
        expect(text.toString()).toBe('alpha\nRICH\nRAW\n');

        doc.destroy();
    });

    it('shifts the rich change after a remote insert before it', () => {
        const doc = new Y.Doc();
        const text = doc.getText('markdown');
        text.insert(0, 'alpha\nbeta\n');
        text.insert(0, 'RAW\n');

        expect(applyRichTextChange(text, 'alpha\nbeta\n', 'alpha\nRICH\nbeta\n', 'rich')).toBe(
            true
        );
        expect(text.toString()).toBe('RAW\nalpha\nRICH\nbeta\n');

        doc.destroy();
    });
});

describe('mergeMarkdown', () => {
    it('keeps non-overlapping local and remote changes', () => {
        const base = 'one\ntwo\nthree';
        const local = 'one local\ntwo\nthree';
        const remote = 'one\ntwo\nthree remote';

        expect(mergeMarkdown(base, local, remote)).toBe('one local\ntwo\nthree remote');
    });

    it('keeps the local side on a true conflict', () => {
        expect(mergeMarkdown('same', 'local', 'remote')).toBe('local');
    });
});

describe('hasMeaningfulFragmentContent', () => {
    it('treats an empty TipTap paragraph as no content', () => {
        expect(hasMeaningfulFragmentContent('<paragraph></paragraph>')).toBe(false);
        expect(hasMeaningfulFragmentContent('<paragraph ychange="{}"></paragraph>')).toBe(false);
        expect(hasMeaningfulFragmentContent('')).toBe(false);
    });

    it('recognizes headings, text and lists', () => {
        expect(hasMeaningfulFragmentContent('<heading level="1">Title</heading>')).toBe(true);
        expect(hasMeaningfulFragmentContent('<paragraph>Body</paragraph>')).toBe(true);
        expect(
            hasMeaningfulFragmentContent(
                '<bulletlist><listitem><paragraph>one</paragraph></listitem></bulletlist>'
            )
        ).toBe(true);
    });
});

describe('mapTextOffset', () => {
    it('keeps offsets before the change', () => {
        expect(mapTextOffset(3, { start: 5, removed: 2, inserted: 'WXYZ' })).toBe(3);
    });

    it('moves offsets after the change by the length delta', () => {
        expect(mapTextOffset(9, { start: 5, removed: 2, inserted: 'WXYZ' })).toBe(11);
    });

    it('moves offsets inside the replaced range to the insertion end', () => {
        expect(mapTextOffset(6, { start: 5, removed: 3, inserted: 'WXYZ' })).toBe(9);
    });
});
