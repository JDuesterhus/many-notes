import { onBeforeUnmount, onMounted, ref } from 'vue';

/**
 * Detect a frontend deployment while the tab stays open.
 *
 * The app is served over plain HTTP on the LAN, where service workers are not
 * available. An already open tab keeps executing its old bundle until it is
 * reloaded, so users can keep testing behavior that was fixed hours ago.
 * Poll a no-store endpoint and prompt for a reload; returning to a tab that
 * has been hidden for a few seconds reloads it automatically.
 */
export function useBuildVersion() {
    const currentBuild =
        document.querySelector<HTMLMetaElement>('meta[name="app-build"]')?.content ?? '';
    const updateAvailable = ref(false);
    let interval: number | null = null;
    let hiddenAt: number | null = null;
    let reloading = false;

    const reload = (): void => {
        if (reloading) {
            return;
        }

        reloading = true;
        window.location.reload();
    };

    const check = async (): Promise<void> => {
        if (!currentBuild || !navigator.onLine) {
            return;
        }

        try {
            const response = await fetch('/app-version', {
                headers: { Accept: 'application/json' },
                cache: 'no-store',
            });

            if (!response.ok) {
                return;
            }

            const data = (await response.json()) as { build?: string };

            if (data.build && data.build !== currentBuild) {
                updateAvailable.value = true;
            }
        } catch {
            // A failed update check must never disturb editing.
        }
    };

    const onFocus = (): void => {
        void check();
    };

    const onOnline = (): void => {
        void check();
    };

    const onVisibilityChange = (): void => {
        if (document.visibilityState === 'hidden') {
            hiddenAt = Date.now();

            return;
        }

        // Returning to an outdated tab is a safe reload point: the editor is
        // no longer focused and Yjs has already flushed the shared text.
        if (updateAvailable.value && hiddenAt !== null && Date.now() - hiddenAt > 3000) {
            reload();

            return;
        }

        hiddenAt = null;
        void check();
    };

    onMounted(() => {
        void check();
        interval = window.setInterval(() => void check(), 20_000);
        window.addEventListener('focus', onFocus);
        window.addEventListener('online', onOnline);
        document.addEventListener('visibilitychange', onVisibilityChange);
    });

    onBeforeUnmount(() => {
        if (interval !== null) {
            window.clearInterval(interval);
        }

        window.removeEventListener('focus', onFocus);
        window.removeEventListener('online', onOnline);
        document.removeEventListener('visibilitychange', onVisibilityChange);
    });

    return { updateAvailable, reload };
}
