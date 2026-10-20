<?php

declare(strict_types=1);

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    /**
     * Run the migrations.
     */
    public function up(): void
    {
        Schema::create('collaboration_documents', function (Blueprint $table): void {
            $table->id();
            $table->foreignId('vault_node_id')->unique()->constrained('vault_nodes')->cascadeOnDelete();
            $table->unsignedBigInteger('snapshot_seq')->default(0);
            $table->timestamp('snapshot_updated_at')->nullable();
            $table->timestamp('seeded_at')->nullable();
            $table->timestamp('seed_claimed_at')->nullable();
            $table->string('seed_claim_id', 64)->nullable();
            $table->foreignId('seed_claimed_by')->nullable()->constrained('users')->nullOnDelete();
            $table->timestamps();
        });
    }

    /**
     * Reverse the migrations.
     */
    public function down(): void
    {
        Schema::dropIfExists('collaboration_documents');
    }
};
