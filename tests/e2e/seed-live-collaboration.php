<?php

declare(strict_types=1);

use App\Actions\CreateVault;
use App\Actions\CreateVaultNode;
use App\Models\User;
use Illuminate\Support\Facades\Hash;

require dirname(__DIR__, 2).'/vendor/autoload.php';

/** @var Illuminate\Foundation\Application $app */
$app = require dirname(__DIR__, 2).'/bootstrap/app.php';
$app->make(Illuminate\Contracts\Console\Kernel::class)->bootstrap();

$password = Hash::make('Live!2026pass');
$users = [];

foreach (['a', 'b', 'c'] as $suffix) {
    $users[$suffix] = User::query()->updateOrCreate(
        ['email' => "live-{$suffix}@example.test"],
        [
            'name' => 'Live User '.strtoupper($suffix),
            'password' => $password,
            'last_visited_url' => null,
        ],
    );
}

$vault = app(CreateVault::class)->handle($users['a'], [
    'name' => 'Live Collaboration E2E '.date('Ymd-His'),
]);

$vault->collaborators()->syncWithoutDetaching([
    $users['b']->id => ['accepted' => 1],
    $users['c']->id => ['accepted' => 1],
]);

$notes = [];

$notes['sync'] = app(CreateVaultNode::class)->handle($vault, [
    'is_file' => true,
    'name' => 'Live Sync',
    'extension' => 'md',
    'content' => "# Live Sync\n\nAlpha paragraph.\n\nBeta paragraph.\n\n- one\n- two\n",
]);

$notes['empty'] = app(CreateVaultNode::class)->handle($vault, [
    'is_file' => true,
    'name' => 'Live Empty',
    'extension' => 'md',
    'content' => '',
]);

$notes['fidelity'] = app(CreateVaultNode::class)->handle($vault, [
    'is_file' => true,
    'name' => 'Live Fidelity',
    'extension' => 'md',
    'content' => "# Fidelity\n\nA paragraph with **bold**, *italic* and `code`.\n\n- item one\n- item two\n\n1. ordered one\n2. ordered two\n\n- [ ] open task\n- [x] done task\n\n> A quote.\n\n```js\nconst answer = 42;\n```\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\n[Example](https://example.com)\n",
]);

$notes['table'] = app(CreateVaultNode::class)->handle($vault, [
    'is_file' => true,
    'name' => 'Live Table',
    'extension' => 'md',
    'content' => "# Table Test\n\nGiven Definition appears in this paragraph.\n\n|   **Given Definition**   |   **Expression**   |   **Has Type**   |\n| --- | --- | --- |\n| ACTION(Foo) | Foo() | FooAction |\n| `ACTION_P(Bar, param)` | `Bar(int_value)` | `BarActionP<int>` |\n",
]);

$notes['duplicates'] = app(CreateVaultNode::class)->handle($vault, [
    'is_file' => true,
    'name' => 'Live Duplicate Tables',
    'extension' => 'md',
    'content' => "# Duplicate Tables\n\n| **Given Definition** | **Expression** | **Has Type** |\n| --- | --- | --- |\n| A1 | B1 | C1 |\n\n| **Given Definition** | **Expression** | **Has Type** |\n| --- | --- | --- |\n| A2 | B2 | C2 |\n",
]);

$notes['words'] = app(CreateVaultNode::class)->handle($vault, [
    'is_file' => true,
    'name' => 'Live Repeated Words',
    'extension' => 'md',
    'content' => "| **Same** | **Same** | **Type** | **Type** |\n| --- | --- | --- | --- |\n| one | two | three | four |\n",
]);

$long = "# Long\n\n";

for ($i = 1; $i <= 120; $i++) {
    $long .= "Paragraph {$i}: The quick brown fox jumps over the lazy dog.\n\n";
}

$notes['long'] = app(CreateVaultNode::class)->handle($vault, [
    'is_file' => true,
    'name' => 'Live Long',
    'extension' => 'md',
    'content' => $long,
]);

echo json_encode([
    'vault_id' => $vault->id,
    'users' => [
        'a' => $users['a']->email,
        'b' => $users['b']->email,
        'c' => $users['c']->email,
    ],
    'notes' => array_map(static fn ($note): int => $note->id, $notes),
], JSON_THROW_ON_ERROR).PHP_EOL;
