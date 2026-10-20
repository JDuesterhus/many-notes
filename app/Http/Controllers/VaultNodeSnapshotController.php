<?php

declare(strict_types=1);

namespace App\Http\Controllers;

use App\Actions\UpdateVaultNode;
use App\Events\VaultNodeSnapshotUpdatedEvent;
use App\Http\Requests\StoreVaultNodeSnapshotRequest;
use App\Models\CollaborationDocument;
use App\Models\User;
use App\Models\Vault;
use App\Models\VaultNode;
use Illuminate\Container\Attributes\CurrentUser;
use Illuminate\Http\JsonResponse;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;

final readonly class VaultNodeSnapshotController
{
    public function __invoke(
        StoreVaultNodeSnapshotRequest $request,
        Vault $vault,
        VaultNode $node,
        #[CurrentUser] User $user,
        UpdateVaultNode $updateVaultNode,
    ): JsonResponse {
        abort_unless($user->can('update', $vault), 403);
        abort_unless($node->vault_id === $vault->id, 404);
        abort_unless($node->is_file && $node->extension === 'md', 404);

        /** @var array{content: string, base_seq: int} $data */
        $data = $request->validated();

        return DB::transaction(function () use ($node, $data, $updateVaultNode): JsonResponse {
            DB::table('collaboration_documents')->insertOrIgnore([
                'vault_node_id' => $node->id,
                'snapshot_seq' => 0,
                'created_at' => now(),
                'updated_at' => now(),
            ]);

            $document = CollaborationDocument::query()
                ->where('vault_node_id', $node->id)
                ->lockForUpdate()
                ->firstOrFail();

            if ($document->snapshot_seq !== $data['base_seq']) {
                // Several clients can materialize the same merged Yjs state.
                // An identical late snapshot is a harmless no-op rather than
                // an error; only a different, older document is rejected.
                if ($data['content'] === (string) $node->content) {
                    return response()->json([
                        'data' => [
                            'snapshot_seq' => $document->snapshot_seq,
                            'snapshot_updated_at' => $document->snapshot_updated_at?->toIso8601String(),
                            'updated_at' => $node->updated_at->toIso8601String(),
                        ],
                    ]);
                }

                Log::warning('Rejected a stale Markdown snapshot.', [
                    'node_id' => $node->id,
                    'base_seq' => $data['base_seq'],
                    'current_seq' => $document->snapshot_seq,
                ]);

                return response()->json([
                    'message' => 'Stale snapshot.',
                    'snapshot_seq' => $document->snapshot_seq,
                    'snapshot_updated_at' => $document->snapshot_updated_at?->toIso8601String(),
                ], 409);
            }

            $node = $updateVaultNode->handle($node, [
                'content' => $data['content'],
            ], broadcastContent: false);

            $nextSeq = $document->snapshot_seq + 1;
            $savedAt = now();

            $document->update([
                'snapshot_seq' => $nextSeq,
                'snapshot_updated_at' => $savedAt,
            ]);

            broadcast(new VaultNodeSnapshotUpdatedEvent($node, $nextSeq, $savedAt));

            return response()->json([
                'data' => [
                    'snapshot_seq' => $nextSeq,
                    'snapshot_updated_at' => $savedAt->toIso8601String(),
                    'updated_at' => $node->updated_at->toIso8601String(),
                ],
            ]);
        });
    }
}
