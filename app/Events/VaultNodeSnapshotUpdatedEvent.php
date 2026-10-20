<?php

declare(strict_types=1);

namespace App\Events;

use App\Models\VaultNode;
use Carbon\CarbonImmutable;
use Illuminate\Broadcasting\Channel;
use Illuminate\Broadcasting\InteractsWithSockets;
use Illuminate\Broadcasting\PrivateChannel;
use Illuminate\Contracts\Broadcasting\ShouldBroadcastNow;

/**
 * Metadata-only event for a saved Markdown snapshot.
 *
 * Note content is intentionally never broadcast for a live collaboration
 * document: Yjs is the source of truth and a full-document broadcast would
 * overwrite concurrent edits.
 */
final class VaultNodeSnapshotUpdatedEvent implements ShouldBroadcastNow
{
    use InteractsWithSockets;

    public function __construct(
        private VaultNode $node,
        private int $snapshotSeq,
        private CarbonImmutable $savedAt,
    ) {
        //
    }

    /** @return array<int, Channel> */
    public function broadcastOn(): array
    {
        return [
            new PrivateChannel('Vault.' . $this->node->vault_id),
        ];
    }

    /** @return array<string, mixed> */
    public function broadcastWith(): array
    {
        return [
            'data' => [
                'node_id' => $this->node->id,
                'vault_id' => $this->node->vault_id,
                'snapshot_seq' => $this->snapshotSeq,
                'snapshot_updated_at' => $this->savedAt->toIso8601String(),
            ],
        ];
    }
}
