<?php

declare(strict_types=1);

namespace App\Events;

use App\Models\VaultNode;
use Illuminate\Broadcasting\Channel;
use Illuminate\Broadcasting\InteractsWithSockets;
use Illuminate\Broadcasting\PrivateChannel;
use Illuminate\Contracts\Broadcasting\ShouldBroadcastNow;

/**
 * Metadata-only event for link/image paths rewritten after a rename or move.
 *
 * The note content is not part of the payload. A live client applies the path
 * rewrite to its Yjs document so a later Markdown snapshot cannot revert the
 * server-side backlink update.
 */
final class VaultNodeLinksRewrittenEvent implements ShouldBroadcastNow
{
    use InteractsWithSockets;

    public function __construct(
        private VaultNode $node,
        private string $originalPath,
        private string $replacementPath,
        private string $extension,
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
                'original_path' => $this->originalPath,
                'replacement_path' => $this->replacementPath,
                'extension' => $this->extension,
            ],
        ];
    }
}
