<?php

declare(strict_types=1);

use App\Actions\CreateVault;
use App\Actions\CreateVaultNode;
use App\Actions\UpdateVaultNode;
use App\Events\VaultNodeLinksRewrittenEvent;
use App\Events\VaultNodeSnapshotUpdatedEvent;
use App\Events\VaultNodeUpdatedEvent;
use App\Events\VaultOpenedFileDataUpdatedEvent;
use App\Models\CollaborationDocument;
use App\Models\User;
use App\Models\Vault;
use App\Services\YjsTokenService;
use Illuminate\Support\Facades\Event;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Storage;

beforeEach(function (): void {
    config()->set('yjs.enabled', true);
    config()->set('yjs.jwt_secret', str_repeat('test-secret-', 4));
    config()->set('yjs.jwt_issuer', 'many-notes');
    config()->set('yjs.jwt_audience', 'many-notes-yjs');
    config()->set('yjs.token_ttl', 300);
    config()->set('yjs.internal_url', '');
    config()->set('yjs.internal_token', 'test-internal-token');
});

it('does not issue tokens when collaboration is disabled', function (): void {
    config()->set('yjs.enabled', false);

    $user = User::factory()->create();
    [$vault, $note] = collaborativeNote($user);

    $this->actingAs($user)
        ->postJson(route('yjs.token'), ['vault_id' => $vault->id, 'node_id' => $note->id])
        ->assertServiceUnavailable();
});

it('issues a token to the owner', function (): void {
    $user = User::factory()->create();
    [$vault, $note] = collaborativeNote($user);

    $response = $this->actingAs($user)->postJson(route('yjs.token'), [
        'vault_id' => $vault->id,
        'node_id' => $note->id,
    ]);

    $response
        ->assertOk()
        ->assertJsonPath('room', "vault:{$vault->id}:node:{$note->id}")
        ->assertJsonPath('can_edit', true)
        ->assertJsonPath('snapshot_seq', 0);

    $claims = app(YjsTokenService::class)->verify((string) $response->json('token'));

    expect($claims)->not->toBeNull()
        ->and($claims['sub'])->toBe((string) $user->id)
        ->and($claims['vault_id'])->toBe($vault->id)
        ->and($claims['node_id'])->toBe($note->id)
        ->and($claims['room'])->toBe("vault:{$vault->id}:node:{$note->id}")
        ->and($claims['can_edit'])->toBeTrue();
});

it('issues a token to an accepted collaborator', function (): void {
    [$owner, $collaborator] = User::factory(2)->create();
    [$vault, $note] = collaborativeNote($owner);
    $vault->collaborators()->attach($collaborator, ['accepted' => 1]);

    $this->actingAs($collaborator)
        ->postJson(route('yjs.token'), ['vault_id' => $vault->id, 'node_id' => $note->id])
        ->assertOk();
});

it('does not issue a token to a non-collaborator', function (): void {
    [$owner, $stranger] = User::factory(2)->create();
    [$vault, $note] = collaborativeNote($owner);

    $this->actingAs($stranger)
        ->postJson(route('yjs.token'), ['vault_id' => $vault->id, 'node_id' => $note->id])
        ->assertForbidden();
});

it('does not allow cross-vault note access', function (): void {
    [$userA, $userB] = User::factory(2)->create();
    [$vaultA] = collaborativeNote($userA);
    [$vaultB, $noteB] = collaborativeNote($userB);

    // Same vault id, note id from another vault.
    $this->actingAs($userA)
        ->postJson(route('yjs.token'), ['vault_id' => $vaultA->id, 'node_id' => $noteB->id])
        ->assertNotFound();

    // Another vault id with its valid note.
    $this->actingAs($userA)
        ->postJson(route('yjs.token'), ['vault_id' => $vaultB->id, 'node_id' => $noteB->id])
        ->assertForbidden();
});

it('does not issue a token for folders or non-markdown files', function (mixed $extension): void {
    $user = User::factory()->create();
    $vault = app(CreateVault::class)->handle($user, ['name' => fake()->words(3, true)]);
    $node = app(CreateVaultNode::class)->handle($vault, [
        'is_file' => $extension !== null,
        'name' => 'node',
        'extension' => $extension,
    ]);

    $this->actingAs($user)
        ->postJson(route('yjs.token'), ['vault_id' => $vault->id, 'node_id' => $node->id])
        ->assertNotFound();
})->with([
    'folder' => [null],
    'pdf' => ['pdf'],
    'image' => ['png'],
    'plain text' => ['txt'],
]);

it('rejects an expired token', function (): void {
    $user = User::factory()->create();
    [$vault, $note] = collaborativeNote($user);

    config()->set('yjs.token_ttl', -10);

    $response = $this->actingAs($user)->postJson(route('yjs.token'), [
        'vault_id' => $vault->id,
        'node_id' => $note->id,
    ]);

    $response->assertOk();

    expect(app(YjsTokenService::class)->verify((string) $response->json('token')))->toBeNull();
});

it('claims a seed only once', function (): void {
    $user = User::factory()->create();
    [$vault, $note] = collaborativeNote($user, 'Old Markdown content');
    $payload = ['vault_id' => $vault->id, 'node_id' => $note->id];

    $first = $this->actingAs($user)->postJson(route('yjs.seed.claim'), $payload);
    $first->assertOk()->assertJsonPath('claimed', true);

    $claimId = (string) $first->json('claim_id');
    expect($claimId)->not->toBe('');

    $this->actingAs($user)->postJson(route('yjs.seed.claim'), $payload)
        ->assertOk()
        ->assertJsonPath('claimed', false);

    $this->actingAs($user)->postJson(route('yjs.seed.complete'), [
        ...$payload,
        'claim_id' => $claimId,
    ])->assertOk()->assertJsonPath('completed', true);

    expect(CollaborationDocument::query()->firstOrFail()->seeded_at)->not->toBeNull();

    $this->actingAs($user)->postJson(route('yjs.seed.claim'), $payload)
        ->assertOk()
        ->assertJsonPath('claimed', false);
});

it('rejects legacy full-document content writes for a live note', function (): void {
    $user = User::factory()->create();
    [$vault, $note] = collaborativeNote($user, 'Yjs content');

    $this->actingAs($user)
        ->patchJson(
            route('vaults.nodes.update', ['vault' => $vault->id, 'node' => $note->id]),
            ['content' => 'Legacy overwrite'],
        )
        ->assertStatus(409);

    expect($note->refresh()->content)->toBe('Yjs content');
});

it('stores a snapshot and rejects a stale one', function (): void {
    $user = User::factory()->create();
    [$vault, $note] = collaborativeNote($user, 'Old');
    $url = route('api.vaults.nodes.snapshot', ['vault' => $vault->id, 'node' => $note->id]);

    $this->actingAs($user)
        ->patchJson($url, ['content' => '# New', 'base_seq' => 0])
        ->assertOk()
        ->assertJsonPath('data.snapshot_seq', 1);

    expect($note->refresh()->content)->toBe('# New');
    expect(Storage::disk('local')->get(app(App\Actions\GetPathFromVaultNode::class)->handle($note)))
        ->toBe('# New');

    // A duplicate materialization of the same merged Yjs state is a no-op.
    $this->actingAs($user)
        ->patchJson($url, ['content' => '# New', 'base_seq' => 0])
        ->assertOk()
        ->assertJsonPath('data.snapshot_seq', 1);

    $this->actingAs($user)
        ->patchJson($url, ['content' => 'Older write', 'base_seq' => 0])
        ->assertStatus(409)
        ->assertJsonPath('snapshot_seq', 1);

    expect($note->refresh()->content)->toBe('# New');
});

it('does not broadcast snapshot content', function (): void {
    Event::fake([VaultNodeUpdatedEvent::class, VaultNodeSnapshotUpdatedEvent::class]);

    $user = User::factory()->create();
    [$vault, $note] = collaborativeNote($user, 'Old');

    $this->actingAs($user)->patchJson(
        route('api.vaults.nodes.snapshot', ['vault' => $vault->id, 'node' => $note->id]),
        ['content' => '# New', 'base_seq' => 0],
    )->assertOk();

    Event::assertNotDispatched(VaultNodeUpdatedEvent::class);
    Event::assertDispatched(
        VaultNodeSnapshotUpdatedEvent::class,
        fn(VaultNodeSnapshotUpdatedEvent $event): bool => $event->broadcastWith()['data']['node_id'] === $note->id
            && $event->broadcastWith()['data']['snapshot_seq'] === 1,
    );
});

it('does not include note content in snapshot metadata events', function (): void {
    Event::fake([VaultOpenedFileDataUpdatedEvent::class]);

    $user = User::factory()->create();
    [$vault, $note] = collaborativeNote($user, 'Old');
    app(CreateVaultNode::class)->handle($vault, [
        'is_file' => true,
        'name' => 'target',
        'extension' => 'md',
        'content' => 'Target',
    ]);

    $this->actingAs($user)->patchJson(
        route('api.vaults.nodes.snapshot', ['vault' => $vault->id, 'node' => $note->id]),
        ['content' => "#tag\n\n[target](/target.md)", 'base_seq' => 0],
    )->assertOk();

    Event::assertDispatched(
        VaultOpenedFileDataUpdatedEvent::class,
        fn(VaultOpenedFileDataUpdatedEvent $event): bool => $event->broadcastWith()['data']['file']->content === null,
    );
});

it('broadcasts a metadata-only link rewrite when a target is renamed', function (): void {
    Event::fake([VaultNodeLinksRewrittenEvent::class]);

    $user = User::factory()->create();
    [$vault, $target] = collaborativeNote($user, 'Target');
    $target->update(['name' => 'target']);
    $source = app(CreateVaultNode::class)->handle($vault, [
        'is_file' => true,
        'name' => 'source',
        'extension' => 'md',
        'content' => 'See [target](/target.md).',
    ]);

    app(UpdateVaultNode::class)->handle($target, ['name' => 'renamed']);

    Event::assertDispatched(
        VaultNodeLinksRewrittenEvent::class,
        fn(VaultNodeLinksRewrittenEvent $event): bool => $event->broadcastWith()['data'] === [
            'node_id' => $source->id,
            'original_path' => 'target',
            'replacement_path' => 'renamed',
            'extension' => 'md',
        ],
    );
});

it('rejects a snapshot from a user without access', function (): void {
    [$owner, $stranger] = User::factory(2)->create();
    [$vault, $note] = collaborativeNote($owner);

    $this->actingAs($stranger)
        ->patchJson(
            route('api.vaults.nodes.snapshot', ['vault' => $vault->id, 'node' => $note->id]),
            ['content' => 'Nope', 'base_seq' => 0],
        )
        ->assertForbidden();
});

it('revokes live Yjs access when a collaborator is removed', function (): void {
    config()->set('yjs.internal_url', 'http://yjs.test');
    config()->set('yjs.internal_token', 'internal-service-token');
    Http::fake(['http://yjs.test/internal/revoke' => Http::response(['revoked' => 1])]);

    [$owner, $collaborator] = User::factory(2)->create();
    $vault = app(CreateVault::class)->handle($owner, ['name' => fake()->words(3, true)]);
    $vault->collaborators()->attach($collaborator, ['accepted' => 1]);

    $this->actingAs($owner)
        ->delete(route('vaults.collaborations.destroy', ['vault' => $vault->id, 'user' => $collaborator->id]))
        ->assertOk();

    Http::assertSent(fn($request): bool => $request->url() === 'http://yjs.test/internal/revoke'
        && $request->hasHeader('X-Internal-Token', 'internal-service-token')
        && $request['vault_id'] === $vault->id
        && $request['user_id'] === $collaborator->id);
});

it('updates links and tags through a snapshot', function (): void {
    $user = User::factory()->create();
    [$vault, $note] = collaborativeNote($user, 'Old');
    app(CreateVaultNode::class)->handle($vault, [
        'is_file' => true,
        'name' => 'target',
        'extension' => 'md',
        'content' => 'Target',
    ]);

    $this->actingAs($user)->patchJson(
        route('api.vaults.nodes.snapshot', ['vault' => $vault->id, 'node' => $note->id]),
        ['content' => "#tagged\n\n[target](/target.md)", 'base_seq' => 0],
    )->assertOk();

    expect($note->refresh()->tags()->count())->toBe(1)
        ->and($note->links()->count())->toBe(1);
});

it('exports the current snapshot', function (): void {
    $user = User::factory()->create();
    [$vault, $note] = collaborativeNote($user, 'Old');

    $this->actingAs($user)->patchJson(
        route('api.vaults.nodes.snapshot', ['vault' => $vault->id, 'node' => $note->id]),
        ['content' => '# Exported content', 'base_seq' => 0],
    )->assertOk();

    $response = $this->get(route('vaults.export', ['vault' => $vault->id]));
    $response->assertOk();

    $path = tempnam(sys_get_temp_dir(), 'many-notes-export-');
    file_put_contents($path, $response->streamedContent());

    $zip = new ZipArchive();
    $zip->open($path);
    $content = $zip->getFromName('note.md');
    $zip->close();
    @unlink($path);

    expect($content)->toBe('# Exported content');
});

it('exposes snapshot text to the search index payload', function (): void {
    $user = User::factory()->create();
    [$vault, $note] = collaborativeNote($user, 'Old');
    $phrase = 'snapshot-search-' . fake()->uuid();

    $this->actingAs($user)->patchJson(
        route('api.vaults.nodes.snapshot', ['vault' => $vault->id, 'node' => $note->id]),
        ['content' => "# Notes\n\n{$phrase}", 'base_seq' => 0],
    )->assertOk();

    expect($note->refresh()->toSearchableArray()['content'])->toContain($phrase);
});

it('renders a template without writing the note directly', function (): void {
    $user = User::factory()->create();
    $vault = app(CreateVault::class)->handle($user, ['name' => fake()->words(3, true)]);
    $templates = app(CreateVaultNode::class)->handle($vault, [
        'is_file' => false,
        'name' => 'Templates',
    ]);
    $vault->update(['templates_node_id' => $templates->id]);
    $template = app(CreateVaultNode::class)->handle($vault, [
        'parent_id' => $templates->id,
        'is_file' => true,
        'name' => 'Basic',
        'extension' => 'md',
        'content' => "# {{date}}\n\n{{content}}",
    ]);
    $note = app(CreateVaultNode::class)->handle($vault, [
        'is_file' => true,
        'name' => 'note',
        'extension' => 'md',
        'content' => 'Existing body',
    ]);

    $response = $this->actingAs($user)->postJson(
        route('vaults.editor.templates.apply', [
            'vault' => $vault->id,
            'template' => $template->id,
        ]),
        [
            'node_id' => $note->id,
            'content' => 'Existing body',
        ],
    );

    $response->assertOk();
    expect($response->json('data.content'))->toContain('Existing body')
        ->and($note->refresh()->content)->toBe('Existing body');
});

it('rate limits token requests', function (): void {
    $user = User::factory()->create();
    [$vault, $note] = collaborativeNote($user);
    $payload = ['vault_id' => $vault->id, 'node_id' => $note->id];

    for ($attempt = 0; $attempt < 30; $attempt++) {
        $this->actingAs($user)->postJson(route('yjs.token'), $payload)->assertOk();
    }

    $this->actingAs($user)->postJson(route('yjs.token'), $payload)->assertStatus(429);
});
