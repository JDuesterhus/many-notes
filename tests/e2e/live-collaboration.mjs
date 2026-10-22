import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const require = createRequire(import.meta.url);
const Database = require('../../yjs-server/node_modules/better-sqlite3');
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:8000';
const PHP = process.env.PHP_BIN ?? 'php';
const PASSWORD = 'Live!2026pass';
const DB_PATH = process.env.MANY_NOTES_DB ?? resolve(ROOT, 'database/sqlite/database.sqlite');
const KEEP = process.env.KEEP_LIVE_QA === '1';

const results = [];
const consoleErrors = [];

function pass(name, detail = '') {
    results.push({ name, ok: true, detail });
    console.log(`PASS ${name}${detail ? ` :: ${detail}` : ''}`);
}

function fail(name, detail = '') {
    results.push({ name, ok: false, detail });
    console.error(`FAIL ${name}${detail ? ` :: ${detail}` : ''}`);
}

function check(name, condition, detail = '') {
    if (condition) {
        pass(name, detail);
    } else {
        fail(name, detail);
    }

    return condition;
}

function sleep(milliseconds) {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function runPhp(script, args = []) {
    return execFileSync(PHP, [script, ...args], {
        cwd: ROOT,
        encoding: 'utf8',
        env: { ...process.env, PHPRC: process.env.PHPRC ?? '' },
    });
}

async function login(browser, email) {
    const context = await browser.newContext({
        viewport: { width: 1280, height: 900 },
        serviceWorkers: 'block',
    });
    const page = await context.newPage();

    page.on('pageerror', error => {
        consoleErrors.push(`pageerror ${email}: ${error.message}`);
    });
    page.on('console', message => {
        if (message.type() !== 'error') {
            return;
        }

        const text = message.text();

        // Reverb is not part of this local test harness. A 409 is a handled
        // snapshot conflict and is retried by the client. The favicon is not
        // part of the application and is not served by `artisan serve`.
        if (
            text.includes('/ws/app/') ||
            text.includes('409 (Conflict)') ||
            message.location().url.includes('favicon') ||
            (message.location().url.includes('/app-version') &&
                text.includes('ERR_INTERNET_DISCONNECTED')) ||
            (message.location().url.includes('/_debugbar/') &&
                text.includes('ERR_INTERNET_DISCONNECTED'))
        ) {
            return;
        }

        consoleErrors.push(`console ${email}: ${text} @ ${message.location().url}`);
    });

    await page.goto(`${BASE}/login`);
    await page.fill('input[name="email"]', email);
    await page.fill('input[name="password"]', PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.waitForURL(url => !url.pathname.endsWith('/login'), null, { timeout: 20_000 });

    return { context, page };
}

async function openNote(page, vaultId, noteId) {
    await page.goto(`${BASE}/vaults/${vaultId}?file=${noteId}`);
    await page.waitForFunction(
        () => {
            const status = document.querySelector('[role="status"]');
            const raw = document.querySelector('.cm-editor');
            const rich = document.querySelector('.ProseMirror');
            const visible = element =>
                element instanceof HTMLElement &&
                element.getBoundingClientRect().width > 0 &&
                getComputedStyle(element).display !== 'none';

            return /Live/.test(status?.textContent ?? '') && (visible(raw) || visible(rich));
        },
        null,
        { timeout: 30_000 }
    );
    await page.waitForTimeout(800);
}

async function waitForText(page, text, timeout = 8_000) {
    await page.bringToFront();

    if (await page.locator('.cm-editor').isVisible()) {
        await page.locator('.cm-scroller').evaluate(element => {
            element.scrollTop = element.scrollHeight;
        });
    }

    await page.waitForFunction(
        value => {
            const clone = document.body.cloneNode(true);
            clone
                .querySelectorAll(
                    '.collaboration-carets__caret, .collaboration-carets__label, .cm-ySelectionCaret, .cm-ySelectionInfo, .cm-ySelectionCaretDot'
                )
                .forEach(node => node.remove());

            return (clone.textContent ?? '').includes(value);
        },
        text,
        { timeout }
    );
}

async function toggleRaw(page) {
    await page.locator('button[title="Toggle Markdown"]').click();
    await page.waitForTimeout(500);
}

async function ensureRich(page) {
    if (await page.locator('.cm-editor').isVisible()) {
        await toggleRaw(page);
    }
}

async function ensureRaw(page) {
    if (!(await page.locator('.cm-editor').isVisible())) {
        await toggleRaw(page);
    }
}

async function richText(page) {
    return page.locator('.ProseMirror').evaluate(element => {
        const clone = element.cloneNode(true);
        clone
            .querySelectorAll('.collaboration-carets__caret, .collaboration-carets__label')
            .forEach(node => node.remove());

        return (clone.textContent ?? '').replace(/\s+/g, ' ').trim();
    });
}

/**
 * CodeMirror renders every line in its own div. innerText adds an extra
 * newline for an empty line's <br>, so join the actual line contents instead.
 */
async function rawText(page) {
    return page.locator('.cm-content').evaluate(element => {
        const lines = [...element.querySelectorAll('.cm-line')].map(line => {
            const clone = line.cloneNode(true);
            clone
                .querySelectorAll('.cm-ySelectionCaret, .cm-ySelectionInfo, .cm-ySelectionCaretDot')
                .forEach(node => node.remove());

            return clone.textContent ?? '';
        });

        return lines.join('\n');
    });
}

async function avatars(page) {
    return page
        .locator('[role="status"] span[title]')
        .evaluateAll(elements =>
            elements.map(element => element.getAttribute('title') ?? element.textContent ?? '')
        );
}

async function richCaretCount(page) {
    return page.locator('.collaboration-carets__caret').count();
}

async function rawCaretCount(page) {
    return page.locator('.cm-ySelectionCaret').count();
}

async function statusText(page) {
    return page.locator('[role="status"]').innerText();
}

async function selectRich(page, paragraphIndex = 0) {
    const paragraphs = page.locator('.ProseMirror p');

    if ((await paragraphs.count()) > paragraphIndex) {
        await paragraphs.nth(paragraphIndex).click();
    } else {
        await page.locator('.ProseMirror').click();
    }

    await page.keyboard.press('End');
}

async function appendRich(page, marker) {
    await ensureRich(page);
    await page.locator('.ProseMirror').click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type(` ${marker}`);
    await page.waitForTimeout(250);
}

async function appendRaw(page, marker) {
    await ensureRaw(page);
    await page.locator('.cm-content').click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type(` ${marker}`);
    await page.waitForTimeout(250);
}

function snapshot(noteId) {
    const database = new Database(DB_PATH, { readonly: true });

    try {
        return database.prepare('select content from vault_nodes where id = ?').get(noteId);
    } finally {
        database.close();
    }
}

async function main() {
    const seedOutput = runPhp('tests/e2e/seed-live-collaboration.php');
    const seed = JSON.parse(seedOutput.trim().split(/\r?\n/).filter(Boolean).at(-1));
    const { vault_id: vaultId, notes, users } = seed;

    console.log('Seeded', JSON.stringify({ vaultId, notes }));

    const browser = await chromium.launch({ headless: true });
    const alice = await login(browser, users.a);
    const bob = await login(browser, users.b);
    const charlie = await login(browser, users.c);

    try {
        await Promise.all([
            openNote(alice.page, vaultId, notes.sync),
            openNote(bob.page, vaultId, notes.sync),
            openNote(charlie.page, vaultId, notes.sync),
        ]);

        const seedText = 'Alpha paragraph.';
        await Promise.all([
            waitForText(alice.page, seedText),
            waitForText(bob.page, seedText),
            waitForText(charlie.page, seedText),
        ]);
        check(
            'new note is seeded without duplicate or missing content',
            (await richText(alice.page)).includes(seedText) &&
                (await richText(bob.page)).includes(seedText) &&
                (await richText(charlie.page)).includes(seedText)
        );

        await Promise.all([
            selectRich(alice.page, 0),
            selectRich(bob.page, 1),
            selectRich(charlie.page, 2),
        ]);
        await sleep(900);

        const initialAvatars = await Promise.all([
            avatars(alice.page),
            avatars(bob.page),
            avatars(charlie.page),
        ]);
        check(
            'all rich avatars are visible',
            initialAvatars.every(names => names.length === 2),
            JSON.stringify(initialAvatars)
        );
        check(
            'all rich carets are visible',
            (await richCaretCount(alice.page)) === 2 &&
                (await richCaretCount(bob.page)) === 2 &&
                (await richCaretCount(charlie.page)) === 2
        );

        await alice.page.evaluate(() => window.dispatchEvent(new Event('blur')));
        await sleep(500);
        check(
            'avatar and caret survive window blur',
            (await avatars(bob.page)).some(name => name.includes('Live User A')) &&
                (await richCaretCount(bob.page)) >= 1
        );

        await charlie.page.evaluate(() => window.dispatchEvent(new Event('blur')));
        await toggleRaw(charlie.page);
        await alice.page.waitForFunction(
            () =>
                [...document.querySelectorAll('.collaboration-carets__label')].some(label =>
                    (label.textContent ?? '').includes('Live User C')
                ),
            null,
            { timeout: 5_000 }
        );

        check(
            'raw user remains visible in rich avatars',
            (await avatars(alice.page)).some(name => name.includes('Live User C')) &&
                (await avatars(bob.page)).some(name => name.includes('Live User C'))
        );
        check(
            'rich avatars remain visible in raw mode',
            (await avatars(charlie.page)).some(name => name.includes('Live User A')) &&
                (await avatars(charlie.page)).some(name => name.includes('Live User B'))
        );
        check(
            'rich carets do not disappear when another user enters raw mode',
            (await richCaretCount(alice.page)) >= 2 && (await richCaretCount(bob.page)) >= 2
        );
        check(
            'rich users see the raw user caret',
            (await alice.page.locator('.collaboration-carets__label').allTextContents()).some(
                name => name.includes('Live User C')
            )
        );
        check(
            'raw user sees rich carets in the Markdown pane',
            (await charlie.page.locator('.cm-ySelectionInfo').allTextContents()).some(name =>
                name.includes('Live User A')
            ) &&
                (await charlie.page.locator('.cm-ySelectionInfo').allTextContents()).some(name =>
                    name.includes('Live User B')
                )
        );

        const rawMarker = `RAW-${Date.now()}`;
        await appendRaw(charlie.page, rawMarker);
        await waitForText(alice.page, rawMarker);
        check('raw text reaches rich users', (await richText(alice.page)).includes(rawMarker));
        check(
            'raw text reaches the other rich user',
            (await richText(bob.page)).includes(rawMarker)
        );

        const richMarker = `RICH-${Date.now()}`;
        await appendRich(alice.page, richMarker);
        await waitForText(charlie.page, richMarker);
        check('rich text reaches the raw user', (await rawText(charlie.page)).includes(richMarker));

        await ensureRaw(alice.page);
        check(
            'switching rich to raw keeps both texts',
            (await rawText(alice.page)).includes(rawMarker) &&
                (await rawText(alice.page)).includes(richMarker)
        );

        await ensureRaw(bob.page);
        await alice.page.bringToFront();
        await sleep(700);
        check(
            'two raw users see each other',
            (await rawCaretCount(alice.page)) >= 2 &&
                (await rawCaretCount(bob.page)) >= 2 &&
                (await rawCaretCount(charlie.page)) >= 2,
            JSON.stringify({
                alice: await rawCaretCount(alice.page),
                bob: await rawCaretCount(bob.page),
                charlie: await rawCaretCount(charlie.page),
            })
        );
        check(
            'raw users retain all avatars',
            (await avatars(alice.page)).length === 2 &&
                (await avatars(bob.page)).length === 2 &&
                (await avatars(charlie.page)).length === 2
        );

        await bob.page.evaluate(() => window.dispatchEvent(new Event('blur')));
        await sleep(1600);
        check(
            'raw caret survives blur and idle',
            (await alice.page.locator('.cm-ySelectionInfo').allTextContents()).some(name =>
                name.includes('Live User B')
            )
        );
        await sleep(10_000);
        check(
            'presence heartbeat keeps avatars after idle',
            (await avatars(alice.page)).length === 2 &&
                (await alice.page.locator('.cm-ySelectionInfo').allTextContents()).some(name =>
                    name.includes('Live User B')
                )
        );

        await ensureRich(alice.page);
        await sleep(700);
        check(
            'switching raw to rich keeps all text',
            (await richText(alice.page)).includes(rawMarker) &&
                (await richText(alice.page)).includes(richMarker)
        );

        await ensureRaw(alice.page);
        await openNote(alice.page, vaultId, notes.fidelity);
        check(
            'raw mode survives note navigation',
            (await alice.page.locator('.cm-editor').isVisible()) &&
                (await rawText(alice.page)).includes('# Fidelity')
        );
        await openNote(alice.page, vaultId, notes.sync);
        check(
            'raw mode content is intact after navigating back',
            (await rawText(alice.page)).includes(rawMarker) &&
                (await rawText(alice.page)).includes(richMarker)
        );

        await charlie.page.reload();
        await openNote(charlie.page, vaultId, notes.sync);
        check(
            'raw preference and raw content survive reload',
            (await charlie.page.locator('.cm-editor').isVisible()) &&
                (await rawText(charlie.page)).includes(rawMarker)
        );
        check(
            'presence returns after reload',
            (await avatars(alice.page)).some(name => name.includes('Live User C')) &&
                (await avatars(charlie.page)).some(name => name.includes('Live User A'))
        );

        for (let index = 0; index < 4; index++) {
            await toggleRaw(charlie.page);
            await sleep(150);
        }
        await sleep(500);
        check(
            'rapid rich/raw toggles keep a usable editor',
            (await charlie.page.locator('.cm-editor').isVisible()) &&
                !(await charlie.page.locator('.ProseMirror').isVisible()),
            await statusText(charlie.page)
        );
        check(
            'rapid toggles keep presence',
            (await avatars(alice.page)).length === 2 && (await avatars(charlie.page)).length === 2
        );

        await charlie.context.close();
        await sleep(4500);
        check(
            'closed user disappears after the grace period',
            !(await avatars(alice.page)).some(name => name.includes('Live User C'))
        );

        // Concurrent rich + raw editing. The fragment projection waits for a
        // short rich idle window; both sides must converge afterwards.
        await ensureRich(alice.page);
        await ensureRich(bob.page);
        await ensureRaw(bob.page);
        const concurrentRich = `CR-${Date.now()}`;
        const concurrentRaw = `CW-${Date.now()}`;
        await alice.page.locator('.ProseMirror').click();
        await alice.page.keyboard.press('Control+End');
        await bob.page.locator('.cm-content').click();
        await bob.page.keyboard.press('Control+End');
        await Promise.all([
            alice.page.keyboard.type(` ${concurrentRich}`),
            bob.page.keyboard.type(` ${concurrentRaw}`),
        ]);
        await alice.page.bringToFront();
        await alice.page.waitForFunction(
            markers => {
                const text = document.querySelector('.ProseMirror')?.textContent ?? '';

                return text.includes(markers.rich) && text.includes(markers.raw);
            },
            { rich: concurrentRich, raw: concurrentRaw },
            { timeout: 8_000 }
        );
        check(
            'concurrent rich and raw edits converge in rich',
            (await richText(alice.page)).includes(concurrentRich) &&
                (await richText(alice.page)).includes(concurrentRaw)
        );

        await bob.page.bringToFront();
        await bob.page.locator('.cm-content').click();
        await bob.page.keyboard.press('Control+End');
        await bob.page.locator('.cm-scroller').evaluate(element => {
            element.scrollTop = element.scrollHeight;
        });
        await sleep(300);
        try {
            await bob.page.waitForFunction(
                markers => {
                    const text = [...document.querySelectorAll('.cm-line')]
                        .map(line => {
                            const clone = line.cloneNode(true);
                            clone
                                .querySelectorAll(
                                    '.cm-ySelectionCaret, .cm-ySelectionInfo, .cm-ySelectionCaretDot'
                                )
                                .forEach(node => node.remove());

                            return clone.textContent ?? '';
                        })
                        .join('\n');

                    return text.includes(markers.rich) && text.includes(markers.raw);
                },
                { rich: concurrentRich, raw: concurrentRaw },
                { timeout: 8_000 }
            );
        } catch (error) {
            console.error(
                'BOB_RAW_DEBUG',
                JSON.stringify({
                    rawVisible: await bob.page.locator('.cm-editor').isVisible(),
                    richVisible: await bob.page.locator('.ProseMirror').isVisible(),
                    lines: await bob.page.locator('.cm-line').allTextContents(),
                    rawText: await rawText(bob.page),
                })
            );
            throw error;
        }
        check(
            'concurrent rich and raw edits converge in raw',
            (await rawText(bob.page)).includes(concurrentRich) &&
                (await rawText(bob.page)).includes(concurrentRaw)
        );
        check(
            'concurrent editing does not lose the original body',
            (await richText(alice.page)).includes('Alpha paragraph.') &&
                (await rawText(bob.page)).includes('Alpha paragraph.')
        );

        // Offline edit and reconnect.
        await ensureRich(bob.page);
        await bob.context.setOffline(true);
        await sleep(700);
        const offlineMarker = `OFF-${Date.now()}`;
        await appendRich(bob.page, offlineMarker);
        await bob.context.setOffline(false);
        await bob.page.waitForFunction(
            () => /Live/.test(document.querySelector('[role="status"]')?.textContent ?? ''),
            null,
            { timeout: 20_000 }
        );
        await waitForText(alice.page, offlineMarker, 15_000);
        check('offline rich edit reaches the other client after reconnect', true);
        check(
            'presence recovers after reconnect',
            (await avatars(alice.page)).some(name => name.includes('Live User B'))
        );

        await ensureRich(alice.page);
        await ensureRaw(bob.page);
        await bob.context.setOffline(true);
        await sleep(700);
        const offlineRawMarker = `OR-${Date.now()}`;
        await appendRaw(bob.page, offlineRawMarker);
        await bob.context.setOffline(false);
        await bob.page.waitForFunction(
            () => /Live/.test(document.querySelector('[role="status"]')?.textContent ?? ''),
            null,
            { timeout: 20_000 }
        );
        await waitForText(alice.page, offlineRawMarker, 15_000);
        check('offline raw edit reaches the rich client after reconnect', true);
        check(
            'presence recovers after a raw reconnect',
            (await avatars(alice.page)).some(name => name.includes('Live User B')) &&
                (await avatars(bob.page)).some(name => name.includes('Live User A'))
        );
        await ensureRich(bob.page);

        // Switching notes must tear down and rebuild presence cleanly.
        await openNote(alice.page, vaultId, notes.fidelity);
        await openNote(alice.page, vaultId, notes.sync);
        await ensureRich(alice.page);
        await waitForText(alice.page, concurrentRich, 10_000);
        check(
            'note switching restores content and presence',
            (await richText(alice.page)).includes(concurrentRich) &&
                (await avatars(alice.page)).some(name => name.includes('Live User B'))
        );

        // Empty note persistence.
        await openNote(alice.page, vaultId, notes.empty);
        await ensureRich(alice.page);
        await appendRich(alice.page, `EMPTY-${Date.now()}`);
        await sleep(2500);
        await alice.page.locator('.ProseMirror').click();
        await alice.page.keyboard.press('Control+A');
        await alice.page.keyboard.press('Backspace');
        await sleep(3000);
        check(
            'empty note can be cleared and persisted',
            (await richText(alice.page)).trim() === '' &&
                (snapshot(notes.empty)?.content ?? '') === ''
        );

        // Markdown fidelity through mode switches.
        await openNote(alice.page, vaultId, notes.fidelity);
        await ensureRaw(alice.page);
        const fidelityRaw = await rawText(alice.page);
        check(
            'raw view exposes formatted Markdown',
            fidelityRaw.includes('**bold**') &&
                fidelityRaw.includes('- item one') &&
                fidelityRaw.includes('```js') &&
                fidelityRaw.includes('[Example](https://example.com)'),
            fidelityRaw.slice(0, 180)
        );
        await ensureRich(alice.page);
        const fidelityRich = await richText(alice.page);
        check(
            'rich view exposes the same formatted content',
            fidelityRich.includes('bold') &&
                fidelityRich.includes('item one') &&
                fidelityRich.includes('const answer = 42;') &&
                fidelityRich.includes('Example'),
            fidelityRich.slice(0, 180)
        );

        // A Markdown table selection must map to the same visible text in the
        // rich editor. Table cells are separate blocks in ProseMirror, so a
        // head on a cell boundary used to drag the name label into the next
        // column (or to the far edge of the cell).
        await openNote(alice.page, vaultId, notes.table);
        await ensureRich(alice.page);
        await openNote(bob.page, vaultId, notes.table);
        await ensureRaw(bob.page);

        const tableLine = bob.page
            .locator('.cm-line')
            .filter({ hasText: '**Given Definition**' })
            .first();
        const tableLineText = await tableLine.evaluate(element => {
            const clone = element.cloneNode(true);
            clone
                .querySelectorAll('.cm-ySelectionCaret, .cm-ySelectionInfo, .cm-ySelectionCaretDot')
                .forEach(node => node.remove());

            return clone.textContent ?? '';
        });
        const firstWordStart = tableLineText.indexOf('Given Definition');
        const expressionStart = tableLineText.indexOf('Expression');

        async function selectRawTableRange(from, length) {
            await bob.page.bringToFront();
            await tableLine.click();
            await bob.page.waitForTimeout(200);
            await bob.page.keyboard.press('Home');

            for (let index = 0; index < from; index++) {
                await bob.page.keyboard.press('ArrowRight');
            }

            for (let index = 0; index < length; index++) {
                await bob.page.keyboard.press('Shift+ArrowRight');
            }

            await bob.page.waitForTimeout(200);
            await alice.page.bringToFront();
            await alice.page.waitForTimeout(900);
        }

        async function visibleRichLabels() {
            return alice.page.evaluate(() =>
                [...document.querySelectorAll('.collaboration-carets__label')]
                    .filter(element => getComputedStyle(element).display !== 'none')
                    .map(element => ({
                        text: element.textContent ?? '',
                        cell: element.closest('td, th')?.textContent ?? '',
                    }))
            );
        }

        async function visibleRawLabels() {
            return alice.page.evaluate(() =>
                [...document.querySelectorAll('.cm-ySelectionInfo')]
                    .filter(element => getComputedStyle(element).display !== 'none')
                    .map(element => {
                        const line = element.closest('.cm-line');
                        const clone = line?.cloneNode(true);
                        clone
                            ?.querySelectorAll(
                                '.cm-ySelectionCaret, .cm-ySelectionInfo, .cm-ySelectionCaretDot'
                            )
                            .forEach(node => node.remove());

                        return {
                            text: element.textContent ?? '',
                            line: clone?.textContent ?? '',
                        };
                    })
            );
        }

        async function richTableSelection() {
            return alice.page.evaluate(() => {
                const box = element => {
                    const rect = element.getBoundingClientRect();

                    return {
                        x: Math.round(rect.x * 10) / 10,
                        right: Math.round(rect.right * 10) / 10,
                        y: Math.round(rect.y * 10) / 10,
                    };
                };

                const tables = [...document.querySelectorAll('.ProseMirror table')];

                return {
                    spans: [...document.querySelectorAll('.collaboration-carets__selection')].map(
                        element => ({
                            text: element.textContent ?? '',
                            cell: element.closest('td, th')?.textContent ?? '',
                            table: tables.indexOf(element.closest('table') ?? undefined),
                            rect: box(element),
                        })
                    ),
                    labels: [...document.querySelectorAll('.collaboration-carets__label')].map(
                        element => ({
                            text: element.textContent ?? '',
                            cell: element.closest('td, th')?.textContent ?? '',
                            table: tables.indexOf(element.closest('table') ?? undefined),
                            rect: box(element),
                        })
                    ),
                    widths: [...document.querySelectorAll('.ProseMirror th')].map(
                        element => Math.round(element.getBoundingClientRect().width * 100) / 100
                    ),
                };
            });
        }

        const tableWidthsBefore = (await richTableSelection()).widths;

        await selectRawTableRange(firstWordStart, 16);
        const singleTableState = await richTableSelection();
        check(
            'raw single-cell selection highlights only the selected header text',
            singleTableState.spans.length === 1 &&
                singleTableState.spans[0].text === 'Given Definition',
            JSON.stringify(singleTableState.spans.map(span => span.text))
        );
        check(
            'raw single-cell selection label sits at the text end in the same cell',
            singleTableState.spans.length === 1 &&
                singleTableState.labels.length === 1 &&
                String(singleTableState.labels[0].cell).startsWith('Given Definition') &&
                Math.abs(singleTableState.labels[0].rect.x - singleTableState.spans[0].rect.right) <
                    4,
            JSON.stringify(singleTableState)
        );

        // Selecting only the table pipe/spaces or the bold markers has no
        // visible counterpart. It must not invent a caret on the next word.
        await selectRawTableRange(0, 4);
        const syntaxOnlyState = await richTableSelection();
        check(
            'raw syntax-only table selection publishes no word selection or label',
            syntaxOnlyState.spans.length === 0 && syntaxOnlyState.labels.length === 0,
            JSON.stringify(syntaxOnlyState)
        );
        check(
            'table widths stay stable for a syntax-only selection',
            syntaxOnlyState.widths.length === tableWidthsBefore.length &&
                syntaxOnlyState.widths.every(
                    (width, index) => Math.abs(width - tableWidthsBefore[index]) < 0.1
                ),
            JSON.stringify({ before: tableWidthsBefore, after: syntaxOnlyState.widths })
        );

        await selectRawTableRange(0, tableLineText.length);
        const rowTableState = await richTableSelection();
        check(
            'raw table-row selection highlights all three header cells',
            rowTableState.spans.length === 3 &&
                rowTableState.spans.map(span => span.text).join('|') ===
                    'Given Definition|Expression|Has Type',
            JSON.stringify(rowTableState.spans.map(span => span.text))
        );
        check(
            'raw table-row selection does not select the duplicate paragraph',
            rowTableState.spans.length === 3 &&
                rowTableState.spans.every(span => String(span.cell).length > 0),
            JSON.stringify(rowTableState.spans)
        );
        check(
            'raw table-row selection label stays in the last selected cell',
            rowTableState.labels.length === 1 &&
                rowTableState.spans.length === 3 &&
                String(rowTableState.labels[0].cell).startsWith('Has Type') &&
                rowTableState.labels[0].rect.x >= rowTableState.spans[2].rect.right - 2,
            JSON.stringify(rowTableState.labels)
        );
        check(
            'table widths stay stable when a remote selection is shown',
            rowTableState.widths.length === tableWidthsBefore.length &&
                rowTableState.widths.every(
                    (width, index) => Math.abs(width - tableWidthsBefore[index]) < 0.1
                ),
            JSON.stringify({ before: tableWidthsBefore, after: rowTableState.widths })
        );

        // An idle remote caret must not display a name chip: at another cell
        // that chip looks like the label of the local selection.
        await bob.page.bringToFront();
        await tableLine.click();
        await bob.page.waitForTimeout(150);
        await bob.page.keyboard.press('Home');

        for (let index = 0; index < expressionStart; index++) {
            await bob.page.keyboard.press('ArrowRight');
        }

        await bob.page.waitForTimeout(250);
        await alice.page.bringToFront();
        await alice.page.waitForTimeout(800);
        const idleRichLabels = await visibleRichLabels();
        check(
            'idle raw caret shows no misleading rich name chip',
            idleRichLabels.length === 0,
            JSON.stringify(idleRichLabels)
        );

        await selectRawTableRange(firstWordStart, 16);
        const selectedRichLabels = await visibleRichLabels();
        check(
            'raw selection still shows its name chip at the selected text',
            selectedRichLabels.length === 1 &&
                String(selectedRichLabels[0].cell).startsWith('Given Definition'),
            JSON.stringify(selectedRichLabels)
        );

        // The same rule in the Markdown pane: an idle rich caret should not
        // label itself; a real rich selection should.
        await ensureRaw(alice.page);
        await ensureRich(bob.page);
        await sleep(900);
        await bob.page.bringToFront();
        await bob.page.locator('.ProseMirror th').nth(1).click();
        await bob.page.waitForTimeout(300);
        await alice.page.bringToFront();
        await sleep(800);
        const idleRawLabels = await visibleRawLabels();
        check(
            'idle rich caret shows no misleading Markdown name chip',
            idleRawLabels.length === 0,
            JSON.stringify(idleRawLabels)
        );

        await bob.page.bringToFront();
        const bobFirstHeader = bob.page.locator('.ProseMirror th').first();
        await bobFirstHeader.click();
        await bob.page.waitForTimeout(200);
        await bob.page.keyboard.press('Home');

        for (let index = 0; index < 16; index++) {
            await bob.page.keyboard.press('Shift+ArrowRight');
        }

        await bob.page.waitForTimeout(300);
        await alice.page.bringToFront();
        await sleep(800);
        const selectedRawLabels = await visibleRawLabels();
        check(
            'rich selection still shows its name chip in the Markdown pane',
            selectedRawLabels.length === 1 &&
                selectedRawLabels[0].line.includes('**Given Definition**'),
            JSON.stringify(selectedRawLabels)
        );

        await ensureRich(alice.page);
        await ensureRaw(bob.page);
        await sleep(700);

        // Rich -> raw must select the visible cell text only. The closing `**`
        // is hidden syntax and must not be included in the raw range.
        await ensureRich(alice.page);
        await ensureRaw(bob.page);
        await alice.page.waitForTimeout(900);

        const selectRichHeader = async () => {
            const header = alice.page.locator('.ProseMirror th').first();
            await header.click();
            await alice.page.waitForTimeout(250);
            await alice.page.keyboard.press('Home');

            for (let index = 0; index < 16; index++) {
                await alice.page.keyboard.press('Shift+ArrowRight');
            }

            await alice.page.waitForTimeout(300);

            return alice.page.evaluate(() => window.getSelection()?.toString() ?? '');
        };

        let richHeaderSelection = '';

        for (let attempt = 0; attempt < 3; attempt++) {
            richHeaderSelection = await selectRichHeader();

            if (richHeaderSelection === 'Given Definition') {
                break;
            }
        }

        check(
            'rich header selection is active before checking the raw pane',
            richHeaderSelection === 'Given Definition',
            richHeaderSelection
        );

        await bob.page.bringToFront();
        await bob.page.waitForTimeout(900);
        const richToRawTable = await bob.page.evaluate(() => {
            const line = document.querySelector('.cm-ySelection')?.closest('.cm-line');
            const clone = line?.cloneNode(true);
            clone
                ?.querySelectorAll(
                    '.cm-ySelectionCaret, .cm-ySelectionInfo, .cm-ySelectionCaretDot'
                )
                .forEach(node => node.remove());

            return {
                text: [...document.querySelectorAll('.cm-ySelection')]
                    .map(element => element.textContent ?? '')
                    .join(''),
                line: clone?.textContent ?? '',
            };
        });
        check(
            'rich bold table-cell selection maps to raw without the ** markers',
            richToRawTable.text === 'Given Definition' &&
                richToRawTable.line.includes('**Given Definition**'),
            JSON.stringify(richToRawTable)
        );

        // Two identical tables must disambiguate by document position, not by
        // the first matching text in the note.
        await openNote(alice.page, vaultId, notes.duplicates);
        await ensureRich(alice.page);
        await openNote(bob.page, vaultId, notes.duplicates);
        await ensureRaw(bob.page);

        const duplicateLines = await bob.page.locator('.cm-line').allTextContents();
        const firstDataLine = duplicateLines.findIndex(line => line.includes('| A1 |'));
        const secondDataLine = duplicateLines.findIndex(line => line.includes('| A2 |'));

        async function rawSelectionLine() {
            return bob.page.evaluate(() => {
                const lines = [...document.querySelectorAll('.cm-line')];
                const selection = document.querySelector('.cm-ySelection');

                return {
                    text: [...document.querySelectorAll('.cm-ySelection')]
                        .map(element => element.textContent ?? '')
                        .join(''),
                    lineIndex: selection
                        ? lines.indexOf(selection.closest('.cm-line') ?? undefined)
                        : -1,
                };
            });
        }

        const selectDuplicateHeader = async index => {
            for (let attempt = 0; attempt < 3; attempt++) {
                await alice.page.bringToFront();
                await alice.page.locator('.ProseMirror th').nth(index).click();
                await alice.page.waitForTimeout(250);
                await alice.page.keyboard.press('Home');

                for (let offset = 0; offset < 16; offset++) {
                    await alice.page.keyboard.press('Shift+ArrowRight');
                }

                await alice.page.waitForTimeout(300);

                const selected = await alice.page.evaluate(
                    () => window.getSelection()?.toString() ?? ''
                );

                if (selected === 'Given Definition') {
                    return true;
                }
            }

            return false;
        };

        const firstHeaderSelected = await selectDuplicateHeader(0);
        check(
            'rich selection in the first duplicate table is active',
            firstHeaderSelected,
            String(firstHeaderSelected)
        );
        await bob.page.bringToFront();
        await bob.page.waitForTimeout(900);
        const firstTableRaw = await rawSelectionLine();
        check(
            'rich selection in the first duplicate table maps to the first table',
            firstTableRaw.text === 'Given Definition' &&
                firstTableRaw.lineIndex === firstDataLine - 2,
            JSON.stringify({ firstTableRaw, firstDataLine })
        );

        const secondHeaderSelected = await selectDuplicateHeader(3);
        check(
            'rich selection in the second duplicate table is active',
            secondHeaderSelected,
            String(secondHeaderSelected)
        );
        await bob.page.bringToFront();
        await bob.page.waitForTimeout(900);
        const secondTableRaw = await rawSelectionLine();
        check(
            'rich selection in the second duplicate table maps to the second table',
            secondTableRaw.text === 'Given Definition' &&
                secondTableRaw.lineIndex === secondDataLine - 2,
            JSON.stringify({ secondTableRaw, secondDataLine })
        );

        const secondHeaderLine = bob.page.locator('.cm-line').nth(secondDataLine - 2);
        await secondHeaderLine.click();
        await bob.page.waitForTimeout(150);
        await bob.page.keyboard.press('Home');
        await bob.page.keyboard.press('Shift+End');
        await bob.page.waitForTimeout(300);
        await alice.page.bringToFront();
        await alice.page.waitForTimeout(900);
        const duplicateRowState = await richTableSelection();
        check(
            'raw second duplicate row highlights only the second table',
            duplicateRowState.spans.length === 3 &&
                duplicateRowState.spans.every(span => span.table === 1),
            JSON.stringify(duplicateRowState.spans)
        );

        // A repeated last word ("Type") must pick the occurrence nearest the
        // selection end so the whole header row is covered.
        await openNote(alice.page, vaultId, notes.words);
        await ensureRich(alice.page);
        await openNote(bob.page, vaultId, notes.words);
        await ensureRaw(bob.page);
        const wordsLine = bob.page.locator('.cm-line').filter({ hasText: '**Same**' }).first();
        await wordsLine.click();
        await bob.page.waitForTimeout(150);
        await bob.page.keyboard.press('Home');
        await bob.page.keyboard.press('Shift+End');
        await bob.page.waitForTimeout(300);
        const wordsNative = await bob.page.evaluate(() => window.getSelection()?.toString() ?? '');
        check(
            'raw repeated header selection covers the full row',
            (wordsNative.match(/\*\*Type\*\*/g) ?? []).length === 2 &&
                wordsNative.trim().endsWith('|'),
            wordsNative
        );
        await alice.page.bringToFront();
        await alice.page.waitForTimeout(900);
        const repeatedWordState = await richTableSelection();
        check(
            'raw repeated header words highlight every cell',
            repeatedWordState.spans.map(span => span.text).join('|') === 'Same|Same|Type|Type' &&
                repeatedWordState.labels.length === 1 &&
                String(repeatedWordState.labels[0].cell).startsWith('Type'),
            JSON.stringify(repeatedWordState)
        );

        // Long note smoke test.
        await openNote(alice.page, vaultId, notes.long);
        await ensureRaw(alice.page);
        await alice.page.locator('.cm-content').click();
        await alice.page.keyboard.press('Control+End');
        await alice.page.waitForTimeout(200);
        check(
            'long note is fully present in raw mode',
            (await rawText(alice.page)).includes('Paragraph 120:')
        );
        await ensureRich(alice.page);
        check(
            'long note is fully present in rich mode',
            (await richText(alice.page)).includes('Paragraph 120:')
        );

        check(
            'no uncaught page or console errors',
            consoleErrors.length === 0,
            consoleErrors.join(' | ')
        );
    } finally {
        await browser.close();

        if (!KEEP) {
            try {
                runPhp('tests/e2e/cleanup-live-collaboration.php', [String(vaultId)]);
            } catch (error) {
                console.error('Cleanup failed', error.message);
            }
        }
    }

    const failed = results.filter(result => !result.ok);

    console.log(
        `\nRESULT ${results.length - failed.length}/${results.length} passed${
            failed.length > 0 ? `; failed: ${failed.map(result => result.name).join(', ')}` : ''
        }`
    );

    process.exit(failed.length === 0 ? 0 : 1);
}

main().catch(error => {
    console.error('E2E FATAL', error);
    process.exit(1);
});
