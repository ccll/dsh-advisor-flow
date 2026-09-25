#!/usr/bin/env python3
"""Anchor coverage gate（顾问 adv-7/adv-8/adv-9 门槛 2、3；C-010、C-011）。

双向覆盖校验 + 僵尸预期规则 + 零 AC 逃逸分支，作为测试锚定迁移模式的收敛闸门：

1. 每个「未锚定 AC」（PRD 全体 AC 减去测试源码中出现的 AC-ID）必须出现在
   至少一个 task 的「必锚 AC（收敛闸门）」清单中——迁移期不允许无主差距。
2. 必锚清单中的每个引用（含 `AC-xx～yy` 区间展开）必须指向真实存在的
   PRD AC——清单不得引用幽灵需求。
3. 僵尸预期规则：CONVENTIONS `测试锚定模式: migration T-nnn` 所指 task 进入
   终态后，残留未锚定 AC 即为错误——预期失败清单不得比它的 task 活得久。
4. 零 AC 逃逸分支（adv-8）：migration task 终态后，每个 PRD 需求必须至少
   有一个 AC——零 AC 需求不产生「未锚定」信号，须显式兜底。

终态置位权沿用 AgentMap task 生命周期（置位动作即执行 agent 关闭 task 本身，
无额外权限通道；C-012）。`--self-test` 用合成 fixture 实跑零 AC 错误分支并
留存输出（adv-9 收口项 3）。
"""

from __future__ import annotations

import json
import re
import sys
import tempfile
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


def prd_acceptance_ids(root: Path) -> dict[str, set[str]]:
    text = (root / "PRD.md").read_text(encoding="utf-8")
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


def anchored_ids(root: Path) -> set[str]:
    ids: set[str] = set()
    pattern = re.compile(r"R-\d\d-\d{3}/AC-\d{2}")
    test_dir = root / "test"
    if not test_dir.is_dir():
        return ids
    for path in sorted(test_dir.rglob("*.test.js")):
        try:
            text = path.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            continue
        ids.update(pattern.findall(text))
    return ids


def needed_refs(root: Path) -> set[str]:
    refs: set[str] = set()
    tasks_dir = root / "tasks"
    if not tasks_dir.is_dir():
        return refs
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
    return refs


def migration_status(root: Path) -> tuple[str | None, str | None]:
    conventions = root / "CONVENTIONS.md"
    if not conventions.is_file():
        return None, None
    match = MIGRATION_RE.search(conventions.read_text(encoding="utf-8"))
    if not match:
        return None, None
    task_id = match.group(1)
    task_files = list((root / "tasks").glob(f"{task_id}-*.md"))
    if not task_files:
        return task_id, "missing"
    status_match = STATUS_RE.search(task_files[0].read_text(encoding="utf-8"))
    return task_id, (status_match.group(1) if status_match else "unknown")


def evaluate(root: Path) -> tuple[str, list[str]]:
    errors: list[str] = []
    acs = prd_acceptance_ids(root)
    all_ids = {aid for ids in acs.values() for aid in ids}
    anchored = anchored_ids(root)
    unanchored = all_ids - anchored
    needed = needed_refs(root)

    ghost = sorted(needed - all_ids)
    if ghost:
        errors.append(f"必锚清单引用不存在的 AC: {', '.join(ghost)}")

    uncovered = sorted(unanchored - needed)
    if uncovered:
        errors.append(f"未锚定 AC 未被任何必锚清单承接: {', '.join(uncovered)}")

    task_id, status = migration_status(root)
    if task_id:
        if status == "missing":
            errors.append(f"migration task {task_id} 文件不存在")
        elif status in TERMINAL_STATES:
            if unanchored:
                errors.append(
                    f"僵尸预期：migration task {task_id} 已终态（{status}）"
                    f"但仍有 {len(unanchored)} 个未锚定 AC"
                )
            # 零 AC 逃逸分支（adv-8）：零 AC 需求不产生「未锚定」信号，
            # 终态规则须显式补位——终态后每需求 ≥1 AC。
            zero_ac = sorted(rid for rid, ids in acs.items() if not ids)
            if zero_ac:
                errors.append(f"零 AC 需求逃逸终态规则: {', '.join(zero_ac)}")

    summary = (
        f"anchor coverage: prd-ac={len(all_ids)} anchored={len(all_ids & anchored)}"
        f" unanchored={len(unanchored)} needed-union={len(needed)}"
        f" migration={task_id or 'none'}:{status or 'n/a'}"
        "（needed-union=各 task 必锚清单引用 AC 的并集，区间已展开；"
        "anchored=测试源码中出现且存在于 PRD 的 AC；unanchored=prd-ac 减 anchored；"
        "migration=迁移 task 及其生命周期状态）"
    )
    return summary, errors


def self_test() -> int:
    """合成 fixture 实跑零 AC 错误分支（adv-9 收口项 3）：留存输出与判定。"""
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        (root / "PRD.md").write_text(
            "#### R-01-001 有锚需求\n"
            "- AC-01 系统应当工作。\n"
            "#### R-01-002 零 AC 需求\n"
            "正文无任何验收点。\n",
            encoding="utf-8",
        )
        (root / "CONVENTIONS.md").write_text(
            "- 测试锚定模式: migration T-001\n", encoding="utf-8"
        )
        (root / "tasks").mkdir()
        (root / "tasks" / "T-001-20990101-fixture.md").write_text(
            "状态: completed\n- 必锚 AC（收敛闸门）：R-01-001/AC-01 全部有测试锚点方可关闭。\n",
            encoding="utf-8",
        )
        (root / "test").mkdir()
        summary, errors = evaluate(root)
        print(f"[self-test] {summary}")
        fired_zero_ac = any("零 AC 需求逃逸终态规则" in e and "R-01-002" in e for e in errors)
        fired_zombie = any("僵尸预期" in e for e in errors)
        print(f"[self-test] errors={errors}")
        if fired_zero_ac and fired_zombie:
            print("[self-test] passed: 零 AC 逃逸分支与僵尸预期均在终态 fixture 下触发")
            return 0
        print("[self-test] failed: 预期错误分支未触发")
        return 1


def main() -> int:
    if "--self-test" in sys.argv:
        return self_test()
    summary, errors = evaluate(ROOT)
    print(summary)
    if errors:
        print("anchor coverage failed:")
        for error in errors:
            print(error)
        return 1
    print("anchor coverage passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
