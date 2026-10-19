#!/usr/bin/env python3

from __future__ import annotations

import os
import re
import subprocess
import sys
from pathlib import Path


PAIRS = {
    "⭐": "功能",
    "✨": "改进",
    "🐛": "修复",
    "📝": "文档",
    "🧪": "测试",
    "📌": "计划",
    "🧹": "维护",
    "⚙️": "配置",
    "♻️": "重构",
    "🚀": "发布",
}
SUBJECT = re.compile(
    r"^(?P<emoji>\S+) (?P<type>[^\s(]+)"
    r"\((?P<scope>[a-z0-9][a-z0-9-]*)\): (?P<message>.+)$"
)
EXCEPTIONS = ("Merge ", "Revert ", "fixup! ", "squash! ")
REQUIRED_HEADINGS = {"原因", "影响", "取舍"}
# CJK calibration: Python \b is CJK-blind ("修复任务T-001" has no boundary
# before T), so the boundary is an explicit ASCII-alnum lookaround; CJK may
# touch the id directly, ASCII letters/digits may not (calibration 2026-11).
TASK_REF_RE = re.compile(r"(?<![0-9A-Za-z])T-\d{3}(?![0-9A-Za-z])")
CLOSE_TASK_RE = re.compile(r"(?<![0-9A-Za-z])关闭\s*(T-\d{3})(?![0-9A-Za-z])")
TERMINAL_TASK_RE = re.compile(r"^状态:\s*(?:completed|abandoned|superseded)\s*$", re.MULTILINE)


def fail(message: str) -> int:
    print(f"commit-msg: {message}. See CONVENTIONS.md#Git-提交规范", file=sys.stderr)
    return 1


def missing_task_files(text: str) -> list[str]:
    """Cited task ids whose task file does not exist in the repository.

    Without a repository context (the validator only receives the message
    file), existence cannot be verified and the check is skipped.
    """
    try:
        root = subprocess.run(
            ["git", "rev-parse", "--show-toplevel"],
            check=True,
            capture_output=True,
            text=True,
        ).stdout.strip()
    except (OSError, subprocess.CalledProcessError):
        return []
    if not root:
        return []
    return [
        task_id
        for task_id in sorted(set(TASK_REF_RE.findall(text)))
        if not any(Path(root).glob(f"tasks/{task_id}-*.md"))
    ]


def _git_output(args: list[str], cwd: str, check: bool = True) -> str:
    return subprocess.run(
        ["git", *args], cwd=cwd, check=check, capture_output=True, text=True
    ).stdout


def task_terminal(relative: str, source: str, root: str) -> bool:
    """Whether the given revision's task file (index spec or ref:path) is terminal."""
    output = _git_output(["show", f"{source}:{relative}"], root, check=False)
    return TERMINAL_TASK_RE.search(output) is not None if output else False


def unfulfilled_task_closures(text: str) -> list[str]:
    """Claimed task closures (关闭 T-nnn) that the commit itself does not fulfil.

    A closure claim is an action claim: the same commit must flip the task's
    状态 to a terminal value, otherwise the message records a closure the
    ledger never made. Survey evidence: a batch commit later needed six task
    reworks because the closing commits forgot the status line. Two modes:
    live commit-msg judges the staged index; pre-push replay (the dispatcher
    sets AGENTMAP_COMMIT_REPLAY per commit) judges the replayed commit's own
    tree. A historical mention passes — an already-terminal task has nothing
    to flip. Skipped silently when the message cites no closure or git is
    unavailable.
    """
    wanted = sorted(set(CLOSE_TASK_RE.findall(text)))
    if not wanted:
        return []
    try:
        root = subprocess.run(
            ["git", "rev-parse", "--show-toplevel"],
            check=True,
            capture_output=True,
            text=True,
        ).stdout.strip()
    except (OSError, subprocess.CalledProcessError):
        return []
    if not root:
        return []
    replay = os.environ.get("AGENTMAP_COMMIT_REPLAY", "").strip()
    problems: list[str] = []
    for task_id in wanted:
        matches = sorted(Path(root).glob(f"tasks/{task_id}-*.md"))
        if not matches:
            continue  # existence is already reported by missing_task_files
        relative = matches[0].relative_to(Path(root)).as_posix()
        if replay:
            if task_terminal(relative, replay, root):
                continue  # the replayed commit carries the flip (or re-closes)
            problems.append(
                f"{task_id}(提交 {replay[:7]} 未包含 {relative} 的状态翻正)"
            )
            continue
        if task_terminal(relative, "HEAD", root):
            continue  # historical mention; task already terminal at HEAD
        try:
            staged = _git_output(["diff", "--cached", "--name-only"], root).splitlines()
        except (OSError, subprocess.CalledProcessError):
            continue
        if relative not in staged:
            problems.append(
                f"{task_id}({relative} 未进入本次提交;宣称关闭 task 的提交必须包含其状态翻正)"
            )
            continue
        try:
            staged_text = _git_output(["show", f":{relative}"], root)
        except (OSError, subprocess.CalledProcessError):
            continue
        if not TERMINAL_TASK_RE.search(staged_text):
            problems.append(f"{task_id}({relative} 已暂存但 状态 仍非终态)")
    return problems


def validate(lines: list[str]) -> int:
    if not lines:
        return fail("empty commit message")
    subject = lines[0].strip()
    if subject.startswith(EXCEPTIONS):
        return 0
    match = SUBJECT.fullmatch(subject)
    if not match:
        return fail("expected emoji 中文类型(scope): 中文结果描述")
    if PAIRS.get(match.group("emoji")) != match.group("type"):
        return fail("unknown or mismatched emoji/type")
    if not re.search(r"[\u4e00-\u9fff]", match.group("message")):
        return fail("result description must contain Chinese")
    if len(lines) < 2 or lines[1].strip():
        return fail("subject and body must be separated by a blank line")

    headings: set[str] = set()
    in_code_block = False
    for line in lines[1:]:
        if re.match(r"^\s*```", line):
            in_code_block = not in_code_block
        elif not in_code_block:
            heading = re.fullmatch(r"##\s+(.+?)\s*", line)
            if heading:
                headings.add(heading.group(1))
    missing = REQUIRED_HEADINGS - headings
    if missing:
        return fail("missing body sections: " + "、".join(sorted(missing)))
    cited_missing = missing_task_files("\n".join(lines))
    if cited_missing:
        return fail("cited task ids have no task file: " + ", ".join(cited_missing))
    closure_problems = unfulfilled_task_closures("\n".join(lines))
    if closure_problems:
        return fail("task closure mismatch: " + "; ".join(closure_problems))
    return 0


def main() -> int:
    if len(sys.argv) != 2:
        return fail("usage: agentmap_validate_commit_msg.py <commit-msg-file>")
    return validate(Path(sys.argv[1]).read_text(encoding="utf-8").splitlines())


if __name__ == "__main__":
    raise SystemExit(main())
