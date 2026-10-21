<?php

declare(strict_types=1);

use App\Actions\DeleteVault;
use App\Models\Vault;
use Illuminate\Support\Facades\Storage;

require dirname(__DIR__, 2).'/vendor/autoload.php';

/** @var Illuminate\Foundation\Application $app */
$app = require dirname(__DIR__, 2).'/bootstrap/app.php';
$app->make(Illuminate\Contracts\Console\Kernel::class)->bootstrap();

$vaultId = (int) ($argv[1] ?? 0);

if ($vaultId <= 0) {
    fwrite(STDERR, "Usage: php cleanup-live-collaboration.php <vault-id>\n");
    exit(1);
}

$vault = Vault::query()->find($vaultId);

if ($vault !== null) {
    app(DeleteVault::class)->handle($vault);
    Storage::disk('local')->deleteDirectory("vaults/{$vaultId}");
}

echo "cleaned\n";
