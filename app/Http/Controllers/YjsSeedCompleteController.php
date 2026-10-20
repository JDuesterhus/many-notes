<?php

declare(strict_types=1);

namespace App\Http\Controllers;

use App\Actions\ResolveCollaborativeNote;
use App\Http\Requests\YjsSeedCompleteRequest;
use App\Models\CollaborationDocument;
use App\Models\User;
use Illuminate\Container\Attributes\CurrentUser;
use Illuminate\Http\JsonResponse;

final readonly class YjsSeedCompleteController
{
    public function __invoke(
        YjsSeedCompleteRequest $request,
        #[CurrentUser] User $user,
        ResolveCollaborativeNote $resolveCollaborativeNote,
    ): JsonResponse {
        abort_unless(config()->boolean('yjs.enabled'), 503, 'Collaboration is disabled.');

        /** @var array{vault_id: int, node_id: int, claim_id: string} $data */
        $data = $request->validated();

        $node = $resolveCollaborativeNote->handle($user, $data['vault_id'], $data['node_id']);

        $updated = CollaborationDocument::query()
            ->where('vault_node_id', $node->id)
            ->where('seed_claim_id', $data['claim_id'])
            ->update([
                'seeded_at' => now(),
                'seed_claimed_at' => null,
                'seed_claim_id' => null,
                'updated_at' => now(),
            ]);

        return response()->json([
            'completed' => $updated === 1,
        ]);
    }
}
