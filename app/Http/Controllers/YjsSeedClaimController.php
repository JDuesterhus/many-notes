<?php

declare(strict_types=1);

namespace App\Http\Controllers;

use App\Actions\ResolveCollaborativeNote;
use App\Http\Requests\YjsNoteRequest;
use App\Models\CollaborationDocument;
use App\Models\User;
use App\Services\YjsServiceClient;
use App\Support\YjsRoom;
use Illuminate\Container\Attributes\CurrentUser;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Http\JsonResponse;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

final readonly class YjsSeedClaimController
{
    public function __invoke(
        YjsNoteRequest $request,
        #[CurrentUser] User $user,
        ResolveCollaborativeNote $resolveCollaborativeNote,
        YjsServiceClient $yjsServiceClient,
    ): JsonResponse {
        abort_unless(config()->boolean('yjs.enabled'), 503, 'Collaboration is disabled.');

        /** @var array{vault_id: int, node_id: int} $data */
        $data = $request->validated();

        $node = $resolveCollaborativeNote->handle($user, $data['vault_id'], $data['node_id']);
        $room = YjsRoom::fromIds($node->vault_id, $node->id);

        $now = now();
        $claimId = (string) Str::uuid();
        $lease = $now->subSeconds(config()->integer('yjs.seed_claim_ttl'));

        DB::table('collaboration_documents')->insertOrIgnore([
            'vault_node_id' => $node->id,
            'snapshot_seq' => 0,
            'created_at' => $now,
            'updated_at' => $now,
        ]);

        $document = CollaborationDocument::query()
            ->where('vault_node_id', $node->id)
            ->firstOrFail();

        $stateExists = $yjsServiceClient->documentExists($room->name());

        // A document that already has a Yjs state must never be seeded again.
        // An existing state is also the only reliable signal that an empty
        // note was emptied intentionally rather than never initialized.
        if ($document->seeded_at !== null && $stateExists !== false) {
            return response()->json([
                'claimed' => false,
                'claim_id' => null,
                'retry_after' => null,
                'snapshot_seq' => $document->snapshot_seq,
                'seeded' => true,
            ]);
        }

        $claimed = CollaborationDocument::query()
            ->where('vault_node_id', $node->id)
            ->where(function (Builder $query) use ($lease): void {
                $query
                    ->whereNull('seed_claimed_at')
                    ->orWhere('seed_claimed_at', '<', $lease);
            })
            ->update([
                'seed_claimed_at' => $now,
                'seed_claim_id' => $claimId,
                'seed_claimed_by' => $user->id,
                'updated_at' => $now,
            ]) === 1;

        $document->refresh();

        return response()->json([
            'claimed' => $claimed,
            'claim_id' => $claimed ? $claimId : null,
            'retry_after' => $claimed ? null : config()->integer('yjs.seed_claim_ttl'),
            'snapshot_seq' => $document->snapshot_seq,
            'seeded' => $document->seeded_at !== null,
        ]);
    }
}
