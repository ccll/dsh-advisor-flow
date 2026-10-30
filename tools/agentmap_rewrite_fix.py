#!/usr/bin/env python3
"""Sync map-document commit-hash references after a history rewrite.

`git rebase`, `git commit --amend`, and `git filter-branch` invoke the
post-rewrite hook with `<old> <new>` pairs on stdin — git's own authoritative
mapping. This tool turns those pairs into same-moment replacements of the
unreachable hashes cited by the map documents, so evidence chains keep
resolving without a persistent rewrite ledger.

Usage:
  agentmap_rewrite_fix.py --apply   # read `<old> <new>` pairs from stdin, rewrite documents
  agentmap_rewrite_fix.py --check   # report unreachable hash references, no writes

Replacement scope (证据面): the `## 终态与证据` section of every tasks/*.md,
and the 累计审计复位点 line of CONVENTIONS.md. RATIONALE entries are left
untouched: they are append-only adjudication records, and a stale hash inside
a verdict reads as history rather than a broken gate. cherry-pick never
triggers post-rewrite, and the picked-from commit stays reachable on its
branch, so it needs no mapping; run --check before deleting shared branches.
"""

from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path

HEX_TOKEN_RE = re.compile(r"(?<![0-9a-fA-F])[0-9a-f]{7,40}(?![0-9a-fA-F])")
EVIDENCE_SECTION_RE = re.compile(r"^## 终态与证据\s*$[\s\S]*?(?=^##\s|\Z)", re.MULTILINE)
RESET_LINE_RE = re.compile(r"^-\s*累计审计复位点:.*$", re.MULTILINE)
PAIR_RE = re.compile(r"^([0-9a-f]{7,40})\s+([0-9a-f]{7,40})$")


def fail(message: str) -> int:
    print(f"rewrite-fix: {message}", file=sys.stderr)
    return 1


def read_pairs(text: str) -> list[tuple[str, str]]:
    """Parse post-rewrite stdin; blank lines and comments are ignored."""
    pairs: list[tuple[str, str]] = []
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        match = PAIR_RE.fullmatch(stripped)
        if not match:
            raise ValueError("post-rewrite stdin must carry one <old> <new> pair per line")
        pairs.append((match.group(1), match.group(2)))
    return pairs


def closure(pairs: list[tuple[str, str]]) -> dict[str, str]:
    """Follow old→new chains so repeated rewrites collapse to the final hash."""
    edge = dict(pairs)
    resolved: dict[str, str] = {}
    for old in edge:
        current = edge[old]
        seen = {old}
        while current in edge and current not in seen:
            seen.add(current)
            current = edge[current]
        if current != old:
            resolved[old] = current
    return resolved


def is_reachable(root: Path, value: str) -> bool:
    """Same notion as lint's resolves_to_reachable_commit: a HEAD ancestor."""
    rev = subprocess.run(
        ["git", "rev-parse", "--verify", "--quiet", f"{value}^{{commit}}"],
        cwd=root, check=False, capture_output=True, text=True,
    )
    if rev.returncode != 0 or not rev.stdout.strip():
        return False
    ancestor = subprocess.run(
        ["git", "merge-base", "--is-ancestor", rev.stdout.strip(), "HEAD"],
        cwd=root, check=False, capture_output=True,
    )
    return ancestor.returncode == 0


def unique_object(root: Path, prefix: str) -> list[str]:
    """All objects in the database sharing the prefix (empty when none)."""
    completed = subprocess.run(
        ["git", "rev-parse", "--disambiguate=" + prefix],
        cwd=root, check=False, capture_output=True, text=True,
    )
    if completed.returncode != 0:
        return []
    return [line.strip() for line in completed.stdout.splitlines() if line.strip()]


def build_targets(root: Path, mapping: dict[str, str]) -> tuple[dict[str, str], list[str]]:
    """Full-hash pairs are unambiguous; a cited prose prefix maps only when it
    names exactly one stored object (the rewritten-away commit, still present
    before gc). Anything else is ambiguous and reported, never guessed."""
    targets = dict(mapping)
    ambiguous: list[str] = []
    for old in mapping:
        candidates = unique_object(root, old[:12])
        if len(candidates) == 1 and candidates[0].lower() == old:
            targets[old[:12]] = mapping[old]
        elif len(candidates) > 1:
            ambiguous.append(old[:12])
    return targets, ambiguous


def documents(root: Path) -> list[Path]:
    paths: list[Path] = []
    tasks_dir = root / "tasks"
    if tasks_dir.is_dir():
        paths.extend(sorted(tasks_dir.glob("*.md")))
    conventions = root / "CONVENTIONS.md"
    if conventions.is_file():
        paths.append(conventions)
    return paths


def surface_spans(path: Path, text: str) -> list[tuple[int, int]]:
    """Character spans of the evidence surfaces in one document."""
    if path.name == "CONVENTIONS.md":
        return [match.span() for match in RESET_LINE_RE.finditer(text)]
    return [match.span() for match in EVIDENCE_SECTION_RE.finditer(text)]


def rewrite_spans(
    root: Path, text: str, spans: list[tuple[int, int]], targets: dict[str, str]
) -> tuple[str, int, list[str]]:
    """Replace tokens only inside the given spans, merging overlapping ones.

    A token is replaced only when it is unreachable and equals a full mapping
    key (or a prefix of exactly one key) whose replacement is reachable.
    Everything else is recorded as stuck and left in place.
    """
    merged: list[list[int]] = []
    for start, end in sorted(spans):
        if merged and start <= merged[-1][1]:
            merged[-1][1] = max(merged[-1][1], end)
        else:
            merged.append([start, end])
    pieces: list[str] = []
    cursor = 0
    replaced = 0
    stuck: list[str] = []
    for start, end in merged:
        pieces.append(text[cursor:start])
        chunk = text[start:end]
        out: list[str] = []
        last = 0
        for match in HEX_TOKEN_RE.finditer(chunk):
            token = match.group(0)
            if is_reachable(root, token):
                continue
            new = targets.get(token)
            if new is None:
                candidates = [old for old in targets if old.startswith(token)]
                new = targets[candidates[0]] if len(candidates) == 1 else None
            if new is None or not is_reachable(root, new):
                stuck.append(token)
                continue
            out.append(chunk[last : match.start()])
            out.append(new)
            last = match.end()
            replaced += 1
        out.append(chunk[last:])
        pieces.append("".join(out))
        cursor = end
    pieces.append(text[cursor:])
    return "".join(pieces), replaced, stuck


def check_mode(root: Path) -> int:
    problems: list[str] = []
    for path in documents(root):
        text = path.read_text(encoding="utf-8")
        for start, end in surface_spans(path, text):
            chunk = text[start:end]
            for match in HEX_TOKEN_RE.finditer(chunk):
                token = match.group(0)
                if not is_reachable(root, token):
                    line = text.count("\n", 0, start + match.start()) + 1
                    problems.append(f"{path.relative_to(root)}:{line}: {token} 不可达")
    if problems:
        for problem in problems:
            print(f"rewrite-fix: {problem}")
        print(f"rewrite-fix: {len(problems)} 处不可达引用待处理", file=sys.stderr)
        return 1
    print("rewrite-fix: 证据面哈希引用全部可达")
    return 0


def apply_mode(root: Path, pairs: list[tuple[str, str]]) -> int:
    mapping = closure(pairs)
    targets, ambiguous = build_targets(root, mapping)
    total = 0
    stuck_all: list[tuple[Path, str]] = []
    touched: list[str] = []
    for path in documents(root):
        text = path.read_text(encoding="utf-8")
        spans = surface_spans(path, text)
        if not spans:
            continue
        new_text, count, stuck = rewrite_spans(root, text, spans, targets)
        for token in stuck:
            stuck_all.append((path, token))
        if count:
            path.write_text(new_text, encoding="utf-8")
            total += count
            touched.append(f"{path.relative_to(root)}: {count} 处哈希引用已更新")
    for line in touched:
        print(f"rewrite-fix: {line}")
    if not touched and not stuck_all:
        print("rewrite-fix: 无需替换")
        return 0
    for path, token in stuck_all:
        print(f"rewrite-fix: {path.relative_to(root)}: {token} 不可达且无映射，保留待人工核对", file=sys.stderr)
    if stuck_all:
        print("rewrite-fix: 存在无映射的不可达引用，请人工核对（--check 可复查）", file=sys.stderr)
        return 1
    print(f"rewrite-fix: 共替换 {total} 处；改动留在工作树，随下一笔提交入库（证据修复豁免）")
    return 0


def main() -> int:
    root = Path.cwd()
    if not (root / ".git").exists():
        return fail("run inside a git repository")
    mode = sys.argv[1] if len(sys.argv) > 1 else ""
    if mode == "--check":
        return check_mode(root)
    if mode == "--apply":
        try:
            pairs = read_pairs(sys.stdin.read())
        except ValueError as error:
            return fail(str(error))
        if not pairs:
            return 0  # an empty rewrite report (nothing rewritten) is a no-op
        return apply_mode(root, pairs)
    return fail("usage: agentmap_rewrite_fix.py --apply | --check")


if __name__ == "__main__":
    sys.exit(main())
