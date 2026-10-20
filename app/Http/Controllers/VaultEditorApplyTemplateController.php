<?php

declare(strict_types=1);

namespace App\Http\Controllers;

use App\Actions\ApplyTemplateToVaultNode;
use App\Http\Requests\ApplyTemplateToVaultNodeRequest;
use App\Models\User;
use App\Models\Vault;
use App\Models\VaultNode;
use Illuminate\Container\Attributes\CurrentUser;
use Illuminate\Http\JsonResponse;

final readonly class VaultEditorApplyTemplateController
{
    public function __invoke(
        ApplyTemplateToVaultNodeRequest $request,
        Vault $vault,
        VaultNode $template,
        #[CurrentUser] User $user,
        ApplyTemplateToVaultNode $applyTemplateToVaultNode,
    ): JsonResponse {
        abort_unless($user->can('update', $vault), 403);

        /** @var array{node_id: int, content?: string|null} $data */
        $data = $request->validated();

        /** @var VaultNode $node */
        $node = $vault->nodes()->findOrFail($data['node_id']);

        $content = $applyTemplateToVaultNode->render(
            $template,
            $data['content'] ?? (string) $node->content,
        );

        return response()->json([
            'data' => [
                'content' => $content,
            ],
        ]);
    }
}
