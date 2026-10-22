<?php

declare(strict_types=1);

use App\Support\BuildManifest;

it('serves the current frontend build without caching', function (): void {
    $response = $this->get(route('app.version'));

    $response->assertOk()->assertJson(['build' => BuildManifest::id()]);

    $cacheControl = (string) $response->headers->get('Cache-Control');

    expect($cacheControl)->toContain('no-store')->toContain('no-cache');
});

it('embeds the current build in the page head', function (): void {
    $this->get(route('login'))
        ->assertOk()
        ->assertSee('name="app-build"', false)
        ->assertSee(BuildManifest::id(), false);
});
