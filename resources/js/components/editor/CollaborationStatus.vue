<script setup lang="ts">
import {
    CollaborationStatus as CollaborationStatusType,
    PresenceUser,
} from '@/types/collaboration';
import { computed } from 'vue';

const props = defineProps<{
    status: CollaborationStatusType;
    participants: PresenceUser[];
    snapshotError: string | null;
    tokenError: string | null;
    canEdit: boolean;
    modeLocked: boolean;
    modeLockedBy: PresenceUser | null;
    modeLockedMode: 'rich' | 'raw' | null;
}>();

const label = computed(() => {
    switch (props.status) {
        case 'connecting':
            return 'Connecting…';
        case 'connected':
            return props.canEdit && !props.modeLocked ? 'Live' : 'Read only';
        case 'reconnecting':
            return 'Reconnecting…';
        case 'offline':
            return 'Offline – changes are kept locally';
        case 'no-permission':
            return 'No permission';
        case 'token-expired':
            return 'Token expired';
        case 'error':
            return 'Collaboration unavailable';
        case 'disabled':
            return 'Collaboration disabled';
        default:
            return '';
    }
});

const tone = computed(() => {
    switch (props.status) {
        case 'connected':
            return 'text-success-600 dark:text-success-500';
        case 'offline':
        case 'reconnecting':
        case 'connecting':
            return 'text-warning-600 dark:text-warning-500';
        case 'no-permission':
        case 'token-expired':
        case 'error':
            return 'text-error-600 dark:text-error-500';
        default:
            return 'text-light-base-700 dark:text-base-300';
    }
});

const modeLockDetail = computed(() => {
    if (!props.modeLocked || !props.modeLockedBy) {
        return '';
    }

    const mode = props.modeLockedMode === 'raw' ? 'Markdown' : 'rich text';

    return `${props.modeLockedBy.name} is editing in ${mode} mode.`;
});

const detail = computed(
    () => props.tokenError ?? props.snapshotError ?? modeLockDetail.value ?? ''
);
</script>

<template>
    <div
        class="flex min-h-6 flex-wrap items-center gap-2 px-4 text-xs print:hidden"
        role="status"
        aria-live="polite"
        :title="detail"
    >
        <span class="flex items-center gap-1.5" :class="tone">
            <span class="h-1.5 w-1.5 rounded-full bg-current"></span>
            <span>{{ label }}</span>
        </span>
        <span v-if="modeLockDetail" class="text-warning-600 dark:text-warning-500">
            {{ modeLockDetail }}
        </span>
        <span
            v-if="snapshotError"
            class="text-error-600 dark:text-error-500"
            :title="snapshotError"
        >
            Snapshot delayed
        </span>
        <span
            v-for="participant in participants"
            :key="participant.id"
            class="inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1 text-[10px] font-semibold text-white"
            :style="{ backgroundColor: participant.color }"
            :title="participant.name"
        >
            {{ participant.initials }}
        </span>
    </div>
</template>
