<?php

declare(strict_types=1);

namespace App\Http\Requests;

use Illuminate\Foundation\Http\FormRequest;

final class StoreVaultNodeSnapshotRequest extends FormRequest
{
    protected function prepareForValidation(): void
    {
        // Laravel's ConvertEmptyStringsToNull middleware turns an empty
        // Markdown snapshot into null before validation. Restore the empty
        // string so clearing a note remains a valid snapshot.
        if ($this->exists('content') && $this->input('content') === null) {
            $this->merge(['content' => '']);
        }
    }

    /** @return array<string, array<int, string>> */
    public function rules(): array
    {
        return [
            // `required` rejects the empty string, which is a valid way to
            // clear a note. `present` still requires the key to be sent.
            'content' => ['present', 'string', 'max:2000000'],
            'base_seq' => ['present', 'integer', 'min:0'],
        ];
    }
}
