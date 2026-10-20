export interface Room {
    vaultId: number;
    nodeId: number;
}

const ROOM_PATTERN = /^vault:(?<vault>[1-9]\d*):node:(?<node>[1-9]\d*)$/;

export function parseRoom(name: string): Room | null {
    const match = ROOM_PATTERN.exec(name);

    if (!match) {
        return null;
    }

    const vaultId = Number.parseInt(match[1] ?? '', 10);
    const nodeId = Number.parseInt(match[2] ?? '', 10);

    if (!Number.isSafeInteger(vaultId) || !Number.isSafeInteger(nodeId)) {
        return null;
    }

    if (vaultId < 1 || nodeId < 1) {
        return null;
    }

    return { vaultId, nodeId };
}

export function roomName(vaultId: number, nodeId: number): string {
    return `vault:${vaultId}:node:${nodeId}`;
}
