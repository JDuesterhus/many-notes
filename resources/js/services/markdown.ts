import { markedService } from '@/services/marked';

export function encodeMarkdownText(text: string): string {
    // Encode paths from Markdown links
    const encoded = text.replace(
        /\[(.*?)\]\((.*?)(\s".*?")?\)/g,
        (match, linkText, path, title) => {
            if (title === undefined) {
                title = '';
            }

            try {
                return `[${linkText}](${encodeURI(path)}${title})`;
            } catch {
                return `[${linkText}](${path}${title})`;
            }
        }
    );

    // Prevent HTML rendering
    return encoded.replace(/</g, '&lt;');
}

export function prepareTiptapHTML(html: string): string {
    const doc = new DOMParser().parseFromString(html, 'text/html');

    // Prepare plain text code
    doc.querySelectorAll('code.language-plaintext').forEach(element => {
        element.classList.remove('language-plaintext');

        if (element.classList.length === 0) {
            element.removeAttribute('class');
        }
    });

    // Prepare links
    doc.querySelectorAll<HTMLAnchorElement>('a[data-href]').forEach(element => {
        element.setAttribute('href', element.dataset.href ?? '');
        delete element.dataset.href;
    });

    return doc.body.innerHTML;
}

export function markdownToHTML(markdown: string): string {
    if (!markdown) {
        return '';
    }

    const parsed = markedService.parse(encodeMarkdownText(markdown));

    return prepareTiptapHTML(typeof parsed === 'string' ? parsed : '');
}
