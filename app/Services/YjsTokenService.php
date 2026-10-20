<?php

declare(strict_types=1);

namespace App\Services;

use App\Models\User;
use App\Support\YjsRoom;
use Carbon\CarbonImmutable;
use JsonException;

final readonly class YjsTokenService
{
    /**
     * @return array{token: string, expires_at: CarbonImmutable}
     */
    public function issue(User $user, YjsRoom $room, bool $canEdit = true): array
    {
        $now = CarbonImmutable::now();
        $expiresAt = $now->addSeconds(config()->integer('yjs.token_ttl'));

        $payload = [
            'sub' => (string) $user->id,
            'name' => $user->name,
            'vault_id' => $room->vaultId,
            'node_id' => $room->nodeId,
            'room' => $room->name(),
            'can_edit' => $canEdit,
            'iss' => config()->string('yjs.jwt_issuer'),
            'aud' => config()->string('yjs.jwt_audience'),
            'iat' => $now->getTimestamp(),
            'exp' => $expiresAt->getTimestamp(),
            'jti' => bin2hex(random_bytes(16)),
        ];

        return [
            'token' => $this->encode($payload),
            'expires_at' => $expiresAt,
        ];
    }

    /**
     * Verify a token issued by this application. The Hocuspocus service uses
     * the same algorithm and secret; this method exists for diagnostics and
     * tests.
     *
     * @return array<string, mixed>|null
     */
    public function verify(string $token): ?array
    {
        $parts = explode('.', $token);

        if (count($parts) !== 3) {
            return null;
        }

        [$encodedHeader, $encodedPayload, $encodedSignature] = $parts;

        try {
            /** @var array<string, mixed> $header */
            $header = json_decode($this->base64UrlDecode($encodedHeader), true, 512, JSON_THROW_ON_ERROR);
            /** @var array<string, mixed> $payload */
            $payload = json_decode($this->base64UrlDecode($encodedPayload), true, 512, JSON_THROW_ON_ERROR);
        } catch (JsonException) {
            return null;
        }

        if (($header['alg'] ?? null) !== 'HS256' || ($header['typ'] ?? null) !== 'JWT') {
            return null;
        }

        $expected = $this->sign("{$encodedHeader}.{$encodedPayload}");

        if (!hash_equals($expected, $encodedSignature)) {
            return null;
        }

        if (($payload['iss'] ?? null) !== config()->string('yjs.jwt_issuer')) {
            return null;
        }

        if (($payload['aud'] ?? null) !== config()->string('yjs.jwt_audience')) {
            return null;
        }

        $expiresAt = $payload['exp'] ?? null;

        if (!is_int($expiresAt) || $expiresAt <= CarbonImmutable::now()->getTimestamp()) {
            return null;
        }

        return $payload;
    }

    /** @param array<string, mixed> $payload */
    private function encode(array $payload): string
    {
        $header = $this->base64UrlEncode(json_encode([
            'alg' => 'HS256',
            'typ' => 'JWT',
        ], JSON_THROW_ON_ERROR));

        $body = $this->base64UrlEncode(json_encode($payload, JSON_THROW_ON_ERROR));
        $signature = $this->sign("{$header}.{$body}");

        return "{$header}.{$body}.{$signature}";
    }

    private function sign(string $data): string
    {
        $secret = config()->string('yjs.jwt_secret');

        return $this->base64UrlEncode(hash_hmac('sha256', $data, $secret, true));
    }

    private function base64UrlEncode(string $value): string
    {
        return mb_rtrim(strtr(base64_encode($value), '+/', '-_'), '=');
    }

    private function base64UrlDecode(string $value): string
    {
        $padding = mb_strlen($value) % 4;
        $decoded = base64_decode(strtr($value . str_repeat('=', $padding === 0 ? 0 : 4 - $padding), '-_', '+/'), true);

        if ($decoded === false) {
            throw new JsonException('Invalid base64 payload.');
        }

        return $decoded;
    }
}
