---
name: update-free-models
description: Use when the user asks to update, sync, refresh, or verify the official OpenCode Zen free-model list in OCFreeRelay. Fetch the official model IDs and pricing, reconcile the baseline and scraper tests, run the repository checks, and optionally commit and push the change.
---

# Update Official Free Models

Keep OCFreeRelay's free-model allowlist synchronized with OpenCode Zen. The repository must expose only models that the current official source marks free.

## Sources

Use the authenticated official Zen model view as the authority for the current free set. The public sources are useful cross-checks, but they can lag behind the logged-in page or omit account-visible free models:

- Authenticated Zen model page: open the official OpenCode Zen page while signed in and inspect the models shown as free.
- Authenticated network response, if available: capture the JSON request made by that page and preserve the exact `id` field.
- Public model metadata: `https://opencode.ai/zen/v1/models`
- Public documentation/pricing: `https://opencode.ai/docs/zen`

Use this precedence order:

1. Authenticated Zen page or its authenticated model response.
2. Exact IDs from the public models endpoint.
3. Public documentation pricing tables for cross-checking only.

When the authenticated page and public documentation disagree, keep the authenticated page's free model and record the discrepancy. Do not remove a model solely because it is absent from the public page. A display name is not always convertible to an ID by lowercasing and replacing spaces with hyphens, so preserve the exact official ID from the authenticated response or the models endpoint.

## Workflow

### 1. Fetch and build the source set

1. Open the official Zen page while signed in. Capture the complete list of models that the page labels free, not only the public documentation table.
2. If the page loads model data through an API, inspect the browser network response and use its exact model IDs. If no response is available, map each displayed name through `https://opencode.ai/zen/v1/models`; if an ID is absent there, use the page's embedded link/data or stop and report the unresolved mapping rather than guessing.
3. Use the public documentation table to identify likely free rows, but treat it as a cross-check. It must not delete a model present in the authenticated page.
4. Build a source table with `display name`, `model id`, `free-status evidence`, and `observed-at` timestamp.
5. Include every model visible as free in the authenticated page, including models whose display name has no `Free` suffix. Exclude models that are only paid, low-cost, deprecated, or merely available.
6. Compare the resulting IDs with `KNOWN_FREE_MODELS`. Record every addition, removal, unchanged entry, and public/authenticated discrepancy before editing. The current authenticated list reported for this repository contains 10 IDs: `big-pickle`, `deepseek-v4-flash-free`, `hy3-free`, `laguna-s-2.1-free`, `mimo-v2.5-free`, `muse-spark-1.2`, `muse-spark-1.2-free`, `nemotron-3-ultra-free`, `nemotron-3.5-lightning-free`, and `x-preview-f-free`. Treat this list as a verification example, not a permanent source of truth.

Completion criterion: the complete authenticated free list is captured with exact IDs and timestamp, every baseline entry is accounted for, and each public/authenticated discrepancy is recorded rather than silently resolved.

### 2. Update the implementation

Edit only the files needed for this synchronization:

- `src/proxy/freeModels.ts`
  - Update `KNOWN_FREE_MODELS` to the complete current authenticated free set.
  - Keep IDs bare, without the `opencode/` provider prefix.
  - Add a small explicit alias in `MODEL_ID_ALIASES` when a display name cannot produce the official ID. Do not silently invent an ID from a display name when the official endpoint provides one.
  - Preserve the existing fallback behavior: cache and baseline remain available when the refresh source fails.
  - Treat the public HTML parser as a compatibility/checking path. The current default refresh URL is public and cannot be authoritative when it disagrees with the authenticated page; do not use that result to overwrite a newer authenticated baseline.
  - Leave `OCFREERELAY_AUTO_REFRESH_FREE_MODELS` unset unless the configured source has been reconciled with the authenticated page. The admin refresh endpoint returns `409` while this guard is off.
- `tests/free-models.test.ts`
  - Update the pricing fixture with every authenticated free row and at least one paid row.
  - Assert the exact sorted free-ID set.
  - Add normalization/alias coverage for every non-trivial display-name-to-ID mapping.
  - Update baseline count and representative allow/deny assertions.

Keep unrelated changes out of the patch. After each edit, reread the changed file and check that every test and `describe` block remains balanced.

Completion criterion: the baseline, parser behavior, aliases, fixture, and assertions describe the same exact authenticated free-ID set.

### 3. Verify locally

Run the repository's test and build commands from `package.json`:

```sh
npm test
npm run build
```

When the test wrapper emits an implausibly short or ambiguous result, run Vitest directly so transform and collection errors are visible:

```sh
npx vitest run --reporter=verbose
```

Also inspect the final diff and status:

```sh
git diff --check
git diff -- src/proxy/freeModels.ts tests/free-models.test.ts skills/update-free-models/SKILL.md
git status --short
```

Completion criterion: all tests pass, TypeScript builds, `git diff --check` is clean, and the diff contains no stale model IDs, paid IDs, cache files, or unrelated edits.

### 4. Commit and push when requested

Do not commit or push unless the user requests it. Before committing, show or inspect the final diff and confirm only the intended files are staged. Use a concise commit message that names the official source synchronization, for example:

```sh
git add src/proxy/freeModels.ts tests/free-models.test.ts skills/update-free-models/SKILL.md
git commit -m "chore: sync free models from authenticated Zen view"
git push
```

After pushing, verify the branch and report the commit ID and remote update range. If the remote rejects the push or the branch has diverged, stop before rewriting history and report the exact error.

## Safety checks
- Treat the authenticated Zen page or its authenticated response as authoritative when it conflicts with public documentation.
- Never remove an authenticated free model merely because it is missing from the public models endpoint or public pricing page.
- Never add a model solely because it appears in the models endpoint; confirm it is marked free in the authenticated page.
- Never replace an explicit official model ID with a guessed normalized display name.
- Keep the baseline non-empty as a last-resort startup fallback, and reject paid models in the registry tests.
