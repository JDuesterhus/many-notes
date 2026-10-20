<?php

declare(strict_types=1);

namespace App\Actions;

use App\Models\User;
use App\Models\Vault;
use App\Models\VaultNode;

final readonly class ResolveCollaborativeNote
{
    public function handle(User $user, int $vaultId, int $nodeId): VaultNode
    {
        $vault = Vault::query()->find($vaultId);

        abort_if($vault === null, 404);
        abort_unless($user->can('update', $vault), 403);

        // Scoping the lookup to the vault prevents cross-vault note access even
        // when a user knows a valid node id from another vault.
        $node = $vault
            ->nodes()
            ->whereKey($nodeId)
            ->first();

        abort_if($node === null, 404);
        abort_unless($node->is_file && $node->extension === 'md', 404);

        return $node;
    }
}
