<?php

declare(strict_types=1);

namespace App\Http\Controllers;

use App\Actions\ResolveCollaborativeNote;
use App\Http\Requests\YjsNoteRequest;
use App\Models\CollaborationDocument;
use App\Models\User;
use App\Services\YjsServiceClient;
use App\Services\YjsTokenService;
use App\Support\YjsRoom;
use Illuminate\Container\Attributes\CurrentUser;
use Illuminate\Http\JsonResponse;

final readonly class YjsTokenController
{
    public function __invoke(
        YjsNoteRequest $request,
        #[CurrentUser] User $user,
        ResolveCollaborativeNote $resolveCollaborativeNote,
        YjsTokenService $yjsTokenService,
        YjsServiceClient $yjsServiceClient,
    ): JsonResponse {
        abort_unless(config()->boolean('yjs.enabled'), 503, 'Collaboration is disabled.');
        abort_if(config()->string('yjs.jwt_secret') === '', 503, 'Collaboration is not configured.');

        /** @var array{vault_id: int, node_id: int} $data */
        $data = $request->validated();

        $node = $resolveCollaborativeNote->handle($user, $data['vault_id'], $data['node_id']);
        $room = YjsRoom::fromIds($node->vault_id, $node->id);

        $document = CollaborationDocument::query()->firstOrCreate([
            'vault_node_id' => $node->id,
        ], [
            'snapshot_seq' => 0,
        ]);

        $token = $yjsTokenService->issue($user, $room);

        return response()->json([
            'token' => $token['token'],
            'room' => $room->name(),
            'expires_at' => $token['expires_at']->toIso8601String(),
            'snapshot_seq' => $document->snapshot_seq,
            'snapshot_updated_at' => $document->snapshot_updated_at?->toIso8601String(),
            'seeded' => $document->seeded_at !== null,
            'yjs_state_exists' => $yjsServiceClient->documentExists($room->name()),
            'can_edit' => true,
        ]);
    }
}
