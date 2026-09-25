#!/usr/bin/env python3
"""Anchor coverage gate（顾问 adv-7 门槛 3；C-010）。

双向覆盖校验 + 僵尸预期规则，作为测试锚定迁移模式的收敛闸门：

1. 每个「未锚定 AC」（PRD 全体 AC 减去测试源码中出现的 AC-ID）必须出现在
   至少一个 task 的「必锚 AC（收敛闸门）」清单中——迁移期不允许无主差距。
2. 必锚清单中的每个引用（含 `AC-xx～yy` 区间展开）必须指向真实存在的
   PRD AC——清单不得引用幽灵需求。
3. 僵尸预期规则：CONVENTIONS `测试锚定模式: migration T-nnn` 所指 task 进入
   终态后，残留未锚定 AC 即为错误——预期失败清单不得比它的 task 活得久。

只读校验；发现违规以非零码退出并逐条列出。
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

R_HEADING_RE = re.compile(r"^#### (R-\d\d-\d{3}) ", re.MULTILINE)
AC_LINE_RE = re.compile(
    r"^-\s*(AC-\d{2})\s+(?=.*应当)(?:系统|当.+时|若.+|在.+期间|具备.+时)",
    re.MULTILINE,
)
AC_REF_RE = re.compile(r"(R-\d{2}-\d{3})/AC-(\d{2})(?!～)")
AC_RANGE_RE = re.compile(r"(R-\d{2}-\d{3})/AC-(\d{2})～(\d{2})")
MIGRATION_RE = re.compile(r"^\s*-\s*测试锚定模式:\s*migration\s*(T-\d{3})\s*$", re.MULTILINE)
STATUS_RE = re.compile(r"^状态:\s*(\S+)\s*$", re.MULTILINE)
TERMINAL_STATES = {"completed", "abandoned", "superseded"}
NEEDED_LIST_RE = re.compile(r"^-\s*必锚 AC（收敛闸门）[:：]\s*(.+)$", re.MULTILINE)


def prd_acceptance_ids() -> dict[str, set[str]]:
    text = (ROOT / "PRD.md").read_text(encoding="utf-8")
    out: dict[str, set[str]] = {}
    current: str | None = None
    for line in text.splitlines():
        heading = R_HEADING_RE.match(line)
        if heading:
            current = heading.group(1)
            out.setdefault(current, set())
        if current:
            match = AC_LINE_RE.match(line)
            if match:
                out[current].add(f"{current}/{match.group(1)}")
    return out


def anchored_ids() -> set[str]:
    ids: set[str] = set()
    pattern = re.compile(r"R-\d\d-\d{3}/AC-\d{2}")
    for path in sorted((ROOT / "test").rglob("*.test.js")):
        try:
            text = path.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            continue
        ids.update(pattern.findall(text))
    return ids


def needed_refs() -> tuple[set[str], list[tuple[Path, str]]]:
    refs: set[str] = set()
    provenance: list[tuple[Path, str]] = []
    tasks_dir = ROOT / "tasks"
    for path in sorted(tasks_dir.glob("T-*.md")):
        try:
            text = path.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            continue
        for block in NEEDED_LIST_RE.findall(text):
            if not block.strip():
                continue
            # 先展开区间（含尾随说明文字的条目），再对余文取单引用
            expanded = AC_RANGE_RE.sub(
                lambda m: " ".join(
                    f"{m.group(1)}/AC-{n:02d}" for n in range(int(m.group(2)), int(m.group(3)) + 1)
                ),
                block,
            )
            for rid, ac in AC_REF_RE.findall(expanded):
                refs.add(f"{rid}/AC-{ac}")
            provenance.append((path, block.strip()))
    return refs, provenance


def main() -> int:
    errors: list[str] = []

    acs = prd_acceptance_ids()
    all_ids = {aid for ids in acs.values() for aid in ids}
    anchored = anchored_ids()
    unanchored = all_ids - anchored
    needed, provenance = needed_refs()

    ghost = sorted(needed - all_ids)
    if ghost:
        errors.append(f"必锚清单引用不存在的 AC: {', '.join(ghost)}")

    uncovered = sorted(unanchored - needed)
    if uncovered:
        errors.append(f"未锚定 AC 未被任何必锚清单承接: {', '.join(uncovered)}")

    conventions = (ROOT / "CONVENTIONS.md")
    if conventions.is_file():
        match = MIGRATION_RE.search(conventions.read_text(encoding="utf-8"))
        if match:
            task_id = match.group(1)
            task_files = list((ROOT / "tasks").glob(f"{task_id}-*.md"))
            if not task_files:
                errors.append(f"migration task {task_id} 文件不存在")
            else:
                status_match = STATUS_RE.search(task_files[0].read_text(encoding="utf-8"))
                status = status_match.group(1) if status_match else "unknown"
                if status in TERMINAL_STATES and unanchored:
                    errors.append(
                        f"僵尸预期：migration task {task_id} 已终态（{status}）"
                        f"但仍有 {len(unanchored)} 个未锚定 AC"
                    )

    print(
        f"anchor coverage: prd-ac={len(all_ids)} anchored={len(all_ids & anchored)}"
        f" unanchored={len(unanchored)} needed-union={len(needed)}"
    )
    if errors:
        for error in errors:
            print(f"anchor coverage failed: {error}")
        return 1
    print("anchor coverage passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
