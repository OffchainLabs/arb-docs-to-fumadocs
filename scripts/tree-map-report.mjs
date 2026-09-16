/**
 * tree-map-report — coverage of the legacy-tree -> this-tree migration map.
 *
 * Usage:
 *   pnpm tree:map                    # human report on stderr; exits 1 on a collision
 *   pnpm tree:map --json             # the full map as JSON on stdout
 *   pnpm tree:map --tree-a <path>    # override the legacy repo location
 *   pnpm tree:map --legacy-ref <ref> # read the legacy side from a git tree, not a directory
 *   pnpm tree:map --dest-ref <ref>   # read the destination side from a git tree, not cwd
 *
 * `--tree-a` is the legacy *repo root*, not its `docs/` directory as in `pnpm drift`: the map spans
 * `docs/**` and `static/img/**`, so it needs the tree above both.
 *
 * The two `--*-ref` flags exist because the map is also built the other way round — inside the
 * arbitrum-docs repo, where the legacy tree is local `master` and the Fumadocs tree arrives as a
 * fetched ref, so neither side is a directory on disk. Both then read through `git ls-tree` /
 * `git cat-file`, which also keeps the map independent of checkout filters.
 *
 * A collision — two legacy files resolving to one destination — fails the run. The map is meant to
 * drive a `git mv` reconstruction, where a duplicate target loses a file instead of reporting one.
 * Fix a collision in lib/tree-compare.mjs: a RENAME_MAP entry when both legacy pages have their own
 * counterpart here, a NOT_MIGRATED entry when the port merged one into the other.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { TreeMapCollisionError, buildMigrationMap } from './lib/tree-compare.mjs';

const DEFAULT_TREE_A =
  '/Users/allup/OCL/docusaurus-fumadocs-migration-playground/docs-migration-source';

/** Legacy subtrees the map covers, and the destination subtrees they land in. */
const LEGACY_ROOTS = ['docs', path.join('static', 'img')];
const DEST_ROOTS = [
  path.join('content', 'docs'),
  path.join('content', 'glossary'),
  path.join('content', 'partials'),
  path.join('public', 'img'),
  path.join('public', 'audit-reports'),
];

/** Every file under `roots`, as posix paths relative to `base`. Missing roots are skipped. */
function listFiles(base, roots) {
  const out = [];
  const walk = (abs) => {
    for (const d of readdirSync(abs, { withFileTypes: true })) {
      const next = path.join(abs, d.name);
      if (d.isDirectory()) walk(next);
      else out.push(path.relative(base, next).split(path.sep).join('/'));
    }
  };
  for (const root of roots) {
    const abs = path.join(base, root);
    if (existsSync(abs)) walk(abs);
  }
  return out.sort();
}

/** Every file in a git tree, as posix paths, restricted to `roots`. */
function listTreeFiles(ref, roots) {
  const out = execFileSync(
    'git',
    ['ls-tree', '-r', '-z', '--name-only', ref, '--', ...roots.map((r) => posix(r))],
    { encoding: 'utf8', maxBuffer: 1 << 29 },
  );
  return out.split('\0').filter(Boolean).sort();
}

/** One file's text out of a git tree. Never touches the working tree, so no filters run. */
function readTreeFile(ref, rel) {
  return execFileSync('git', ['cat-file', 'blob', `${ref}:${rel}`], {
    encoding: 'utf8',
    maxBuffer: 1 << 28,
  });
}

function posix(p) {
  return p.split(path.sep).join('/');
}

/** Group paths by their directory, for a report that reads by area rather than by file. */
function groupByDir(paths) {
  const groups = new Map();
  for (const p of paths) {
    const dir = p.split('/').slice(0, -1).join('/');
    if (!groups.has(dir)) groups.set(dir, []);
    groups.get(dir).push(p);
  }
  return [...groups].sort(([a], [b]) => a.localeCompare(b));
}

function report(result, collisions) {
  const byKind = new Map();
  for (const e of result.entries) {
    const stats = byKind.get(e.kind) ?? { total: 0, mapped: 0 };
    stats.total++;
    if (e.dest) stats.mapped++;
    byKind.set(e.kind, stats);
  }

  // `drop` files are deliberately not carried over, so they count against neither side of the ratio.
  const carried = result.entries.filter((e) => e.kind !== 'drop');
  const mapped = carried.filter((e) => e.dest).length;
  const pct = (n, d) => (d === 0 ? '—' : `${((n / d) * 100).toFixed(1)}%`);

  console.error(
    `tree-map: ${mapped}/${carried.length} legacy files mapped (${pct(mapped, carried.length)}), ` +
      `${result.entries.length - carried.length} dropped\n`,
  );
  for (const [kind, s] of [...byKind].sort(([a], [b]) => a.localeCompare(b))) {
    const ratio =
      kind === 'drop'
        ? `${String(s.total).padStart(4)}     `
        : `${String(s.mapped).padStart(4)}/${String(s.total).padEnd(5)}`;
    console.error(`  ${kind.padEnd(9)} ${ratio} ${kind === 'drop' ? '' : pct(s.mapped, s.total)}`);
  }

  console.error(`\ncollisions: ${collisions.length}`);
  for (const c of collisions) {
    console.error(`  ${c.dest}`);
    for (const s of c.sources) console.error(`    <- ${s}`);
  }

  const unmapped = result.entries.filter((e) => !e.dest && e.kind !== 'drop');
  console.error(`\nunmapped: ${unmapped.length}`);
  for (const [dir, paths] of groupByDir(unmapped.map((e) => e.legacy))) {
    console.error(`  ${dir || '.'}  (${paths.length})`);
    for (const p of paths) {
      const e = unmapped.find((x) => x.legacy === p);
      console.error(`    ${p.split('/').pop()}  — ${e.reason}`);
    }
  }

  console.error(`\norphans (here with no legacy origin): ${result.orphans.length}`);
  for (const [dir, paths] of groupByDir(result.orphans)) {
    console.error(`  ${dir}  (${paths.length})`);
    for (const p of paths) console.error(`    ${p.split('/').pop()}`);
  }
}

function flag(argv, name) {
  const i = argv.indexOf(name);
  return i !== -1 ? argv[i + 1] : null;
}

function main() {
  const argv = process.argv.slice(2);
  const json = argv.includes('--json');
  const legacyRef = flag(argv, '--legacy-ref');
  const destRef = flag(argv, '--dest-ref');
  const treeA = flag(argv, '--tree-a') ?? DEFAULT_TREE_A;

  if (!legacyRef && (!treeA || !existsSync(treeA))) {
    console.error(`tree-map: legacy repo not found at ${treeA}. Pass --tree-a <path>.`);
    process.exitCode = 1;
    return;
  }

  const repoRoot = process.cwd();
  const input = {
    legacyFiles: legacyRef
      ? listTreeFiles(legacyRef, LEGACY_ROOTS)
      : listFiles(treeA, LEGACY_ROOTS),
    destFiles: destRef ? listTreeFiles(destRef, DEST_ROOTS) : listFiles(repoRoot, DEST_ROOTS),
    readSource: (rel) =>
      legacyRef ? readTreeFile(legacyRef, rel) : readFileSync(path.join(treeA, rel), 'utf8'),
  };

  let result;
  let collisions = [];
  try {
    result = buildMigrationMap(input);
  } catch (err) {
    if (!(err instanceof TreeMapCollisionError)) throw err;
    result = err.result;
    collisions = err.collisions;
  }

  if (json) {
    console.log(
      JSON.stringify({ entries: result.entries, collisions, orphans: result.orphans }, null, 2),
    );
  } else {
    report(result, collisions);
  }

  if (collisions.length) process.exitCode = 1;
}

main();
