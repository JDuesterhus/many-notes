<?php

declare(strict_types=1);

namespace App\Events;

use App\Models\VaultNode;
use App\ViewModels\VaultNodeViewModel;
use App\ViewModels\VaultOpenedFileDataViewModel;
use Illuminate\Broadcasting\Channel;
use Illuminate\Broadcasting\InteractsWithSockets;
use Illuminate\Broadcasting\PrivateChannel;
use Illuminate\Contracts\Broadcasting\ShouldBroadcastNow;

final class VaultOpenedFileDataUpdatedEvent implements ShouldBroadcastNow
{
    use InteractsWithSockets;

    public function __construct(
        private VaultNode $file,
        private bool $includeContent = true,
    ) {
        //
    }

    /** @return array<int, Channel> */
    public function broadcastOn(): array
    {
        return [
            new PrivateChannel('Vault.' . $this->file->vault_id),
        ];
    }

    /** @return array<string, mixed> */
    public function broadcastWith(): array
    {
        return [
            'data' => [
                'file' => $this->includeContent
                    ? VaultNodeViewModel::fromModel($this->file)
                    : VaultNodeViewModel::fromModelWithoutContent($this->file),
                ...(array) VaultOpenedFileDataViewModel::fromModel($this->file),
            ],
        ];
    }
}
