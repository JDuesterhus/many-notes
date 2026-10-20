<?php

declare(strict_types=1);

namespace App\Models;

use Carbon\CarbonImmutable;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Override;

/**
 * @property-read int $id
 * @property-read int $vault_node_id
 * @property-read int $snapshot_seq
 * @property-read CarbonImmutable|null $snapshot_updated_at
 * @property-read CarbonImmutable|null $seeded_at
 * @property-read CarbonImmutable|null $seed_claimed_at
 * @property-read string|null $seed_claim_id
 * @property-read int|null $seed_claimed_by
 * @property-read CarbonImmutable $created_at
 * @property-read CarbonImmutable $updated_at
 * @property-read VaultNode $node
 */
final class CollaborationDocument extends Model
{
    /** @return BelongsTo<VaultNode, $this> */
    public function node(): BelongsTo
    {
        return $this->belongsTo(VaultNode::class, 'vault_node_id');
    }

    #[Override]
    protected function casts(): array
    {
        return [
            'vault_node_id' => 'integer',
            'snapshot_seq' => 'integer',
            'snapshot_updated_at' => 'datetime',
            'seeded_at' => 'datetime',
            'seed_claimed_at' => 'datetime',
            'seed_claimed_by' => 'integer',
        ];
    }
}
