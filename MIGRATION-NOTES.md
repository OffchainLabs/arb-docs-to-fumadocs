# Landing the Fumadocs tree on arbitrum-docs, without destroying git blame

> **What this repo is.** A throwaway demonstration. `master` is an untouched clone of
> `OffchainLabs/arbitrum-docs` @ `6a2738fba`. The `fumadocs` branch is the proposed migration: the
> Fumadocs tree landed on top of that history in a way that keeps `git blame` working back to 2022.
>
> Measured 2026-09-15. Nothing here is production.

## The one-sentence finding

**Move files in their own commit, with no content change.** Doing the move and the content rewrite in
a single commit destroys four years of authorship; splitting them preserves **72.73%** of it.

## Why this matters now

An earlier attempt imported the docs into a fresh Fumadocs repo with `git init`, then added content
across ten "wave" commits. Git had no predecessor to trace to, so all 431 content files were recorded
as **additions**. Blame on every page showed a single 2026 import commit. Authorship from 2022–2026 was
invisible.

That is not recoverable after the fact cheaply, and it is a decision made exactly once — at import.
Getting it wrong on `arbitrum-docs` itself would destroy blame on the production repo permanently.

Squash-merging was investigated and **cleared** — it is not the cause. 516 renames are correctly
detected inside the Fumadocs repo's own history, and its restructure commits show 19 renames vs 2 adds.
The loss happens only at the import boundary.

## How it works

Git does not store renames; it infers them per commit. Crucially, **exact renames are matched in a
hash-equality pass that runs before the similarity pass** — so a byte-identical move is detected with
certainty, and `diff.renameLimit` never applies. Tuning rename limits is not the lever. Commit
structure is.

The `fumadocs` branch (`b60b802c`), parented to `master`:

| # | Commit | Contents |
|---|---|---|
| S | `1f7766c6` | Fumadocs/Next.js scaffold. Creates **nothing** under `content/`, so M's diff is unambiguously rename-only. |
| **M** | **`8d3af5a6`** | **The move. 591 files, 0 insertions, 0 deletions, every entry `R100`.** |
| D | `7e657a20` | Remove the Docusaurus scaffold. After M, so rename sources are not orphaned. |
| T1–T5 | `874d3106`…`1e3bff94` | One commit per mechanical transform: frontmatter schema, internal links, `<Term>`, admonitions, includes + `@@vars@@`. |
| E | `0c815ff2` | Editorial delta. Forces the tree to equal the Fumadocs tree exactly. |
| G | `b60b802c` | `.git-blame-ignore-revs` listing T1–T5. |

Build M with plumbing, never through a checkout — round-tripping a blob runs CRLF conversion and
clean/smudge filters, the OID changes, exact-rename matching fails, and the whole exercise silently
produces nothing:

```bash
git read-tree <parent>
git update-index --index-info   # mode<TAB>oid<TAB>stage<TAB>newpath, reusing the ORIGINAL blob OID
git commit-tree ...
```

Neither repo has a `.gitattributes`; the Fumadocs repo *does* carry an active LFS filter matching no
path. **Do not add a `.gitattributes` before the move commit.**

## Verify it yourself

```bash
git clone git@github.com:OffchainLabs/arb-docs-to-fumadocs.git && cd arb-docs-to-fumadocs
git config blame.ignoreRevsFile .git-blame-ignore-revs   # needed for the ignore file to apply
git switch fumadocs

# blame reaches 2022, through the migration AND arbitrum-docs' own earlier reorganisations
git log --follow --format='%ad %an %s' --date=short -- content/docs/arbitrum-bridge/quickstart.mdx | tail -5

# the move commit is byte-pure: prints only "-  -" and "0  0"
git show --numstat --format= -M100% 8d3af5a6 | cut -f1,2 | sort -u
```

| Gate | Result |
|---|---|
| `master` is a true ancestor | ✅ 13,048 commits (13,038 + 10) |
| Move commit purity | ✅ 591 files, 0 insertions, 0 deletions, all `R100` |
| Blob identity (10 sampled) | ✅ 10/10 identical OIDs |
| Tree equality vs shipped Fumadocs tree | ✅ exact OID `900cf046`; tip differs by `.git-blame-ignore-revs` alone |
| Blame traversal | ✅ 92 commits, oldest 2022-12-07, 11 authors |
| **SRC authorship, full population** | **72.73%** plain · **75.28%** with ignore-revs · **0%** before |

Measured over all 61,416 lines of all 339 content pages — not a sample. Produced twice by independent
builds in two repositories, agreeing to within 0.16 points.

Rename chains run deeper than the migration itself:

```
R100  docs/arbitrum-bridge/01-quickstart.mdx          → content/docs/arbitrum-bridge/quickstart.mdx
R100  arbitrum-docs/arbitrum-bridge/01-quickstart.mdx → docs/…
R091  arbitrum-docs/getting-started-users.mdx         → arbitrum-docs/arbitrum-bridge/01-quickstart.md
```

## Three results that are easy to get wrong

### Do not make the editorial commit a merge

The obvious way to *also* keep the Fumadocs repo's own 211 commits is to give `E` two parents,
`[T5, fumadocs-main]`, with the same tree. This was tested:

| `E` shape | SRC authorship |
|---|---|
| Linear, single parent | **72.73%** |
| Merge commit, two parents | **21.97%** |

Blame prefers the parent whose tree matches; the Fumadocs side matches exactly, so blame never walks
into the legacy history at all. A two-thirds loss from a change that looks free. **Keep `E` linear.**

### `.git-blame-ignore-revs` is a finishing touch, not the mechanism

It contributes **+2.55 points**, not a step change. The move commit does essentially all the work.
Most of the migration's line churn is editorial rather than dialectal — of the 591 mapped files, the
editorial commit had to correct 280 (47.4%) — and editorial change correctly lands in the commit blame
does *not* skip.

**The purity rule: ignore commits that changed form, never substance.** In the current build `T1`
violates this — it inserts `author: gblanchemain` / `sme:` on every page to satisfy the Zod schema,
which asserts a person. Because `T1` is ignored, those lines blame through to a real arbitrum-docs
author who never wrote them. **Fix before the real run:** split into `T1a` (pure reshaping, stays
ignored) and `T1b` (synthesises author/sme, excluded).

### A signed commit can never be SHA-stable

Commits here are GPG-signed, and the signature nonce changes on every rebuild. Any tooling that
re-runs must key idempotency on the **tree OID**, never the commit SHA. A single run looks perfectly
correct; only a re-run exposes it.

## What this does to the 23 open PRs

Every open PR was merged for real against `fumadocs` with `git merge-tree`, using `master` as a control.

**0 rebaseable · 10 needs-remap · 13 re-author.** All 23 conflict against `fumadocs`; only 11 conflict
against `master`, so the restructure causes the other twelve.

Rename detection does most of the work — of 121 touched-file/moved-path pairs, 86 followed the rename
to the correct destination and conflicted only on content. The damage is not the move; it is that the
transforms and the editorial commit touch the same lines the PRs touch.

**The dead-tree hazard, stated accurately.** A PR adding files under `docs/**` is adding to a directory
that no longer exists. Git's directory-rename detection handles most of this correctly — PR #3500's new
page landed at `content/docs/launch-arbitrum-chain/deploy/yield-bridge.mdx` with zero `docs/` entries,
and 448 of #3573's files landed correctly. But a residue does not: 9 files in #3573 and #3569 land in a
resurrected `docs/` tree Fumadocs never reads, and would merge and be silently unpublished.

This is **detectable, not silent** — git names the correct destination:

```
CONFLICT (file location): docs/run-arbitrum-node/data-availability.mdx renamed to
docs/how-arbitrum-works/deep-dives/data-availability.mdx in pr3573, inside a directory that was
renamed in fumadocs, suggesting it should perhaps be moved to
content/docs/how-arbitrum-works/deep-dives/data-availability.mdx.
```

The risk is automation that ignores merge messages. Any rebase tooling must parse
`CONFLICT (file location)`, and the landing must be gated on **zero files under `docs/` or `static/`
after any merge**.

Caveats: four PRs (#2644, #3287, #2954, #3497) are already broken against today's `master` independent
of the landing. #3563/#3564/#3567 stack on other PRs rather than targeting `master`, so their control
column is not meaningful. And `merge-tree` reports textual conflicts only — a `needs-remap` PR can
still be semantically broken (missing required frontmatter, surviving `:::` admonitions). Treat
`needs-remap` as a floor.

## The gap that grows every day

`master` has moved on since the Fumadocs snapshot was taken. 14 pages, 22 glossary terms, 14 assets and
1 partial exist on `master` with nowhere to land, and lose their blame chain entirely — including
`arbos-releases/arbos61.mdx`, `chain-config/costs/priority-fees.mdx` and
`extend-the-protocol/precompiles.mdx`. Where a successor page exists it arrives via `E` with zero
history: `da-api-integration-guide.mdx` lands as 1,966 lines at 0% attribution.

Path map coverage is 591/642 (92.1%) with zero collisions — a `git mv` map must be injective, so a
duplicate destination is a correctness bug, not a coverage gap. `pnpm tree:map` reports coverage,
collisions and orphans, and exits non-zero on any collision.

**This gap widens until cutover** — the strongest argument for re-syncing the Fumadocs tree against
`master` immediately before landing.

## Recommended sequence

1. **Re-sync the Fumadocs tree against `master`** so the no-destination set is as small as possible.
2. **Split `T1`** so no blame-ignored commit asserts a fact, then rebuild.
3. **Build off `master`, keep `E` linear**, and gate on move purity, tree equality, and the blame
   percentage.
4. **Rebase open PRs with tooling that reads `CONFLICT (file location)`**, gated on zero files landing
   under `docs/` or `static/`.
5. **Promote to default at cutover.** Until then open PRs keep targeting `master` and stay mergeable,
   and the branch gets a real preview of the whole site.

## Known limitations

- **GitHub's web blame does not follow renames.** Crossing the rename boundary on github.com is a
  click-through per file ("View blame prior to this change"). The CLI and editor integrations do follow
  it, and GitHub *does* honour `.git-blame-ignore-revs`. File history on GitHub also follows renames.
- **Repo size** ≈ 690–710 MiB after `gc` — there are no shared blobs between the two trees. Prefer
  `--filter=blob:none` in CI over `git filter-repo`, which would rewrite every SHA and destroy the
  correspondence to arbitrum-docs that makes the blame meaningful.
- **The bare-slug fallback in the path map can mispair** when a slug is unique but the semantic target
  is elsewhere. A silent mismap survives every gate, so synthesized destinations need human review.
