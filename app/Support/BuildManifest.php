<?php

declare(strict_types=1);

namespace App\Support;

final readonly class BuildManifest
{
    /**
     * A stable identifier for the currently deployed frontend build.
     *
     * The Vite manifest changes whenever a production asset changes. Reading
     * and hashing it avoids relying on a single chunk hash (a CSS-only build
     * would otherwise look unchanged).
     */
    public static function id(): string
    {
        $path = public_path('build/manifest.json');

        if (! is_file($path)) {
            return 'dev';
        }

        $hash = hash_file('sha256', $path);

        return $hash === false ? 'dev' : substr($hash, 0, 16);
    }
}
