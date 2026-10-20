<?php

declare(strict_types=1);

namespace App\Support;

final readonly class YjsRoom
{
    private const string PATTERN = '/^vault:(?<vault>[1-9]\d*):node:(?<node>[1-9]\d*)$/';

    public function __construct(
        public int $vaultId,
        public int $nodeId,
    ) {
        //
    }

    public static function fromIds(int $vaultId, int $nodeId): self
    {
        return new self($vaultId, $nodeId);
    }

    public static function tryFromString(string $room): ?self
    {
        if (preg_match(self::PATTERN, $room, $matches) !== 1) {
            return null;
        }

        $vaultId = filter_var($matches['vault'], FILTER_VALIDATE_INT);
        $nodeId = filter_var($matches['node'], FILTER_VALIDATE_INT);

        if ($vaultId === false || $nodeId === false || $vaultId < 1 || $nodeId < 1) {
            return null;
        }

        return new self($vaultId, $nodeId);
    }

    public function name(): string
    {
        return "vault:{$this->vaultId}:node:{$this->nodeId}";
    }

    public function equals(self $other): bool
    {
        return $this->vaultId === $other->vaultId && $this->nodeId === $other->nodeId;
    }
}
