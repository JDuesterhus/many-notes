<?php

declare(strict_types=1);

namespace App\Http\Controllers;

use App\Support\BuildManifest;
use Illuminate\Http\JsonResponse;

final readonly class AppVersionController
{
    public function __invoke(): JsonResponse
    {
        return response()
            ->json(['build' => BuildManifest::id()])
            ->header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
            ->header('Pragma', 'no-cache');
    }
}
