<?php

declare(strict_types=1);

namespace App\Http\Requests;

use Illuminate\Foundation\Http\FormRequest;

final class StoreVaultNodeSnapshotRequest extends FormRequest
{
    /** @return array<string, array<int, string>> */
    public function rules(): array
    {
        return [
            'content' => ['required', 'string', 'max:2000000'],
            'base_seq' => ['required', 'integer', 'min:0'],
        ];
    }
}
