export interface PresenceUser {
    id: string;
    name: string;
    initials: string;
    color: string;
}

const COLORS = [
    '#2563eb',
    '#c2410c',
    '#047857',
    '#7c3aed',
    '#be123c',
    '#0369a1',
    '#a16207',
    '#4d7c0f',
    '#9333ea',
    '#b91c1c',
] as const;

export function presenceColor(userId: number | string): string {
    const numericId = typeof userId === 'number' ? userId : Number.parseInt(userId, 10);
    const index = Number.isSafeInteger(numericId) ? Math.abs(numericId) % COLORS.length : 0;

    return COLORS[index] ?? COLORS[0];
}

export function initials(name: string): string {
    const parts = name
        .trim()
        .split(/\s+/)
        .filter(part => part.length > 0);

    if (parts.length === 0) {
        return '?';
    }

    if (parts.length === 1) {
        return parts[0]!.slice(0, 2).toUpperCase();
    }

    return `${parts[0]![0] ?? ''}${parts[parts.length - 1]![0] ?? ''}`.toUpperCase();
}

export function presenceUser(id: string, name: string): PresenceUser {
    return {
        id,
        name,
        initials: initials(name),
        color: presenceColor(id),
    };
}
