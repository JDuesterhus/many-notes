<?php

declare(strict_types=1);

namespace App\Services;

use Illuminate\Http\Client\PendingRequest;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Log;
use Throwable;

final readonly class YjsServiceClient
{
    public function documentExists(string $room): ?bool
    {
        if (!$this->isConfigured()) {
            return null;
        }

        try {
            $response = $this->request()->get($this->baseUrl() . '/internal/documents/exists', [
                'name' => $room,
            ]);
        } catch (Throwable) {
            Log::warning('Could not reach the Yjs service for a document existence check.');

            return null;
        }

        if (!$response->successful()) {
            return null;
        }

        $exists = $response->json('exists');

        return is_bool($exists) ? $exists : null;
    }

    public function revokeUser(int $vaultId, int $userId): bool
    {
        if (!$this->isConfigured()) {
            return false;
        }

        try {
            $response = $this->request()->post($this->baseUrl() . '/internal/revoke', [
                'vault_id' => $vaultId,
                'user_id' => $userId,
            ]);
        } catch (Throwable) {
            Log::warning('Could not revoke Yjs access for a user.', [
                'vault_id' => $vaultId,
                'user_id' => $userId,
            ]);

            return false;
        }

        return $response->successful();
    }

    public function deleteDocument(string $room): bool
    {
        if (!$this->isConfigured()) {
            return false;
        }

        try {
            $response = $this->request()->delete($this->baseUrl() . '/internal/documents', [
                'name' => $room,
            ]);
        } catch (Throwable) {
            Log::warning('Could not delete a Yjs document.');

            return false;
        }

        return $response->successful();
    }

    private function isConfigured(): bool
    {
        return config()->boolean('yjs.enabled')
            && config()->string('yjs.internal_token') !== ''
            && config()->string('yjs.internal_url') !== '';
    }

    private function request(): PendingRequest
    {
        return Http::withHeaders([
            'X-Internal-Token' => config()->string('yjs.internal_token'),
            'Accept' => 'application/json',
        ])->timeout(config()->integer('yjs.internal_timeout'));
    }

    private function baseUrl(): string
    {
        return mb_rtrim(config()->string('yjs.internal_url'), '/');
    }
}
