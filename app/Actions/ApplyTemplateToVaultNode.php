<?php

declare(strict_types=1);

namespace App\Actions;

use App\Models\VaultNode;

/**
 * Renders a template against the current note content.
 *
 * The rendered Markdown is returned to the editor instead of being written to
 * the database directly: a live note is sourced from Yjs, so writing around
 * the collaboration document would create a second source of truth.
 */
final readonly class ApplyTemplateToVaultNode
{
    public function handle(VaultNode $template, VaultNode $node): string
    {
        return $this->render($template, (string) $node->content);
    }

    public function render(VaultNode $template, string $currentContent): string
    {
        $now = now();

        $content = str_replace(
            ['{{date}}', '{{time}}'],
            [$now->format('Y-m-d'), $now->format('H:i')],
            (string) $template->content,
        );

        return str_contains($content, '{{content}}')
            ? str_replace('{{content}}', $currentContent, $content)
            : $content . PHP_EOL . $currentContent;
    }
}
