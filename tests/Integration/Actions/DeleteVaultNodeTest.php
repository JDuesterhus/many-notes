<?php

declare(strict_types=1);

use App\Actions\CreateVault;
use App\Actions\CreateVaultNode;
use App\Actions\DeleteVaultNode;
use App\Models\User;
use App\Models\VaultNode;

it('deletes a node loaded from the database without its inverse vault relation', function (): void {
    $user = User::factory()->create();
    $vault = app(CreateVault::class)->handle($user, ['name' => fake()->words(3, true)]);
    $note = app(CreateVaultNode::class)->handle($vault, [
        'is_file' => true,
        'name' => 'note',
        'extension' => 'md',
        'content' => 'Body',
    ]);

    $fresh = VaultNode::query()->findOrFail($note->id);

    app(DeleteVaultNode::class)->handle($fresh);

    expect(VaultNode::query()->find($note->id))->toBeNull();
});
