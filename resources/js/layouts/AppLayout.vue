<script setup lang="ts">
import { useBuildVersion } from '@/composables/useBuildVersion';
import { onMounted, onUnmounted } from 'vue';

const { updateAvailable, reload } = useBuildVersion();

onMounted(() => {
    document.querySelector('#app')?.classList.add('flex', 'flex-col', 'h-dvh', 'print:h-auto');

    globalThis.addEventListener('dragover', prevent);
    globalThis.addEventListener('drop', prevent);
});

onUnmounted(() => {
    globalThis.removeEventListener('dragover', prevent);
    globalThis.removeEventListener('drop', prevent);
});

function prevent(event: DragEvent) {
    event.preventDefault();
}
</script>

<template>
    <slot />

    <div
        v-if="updateAvailable"
        class="fixed inset-x-0 bottom-4 z-[80] flex justify-center px-4 print:hidden"
        aria-live="polite"
        aria-atomic="true"
        data-update-banner
    >
        <div
            class="border-light-base-400 bg-light-base-50 text-light-base-950 dark:border-base-700 dark:bg-base-900 dark:text-base-50 flex items-center gap-3 rounded-lg border px-4 py-3 text-sm shadow-lg"
        >
            <span>A new version is available.</span>
            <button
                type="button"
                class="bg-light-base-950 text-light-base-50 dark:bg-base-50 dark:text-base-950 rounded px-3 py-1.5 text-xs font-medium"
                @click="reload"
            >
                Reload
            </button>
        </div>
    </div>
</template>
