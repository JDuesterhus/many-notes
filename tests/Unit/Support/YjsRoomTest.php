<?php

declare(strict_types=1);

use App\Support\YjsRoom;

it('builds and parses a room', function (): void {
    $room = YjsRoom::fromIds(12, 345);

    expect($room->name())->toBe('vault:12:node:345')
        ->and(YjsRoom::tryFromString('vault:12:node:345')?->equals($room))->toBeTrue();
});

it('rejects malformed rooms', function (string $room): void {
    expect(YjsRoom::tryFromString($room))->toBeNull();
})->with([
    'empty' => [''],
    'note id only' => ['345'],
    'missing node' => ['vault:12'],
    'missing vault' => ['node:345'],
    'zero vault' => ['vault:0:node:345'],
    'zero node' => ['vault:12:node:0'],
    'negative' => ['vault:-12:node:345'],
    'extra segment' => ['vault:12:node:345:extra'],
    'letters' => ['vault:a:node:b'],
]);
