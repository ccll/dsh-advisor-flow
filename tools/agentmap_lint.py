#!/usr/bin/env python3
"""Validate AgentMap structure, traceability, tasks, hooks, and evidence."""

from __future__ import annotations

import argparse
from contextlib import contextmanager
from fnmatch import fnmatchcase
import hashlib
import os
import re
import shutil
import subprocess
import sys
import tempfile
from dataclasses import dataclass, field
from datetime import date
from pathlib import Path

# Windows defaults subprocess text mode to the locale encoding (GBK), which
# crashes on git output that contains UTF-8 Chinese paths or content. Force
# UTF-8 decoding for every text-mode subprocess call.
_original_run = subprocess.run


def _utf8_run(*args: object, **kwargs: object) -> subprocess.CompletedProcess:
    kwargs.setdefault("encoding", "utf-8")
    kwargs.setdefault("errors", "replace")
    return _original_run(*args, **kwargs)


subprocess.run = _utf8_run  # type: ignore[assignment]

SYSTEM_FILES = {
    "PRD.md": ("prd", "living", "R"),
    "SOLUTION.md": ("solution", "living", None),
    "DOMAIN.md": ("domain", "living", None),
    "RATIONALE.md": ("rationale", "append-only", "C"),
    "TODO.md": ("todo", "inbox", None),
    "CONVENTIONS.md": ("conventions", "living", None),
}
# Legacy installs keep pre-rename map filenames (DESIGN.md/DECISIONS.md) and
# pre-rename vocabulary until bootstrap --migrate-legacy-maps rewrites them.
LEGACY_MAP_FILES = {
    "SOLUTION.md": ("DESIGN.md", "design"),
    "RATIONALE.md": ("DECISIONS.md", "decisions"),
}
APPEND_ONLY_FILES = ("RATIONALE.md", "DECISIONS.md")
LEGACY_DETAIL_TITLES = ("方案细化清单", "设计细化清单")
LEGACY_READINESS_NAMES = {"重大设计选择已收敛": "重大方案选择已收敛"}
# Commit hashes mix digits and hex letters a-f. Requiring at least one of
# each rejects the prose tokens \b[0-9a-f]{7,40} swallowed: pure-letter
# English words (defaced) and pure-digit numbers (20260801). Explicit
# evidence lines (- commit:) stay in the lenient form and are verified
# against git history, so no recall is lost where it matters.
HEXISH_TOKEN = r"\b(?=[0-9a-f]*[0-9])(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b"
IMPLEMENTATION_EVIDENCE_RE = re.compile(
    rf"(?:\b(?:src|tests?|tasks)/|{HEXISH_TOKEN}|`[^`]+\.(?:py|rs|go|js|ts|java|kt|rb|sh)`)",
    re.IGNORECASE,
)
# Decision entries may reference tasks via T-ID and may name tasks/ as workflow
# vocabulary (the audit chain), so only src/tests paths, hashes, and code-file
# references count as implementation evidence there. Checked against newly
# appended entries only; historical entries are immutable and grandfathered.
DECISION_EVIDENCE_RE = re.compile(
    rf"(?:\b(?:src|tests?)/|{HEXISH_TOKEN}|`[^`]+\.(?:py|rs|go|js|ts|java|kt|rb|sh)`)",
    re.IGNORECASE,
)
MUTATIONS = {"living", "append-only", "inbox", "lifecycle"}
TERMINAL_STATES = {"completed", "abandoned", "superseded"}
COMMIT_EVIDENCE_LINE_RE = re.compile(r"-\s*commit:\s*(?P<hash>[0-9a-f]{7,40})\s*")
TASK_NAME_RE = re.compile(r"^(T-\d{3})-\d{8}-.+\.md$")
LEGACY_TASK_NAME_RE = re.compile(r"^\d{8}-.+\.md$")
# Optional CONVENTIONS local parameter: once the registered date has passed,
# legacy task names and legacy map file names stop being grandfathered and
# lint reports them as errors instead of warnings.
LEGACY_CUTOFF_RE = re.compile(r"^-\s*legacy 迁移截止:\s*(\d{4}-\d{2}-\d{2})\s*$", re.MULTILINE)
# Loose detector: any value on a 迁移截止 line that the strict pattern cannot
# parse must still produce an error, never silent tolerance.
LEGACY_CUTOFF_LOOSE_RE = re.compile(r"^-\s*legacy 迁移截止:\s*(\S+)\s*$", re.MULTILINE)
# CJK calibration: Python \b is CJK-blind ("任务T-001" has no boundary before
# T because 务 and T are both \w), so every id regex below uses explicit
# [0-9A-Za-z] lookarounds. CJK text may touch an id directly; ASCII
# letters/digits may not. A trailing "-" stays legal so file names like
# T-001-20260801-search.md keep matching (calibration 2026-11).
T_ID_RE = re.compile(r"(?<![0-9A-Za-z])T-\d{3}(?![0-9A-Za-z])")
GOAL_RE = re.compile(r"\*\*(G-\d+)(?![0-9A-Za-z])")
NON_GOAL_RE = re.compile(r"\*\*(NG-\d+)(?![0-9A-Za-z])")
R_HEADING_RE = re.compile(r"^####\s+(R-\d{2}-\d{3})(?![0-9A-Za-z]).*$", re.MULTILINE)
LEGACY_R_HEADING_RE = re.compile(r"^####\s+(R-\d{3})(?![0-9A-Za-z]).*$", re.MULTILINE)
LEGACY_R_ID_RE = re.compile(r"(?<![0-9A-Za-z])R-\d{3}(?![0-9A-Za-z])")
C_HEADING_RE = re.compile(r"^###\s+(C-\d{3}[A-Z]?)(?![0-9A-Za-z])", re.MULTILINE)
R_ID_RE = re.compile(r"(?<![0-9A-Za-z])R-\d{2}-\d{3}(?![0-9A-Za-z])")
AC_ID_RE = re.compile(r"(?<![0-9A-Za-z])R-\d{2}-\d{3}/AC-\d{2}(?![0-9A-Za-z])")
C_ID_RE = re.compile(r"(?<![0-9A-Za-z])C-\d{3}[A-Z]?(?![0-9A-Za-z])")
R_RANGE_RE = re.compile(r"R-(\d{2})-(\d{3})\s*[～~-]\s*(?:R-(\d{2})-)?(\d{3})")

# Near-miss tripwire: malformed ids (R-100-001, C-001AB, T-0001) match none of
# the reference regexes above, so every traceability check silently ignores
# them. The loose patterns over-match each id family on purpose; each hit is
# re-validated with fullmatch against the canonical shape, and violations
# become lint errors instead of invisible noise.
ID_NEAR_MISS_RULES = (
    ("task", re.compile(r"(?<![0-9A-Za-z])T-\d{2,}[0-9A-Za-z]*(?![0-9A-Za-z])"), "T-NNN"),
    (
        "requirement",
        re.compile(r"(?<![0-9A-Za-z])R-\d{2,4}(?:-\d{2,4})?(?![0-9A-Za-z])"),
        "R-NNN (legacy) or R-GG-NNN",
    ),
    (
        "acceptance",
        re.compile(r"(?<![0-9A-Za-z])R-\d{2,4}(?:-\d{2,4})?/AC-\d{2,4}(?![0-9A-Za-z])"),
        "R-GG-NNN/AC-NN",
    ),
    (
        "decision",
        re.compile(r"(?<![0-9A-Za-z])C-\d{2,}[A-Za-z]*(?![0-9A-Za-z])"),
        "C-NNN or C-NNN + uppercase letter",
    ),
)
ID_STRICT_VALIDATORS = {
    "task": re.compile(r"T-\d{3}").fullmatch,
    "requirement": re.compile(r"R-(?:\d{3}|\d{2}-\d{3})").fullmatch,
    "acceptance": re.compile(r"R-\d{2}-\d{3}/AC-\d{2}").fullmatch,
    "decision": re.compile(r"C-\d{3}[A-Z]?").fullmatch,
}
REQUIREMENT_GROUP_RE = re.compile(r"^-\s*需求组\s+(\d{2})\s*[:：]\s*(\S.*?)\s*$", re.MULTILINE)
SOLUTION_VIEW_RULES = {
    "系统上下文": ("系统上下文图", r"(?:flowchart|graph|C4Context)\b", "context diagram", True),
    "一级静态分解": (
        "一级静态分解图",
        r"(?:flowchart|graph|C4Container)\b",
        "container or level-1 building-block diagram",
        True,
    ),
    "内部组件分解": ("内部组件分解图", r"(?:flowchart|graph|C4Component)\b", "component diagram", False),
    "运行时交互": ("运行时交互图", r"(?:sequenceDiagram|flowchart|graph)\b", "runtime interaction diagram", False),
    "数据与领域模型": (
        "数据与领域模型图",
        r"(?:classDiagram|erDiagram|flowchart|graph)\b",
        "data or domain model diagram",
        False,
    ),
    "状态与生命周期": ("状态与生命周期图", r"stateDiagram(?:-v2)?\b", "state diagram", False),
    "数据流与信任边界": ("数据流与信任边界图", r"(?:flowchart|graph)\b", "data-flow diagram", False),
    "部署": ("部署图", r"(?:flowchart|graph|C4Deployment|architecture-beta)\b", "deployment diagram", False),
    "分层与依赖": ("分层与依赖图", r"(?:flowchart|graph)\b", "layer or dependency diagram", False),
    "系统景观": ("系统景观图", r"(?:flowchart|graph|C4Context)\b", "system landscape diagram", False),
}
SOLUTION_DETAIL_RULES = {
    "边界与对外契约": True,
    "核心数据与不变量": True,
    "状态与生命周期": False,
    "运行时、并发与失败语义": True,
    "外部集成": False,
    "配置与可变点": False,
    "安全与信任边界": False,
    "部署、迁移与恢复": False,
    "兼容性与版本演进": False,
    "可观测性与运维": False,
}
READINESS_RULES = {
    "边界与契约已明确": False,
    "关键不变量已明确": False,
    "重大方案选择已收敛": True,
    "目标实现归属已明确": False,
    "现状差距已有 task 承接": True,
    "可派生验证": False,
}
# The modality must sit in the outcome clause, not anywhere in the line: a
# global (?=.*应当) lookahead was satisfied by coincidental condition-internal
# substrings (对应当协议, 响应当超过) and masked non-canonical outcome
# modalities such as 系统应不/系统应限制 (postfix calibration, 2026-10).
# 若-patterns accept both full-width and half-width commas (half-width
# commas are common in mixed-locale editors; the separator is not the
# discipline being enforced).
EARS_RE = re.compile(
    r"^-\s*(?:AC-\d{2}\s+)?(?:系统(?=.*应当)|当.+时(?=.*应当)"
    r"|若.+[，,](?=.*应当)|在.+期间(?=.*应当)|具备.+时(?=.*应当))",
    re.MULTILINE,
)
AC_LINE_RE = re.compile(
    r"^-\s*(AC-\d{2})\s+(?:系统(?=.*应当)|当.+时(?=.*应当)"
    r"|若.+[，,](?=.*应当)|在.+期间(?=.*应当)|具备.+时(?=.*应当))",
    re.MULTILINE,
)
REQUIRED_VERIFICATION_DIMENSIONS = {"成功", "异常", "边界配置", "副作用"}
TODO_ENTRY_RE = re.compile(r"^- \[(?:需求候选|缺陷线索|性能想法|安全想法|维护想法)\] \S")
CODE_SUFFIXES = {
    ".cs",
    ".ex",
    ".exs",
    ".go",
    ".java",
    ".js",
    ".jsx",
    ".kt",
    ".kts",
    ".php",
    ".py",
    ".rb",
    ".rs",
    ".scala",
    ".sh",
    ".swift",
    ".ts",
    ".tsx",
}
IGNORED_PARTS = {
    ".agents",
    ".git",
    ".mypy_cache",
    ".pytest_cache",
    ".ruff_cache",
    ".venv",
    ".worktrees",
    "__pycache__",
    "coverage",
    "htmlcov",
    "node_modules",
    "target",
    "vendor",
    "dist",
    "build",
    "tmp",
}
CANONICAL_FILES_SHA256 = {
    "AGENTS.md": "bc2a13b66c1a6c641fd19bee3a036350f50d1f806c0a96a50642e3c12190f96f",
    ".githooks/commit-msg": "8fdca988a521f36cd012041217e14ab9d1847de5bd12ab81f2d2904c645b89e0",
    ".githooks/pre-commit": "83cfb74e7792ed1cf1264105941249d06a37872455faf83297220eb4268325fa",
    ".githooks/pre-push": "c85da06d5f5423959656195835bb570912839e9e65483d3cc20bf096aea9cd4c",
    ".githooks/pre-commit.d/20-agentmap-lint.sh": "95c7df8021cceb8b357c7ea4edafbb2559ddd4179527327f5197ae851d9aa9c4",
    ".githooks/pre-push.d/20-agentmap-lint.sh": "8151ed2cccbb2077f5fafc0a784269fa89815e1a173845c0de90b8563fee6f7d",
    "tools/agentmap_validate_commit_msg.py": "3fa7abf08602abfa479eb4d8e196bc9d37342421c55535d69b04b6527b522eeb",
}
HOOK_NAME_PATTERN = re.compile(r"^(?P<order>[0-9]{2})-[a-z0-9][a-z0-9-]*\.sh$")
PLACEHOLDER_RE = re.compile(r"\b(?:TBD|TODO|N/A)\b|待评估|待定|待补", re.IGNORECASE)
CORE_BUDGET_FILES = ("PRD.md", "SOLUTION.md", "DOMAIN.md", "CONVENTIONS.md", "AGENTS.md")
# Token counts are not reproducible; the registered token budget converts
# through a deterministic 3 bytes/token proxy (CJK UTF-8 averages 3 bytes
# per character, roughly one token per character).
CORE_BUDGET_BYTES_PER_TOKEN = 3
CORE_BUDGET_RE = re.compile(r"^- 核心文档上限:\s*(\d+)\s*token\s*$", re.MULTILINE)
CORE_SPLIT_PLAN_RE = re.compile(r"^- 核心文档分片方案:\s*\S", re.MULTILINE)
SUPERSEDED_DECLARATION_RE = re.compile(r"^\s*-\s*废弃[:：]\s*(C-\d{3}[A-Z]?)\s*$", re.MULTILINE)


@dataclass
class Result:
    errors: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    requirements: set[str] = field(default_factory=set)
    acceptance_criteria: set[str] = field(default_factory=set)
    solution_covered: set[str] = field(default_factory=set)
    decision_ids: set[str] = field(default_factory=set)
    superseded_decisions: dict[str, str] = field(default_factory=dict)
    test_anchored: set[str] = field(default_factory=set)
    test_anchored_acceptance_criteria: set[str] = field(default_factory=set)
    goals: set[str] = field(default_factory=set)
    tasks: dict[str, int] = field(default_factory=dict)
    task_states: dict[str, str] = field(default_factory=dict)
    task_line_counts: dict[str, int] = field(default_factory=dict)
    legacy_cutoff: date | None = None
    task_line_counts: dict[str, int] = field(default_factory=dict)


def read_text_checked(path: Path, result: Result, label: str) -> str | None:
    """Read a repository file as UTF-8, reporting unreadable files as errors.

    A file that is not valid UTF-8 (or vanished mid-run) is repository state
    the agent must fix; a traceback would abort the whole lint run and hide
    every other finding, so the failure is recorded per file and the caller
    skips that file while the remaining checks keep running.
    """
    try:
        return path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError) as error:
        result.errors.append(
            f"{label}: cannot read file ({error.__class__.__name__}: {error});"
            " fix the file encoding or permissions, then rerun"
        )
        return None


def parse_frontmatter(text: str) -> dict[str, str] | None:
    match = re.match(r"^---\n(.*?)\n---\n", text, re.DOTALL)
    if not match:
        return None
    fields: dict[str, str] = {}
    for line in match.group(1).splitlines():
        if ":" in line:
            key, _, value = line.partition(":")
            fields[key.strip()] = value.strip()
    return fields


def duplicate_ids(ids: list[str]) -> set[str]:
    seen: set[str] = set()
    duplicates: set[str] = set()
    for item in ids:
        if item in seen:
            duplicates.add(item)
        seen.add(item)
    return duplicates


def strip_code_fences(text: str) -> str:
    """Remove fenced code blocks so examples inside them are not parsed as documents."""
    lines = []
    in_fence = False
    for line in text.splitlines():
        if line.strip().startswith("```"):
            in_fence = not in_fence
            continue
        if not in_fence:
            lines.append(line)
    return "\n".join(lines)


def sections(text: str, heading_re: re.Pattern[str]) -> dict[str, str]:
    matches = list(heading_re.finditer(text))
    return {
        match.group(1): text[match.start() : matches[index + 1].start() if index + 1 < len(matches) else len(text)]
        for index, match in enumerate(matches)
    }


def expand_requirement_ids(text: str, result: Result | None = None) -> set[str]:
    """Expand explicit ids plus R-GG-NNN～NNN ranges; degraded ranges fail loudly."""
    ids = set(R_ID_RE.findall(text))
    for group, start, end_group, end in R_RANGE_RE.findall(text):
        if end_group and end_group != group:
            if result is not None:
                result.errors.append(
                    f"SOLUTION.md: requirement range R-{group}-{start}～R-{end_group}-{end} "
                    "spans requirement groups; write explicit ids per group"
                )
            continue
        first, last = int(start), int(end)
        if first > last:
            if result is not None:
                result.errors.append(
                    f"SOLUTION.md: requirement range R-{group}-{start}～R-{group}-{end} "
                    "is reversed"
                )
            continue
        if last - first > 100:
            if result is not None:
                result.errors.append(
                    f"SOLUTION.md: requirement range R-{group}-{start}～R-{group}-{end} "
                    "spans over 100 ids; list the ids explicitly or split the range"
                )
            continue
        ids.update(f"R-{group}-{number:03d}" for number in range(first, last + 1))
    return ids


def solution_modules(text: str) -> dict[str, str]:
    match = re.search(r"^## 子系统与模块\s*$", text, re.MULTILINE)
    if not match:
        return {}
    end = re.search(r"^##\s+", text[match.end() :], re.MULTILINE)
    body = text[match.end() : match.end() + end.start() if end else len(text)]
    module_re = re.compile(r"^###\s+(.+?)\s*$", re.MULTILINE)
    matches = list(module_re.finditer(body))
    return {
        item.group(1): body[item.start() : matches[index + 1].start() if index + 1 < len(matches) else len(body)]
        for index, item in enumerate(matches)
    }


def solution_trace_body(text: str) -> str | None:
    match = re.search(r"^## 需求追溯索引\s*$", text, re.MULTILINE)
    if not match:
        return None
    end = re.search(r"^##\s+", text[match.end() :], re.MULTILINE)
    return text[match.end() : match.end() + end.start() if end else len(text)]


def document_section_body(text: str, title: str) -> str | None:
    match = re.search(rf"^##\s+{re.escape(title)}\s*$", text, re.MULTILINE)
    if not match:
        return None
    end = re.search(r"^##\s+", text[match.end() :], re.MULTILINE)
    return text[match.end() : match.end() + end.start() if end else len(text)]


def document_section_body_any(text: str, titles: tuple[str, ...]) -> str | None:
    for title in titles:
        body = document_section_body(text, title)
        if body is not None:
            return body
    return None


def resolve_map_file(root: Path, canonical: str) -> Path | None:
    path = root / canonical
    if path.exists():
        return path
    legacy = LEGACY_MAP_FILES.get(canonical)
    if legacy and (root / legacy[0]).exists():
        return root / legacy[0]
    return None


def decision_entries(text: str) -> str:
    """Decision entries start at the first C-heading; the file header stays renameable."""
    match = C_HEADING_RE.search(text)
    return text[match.start() :] if match else ""


def head_decision_text(root: Path) -> str:
    """Decision log text at HEAD, resolving the legacy filename for in-flight migrations."""
    return (
        git_head_text(root, Path("RATIONALE.md"))
        or git_head_text(root, Path("DECISIONS.md"))
        or ""
    )


DECISION_ID_RE = re.compile(
    r"\b(?:R-\d{2}-\d{3}/AC-\d{2}|R-\d{2}-\d{3}|T-\d{3}|G-\d+|NG-\d+|C-\d{3}[A-Z]?)\b"
)


def decision_entry_signature(body: str) -> tuple:
    """Semantic identity of one entry: heading, date, ID/evidence/number multisets."""
    lines = body.splitlines()
    heading = lines[0].rstrip() if lines else ""
    date_match = re.search(r"^日期:.*$", body, re.MULTILINE)
    date = date_match.group(0).rstrip() if date_match else ""
    ids = tuple(sorted(DECISION_ID_RE.findall(body)))
    evidence = tuple(sorted(DECISION_EVIDENCE_RE.findall(body)))
    skeleton = DECISION_ID_RE.sub(" ", body)
    numbers = tuple(sorted(re.findall(r"\d+(?:\.\d+)?", skeleton)))
    return (heading, date, ids, evidence, numbers)


def decision_entry_signatures(text: str) -> list:
    """Pair each C-ID with its semantic signature, in document order."""
    matches = list(C_HEADING_RE.finditer(text))
    entries = []
    for index, match in enumerate(matches):
        end = matches[index + 1].start() if index + 1 < len(matches) else len(text)
        entries.append((match.group(1), decision_entry_signature(text[match.start() : end])))
    return entries


def decision_transition_failure(old_text: str, new_text: str) -> str | None:
    """Existing entries may be reworded in place; identity and semantics stay frozen.

    东家授权（2026-10-06）：措辞层修订放行，语义漂移拒绝。指纹 = 标题行、日期行、
    ID 多重集、实现证据多重集与数值多重集；分点重构只动文字与列表形状，指纹不变。
    """
    old_entries = decision_entry_signatures(decision_entries(old_text))
    new_entries = decision_entry_signatures(decision_entries(new_text))
    if len(new_entries) < len(old_entries):
        return "removed existing history"
    for index in range(len(old_entries)):
        old_cid, old_signature = old_entries[index]
        new_cid, new_signature = new_entries[index]
        if old_cid != new_cid:
            return "decision %s replaced by %s" % (old_cid, new_cid)
        if old_signature != new_signature:
            return "decision %s changed identity or semantics" % old_cid
    return None


def solution_trace_rows(body: str | None) -> list[tuple[str, str, str, str]]:
    if body is None:
        return []
    row_re = re.compile(
        r"^\|\s*(R-\d{2}-\d{3})\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*$",
        re.MULTILINE,
    )
    return [tuple(cell.strip() for cell in row) for row in row_re.findall(body)]


def solution_view_body(text: str, title: str) -> str | None:
    match = re.search(rf"^###\s+{re.escape(title)}\s*$", text, re.MULTILINE)
    if not match:
        return None
    end = re.search(r"^#{2,3}\s+", text[match.end() :], re.MULTILINE)
    return text[match.end() : match.end() + end.start() if end else len(text)]


def has_mermaid_diagram(body: str, kind_pattern: str) -> bool:
    return any(
        re.match(rf"\s*{kind_pattern}", diagram)
        for diagram in re.findall(r"```mermaid\s*\n([\s\S]*?)```", body)
    )


def has_compact_table(body: str) -> bool:
    rows = [line.strip() for line in body.splitlines() if line.strip().startswith("|")]
    return len(rows) >= 3 and bool(re.fullmatch(r"\|?[\s:|-]+\|?", rows[1]))


def solution_table_rows(body: str | None, first_header: str) -> list[tuple[str, str, str]]:
    if body is None:
        return []
    rows = re.findall(
        r"^\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*$",
        body,
        re.MULTILINE,
    )
    return [
        tuple(cell.strip() for cell in row)
        for row in rows
        if row[0].strip() != first_header and not re.fullmatch(r"-+", row[0].strip())
    ]


def check_markdown_locator(root: Path, result: Result, owner: str, locator: str) -> None:
    match = re.fullmatch(r"([^#]+\.md)#(.+)", locator.strip().strip("`"))
    if not match:
        result.errors.append(f"{owner}: invalid solution locator {locator}, expect path.md#heading")
        return
    relative, heading = Path(match.group(1)), match.group(2).strip()
    if relative.is_absolute() or ".." in relative.parts:
        result.errors.append(f"{owner}: unsafe solution locator {locator}")
        return
    target = root / relative
    if not target.is_file():
        result.errors.append(f"{owner}: missing solution locator file {relative.as_posix()}")
        return
    text = read_text_checked(target, result, f"{owner} -> {locator}")
    if text is None:
        return
    if not re.search(rf"^#{{1,6}}\s+{re.escape(heading)}\s*$", text, re.MULTILINE):
        result.errors.append(f"{owner}: missing solution locator heading {locator}")


def check_locator_list(root: Path, result: Result, owner: str, value: str) -> bool:
    locators = [item.strip() for item in value.split("；") if item.strip()]
    if not locators or any(not re.fullmatch(r"`?[^#]+\.md#.+`?", item) for item in locators):
        return False
    for locator in locators:
        check_markdown_locator(root, result, owner, locator)
    return True


def check_solution_views(solution: str, result: Result) -> None:
    catalog = document_section_body(solution, "架构视图清单")
    if catalog is None:
        result.errors.append("SOLUTION.md: missing 架构视图清单")
        return
    if not re.search(r"^\| 视图 \| 适用性/理由 \| 图表位置 \|$", catalog, re.MULTILINE):
        result.errors.append("SOLUTION.md: 架构视图清单 must use 视图 | 适用性/理由 | 图表位置 header")
    rows = solution_table_rows(catalog, "视图")
    names = [name for name, _applicability, _location in rows]
    for name in sorted(duplicate_ids(names)):
        result.errors.append(f"SOLUTION.md: duplicate architecture view {name}")
    for name in sorted(set(names) - set(SOLUTION_VIEW_RULES)):
        result.errors.append(f"SOLUTION.md: unknown architecture view {name}")
    by_name = {name: (applicability, location) for name, applicability, location in rows}
    for name, (title, kind_pattern, expected_kind, mandatory) in SOLUTION_VIEW_RULES.items():
        row = by_name.get(name)
        if row is None:
            result.errors.append(f"SOLUTION.md: missing architecture view assessment {name}")
            continue
        applicability, location = row
        if PLACEHOLDER_RE.search(applicability):
            result.errors.append(f"SOLUTION.md: architecture view {name} needs a concrete applicability reason")
            continue
        applicable = re.fullmatch(r"适用[:：](.+)", applicability)
        not_applicable = re.fullmatch(r"不适用[:：](.+)", applicability)
        if not applicable and not not_applicable:
            result.errors.append(f"SOLUTION.md: architecture view {name} needs 适用/不适用 with a concrete reason")
            continue
        if mandatory and not_applicable:
            result.errors.append(f"SOLUTION.md: architecture view {name} is mandatory")
            continue
        if not_applicable:
            if location != "—":
                result.errors.append(f"SOLUTION.md: non-applicable architecture view {name} must use — location")
            continue
        if location != title:
            result.errors.append(f"SOLUTION.md: architecture view {name} location must be {title}")
            continue
        body = solution_view_body(solution, title)
        if body is None:
            result.errors.append(f"SOLUTION.md: applicable architecture view {name} is missing {title}")
        elif not has_mermaid_diagram(body, kind_pattern) and not (mandatory and has_compact_table(body)):
            result.errors.append(
                f"SOLUTION.md: {title} must contain a Mermaid {expected_kind}"
                + (" or a compact Markdown table" if mandatory else "")
            )


def check_solution_details(root: Path, solution: str, result: Result) -> None:
    catalog = document_section_body_any(solution, LEGACY_DETAIL_TITLES)
    if catalog is None:
        result.errors.append("SOLUTION.md: missing 方案细化清单")
        return
    if not re.search(r"^\| 关注面 \| 适用性/理由 \| (?:方案|设计)落点 \|$", catalog, re.MULTILINE):
        result.errors.append("SOLUTION.md: 方案细化清单 must use 关注面 | 适用性/理由 | 方案落点 header")
    rows = solution_table_rows(catalog, "关注面")
    names = [name for name, _applicability, _location in rows]
    for name in sorted(duplicate_ids(names)):
        result.errors.append(f"SOLUTION.md: duplicate solution detail concern {name}")
    for name in sorted(set(names) - set(SOLUTION_DETAIL_RULES)):
        result.errors.append(f"SOLUTION.md: unknown solution detail concern {name}")
    by_name = {name: (applicability, location) for name, applicability, location in rows}
    for name, mandatory in SOLUTION_DETAIL_RULES.items():
        row = by_name.get(name)
        if row is None:
            result.errors.append(f"SOLUTION.md: missing solution detail assessment {name}")
            continue
        applicability, location = row
        if PLACEHOLDER_RE.search(applicability):
            result.errors.append(f"SOLUTION.md: solution detail {name} needs a concrete applicability reason")
            continue
        applicable = re.fullmatch(r"适用[:：](.+)", applicability)
        not_applicable = re.fullmatch(r"不适用[:：](.+)", applicability)
        if not applicable and not not_applicable:
            result.errors.append(f"SOLUTION.md: solution detail {name} needs 适用/不适用 with a concrete reason")
            continue
        if mandatory and not_applicable:
            result.errors.append(f"SOLUTION.md: solution detail {name} is mandatory")
            continue
        if not_applicable:
            if location != "—":
                result.errors.append(f"SOLUTION.md: non-applicable solution detail {name} must use — location")
            continue
        if not check_locator_list(root, result, f"SOLUTION.md: solution detail {name}", location):
            result.errors.append(f"SOLUTION.md: applicable solution detail {name} needs path.md#heading locators")


def check_implementation_readiness(root: Path, solution: str, result: Result) -> None:
    gate = document_section_body(solution, "实现就绪检查")
    if gate is None:
        result.errors.append("SOLUTION.md: missing 实现就绪检查")
        return
    if not re.search(r"^\| 条件 \| 结论 \| 证据或落点 \|$", gate, re.MULTILINE):
        result.errors.append("SOLUTION.md: 实现就绪检查 must use 条件 | 结论 | 证据或落点 header")
    rows = solution_table_rows(gate, "条件")
    rows = [
        (LEGACY_READINESS_NAMES.get(name, name), conclusion, evidence)
        for name, conclusion, evidence in rows
    ]
    names = [name for name, _conclusion, _evidence in rows]
    for name in sorted(duplicate_ids(names)):
        result.errors.append(f"SOLUTION.md: duplicate implementation readiness condition {name}")
    for name in sorted(set(names) - set(READINESS_RULES)):
        result.errors.append(f"SOLUTION.md: unknown implementation readiness condition {name}")
    by_name = {name: (conclusion, evidence) for name, conclusion, evidence in rows}
    for name, allow_statement in READINESS_RULES.items():
        row = by_name.get(name)
        if row is None:
            result.errors.append(f"SOLUTION.md: missing implementation readiness condition {name}")
            continue
        conclusion, evidence = row
        if conclusion != "通过":
            result.errors.append(f"SOLUTION.md: implementation readiness condition {name} must be 通过")
        if evidence == "—" or PLACEHOLDER_RE.search(evidence):
            result.errors.append(f"SOLUTION.md: implementation readiness condition {name} needs concrete evidence")
            continue
        has_locators = check_locator_list(root, result, f"SOLUTION.md: readiness {name}", evidence)
        if not has_locators and not allow_statement:
            result.errors.append(f"SOLUTION.md: implementation readiness condition {name} needs path.md#heading evidence")


def git_changed_paths(root: Path) -> set[str]:
    try:
        changed = subprocess.run(
            ["git", "diff", "--name-only", "HEAD", "--"],
            cwd=root,
            check=False,
            capture_output=True,
            text=True,
        ).stdout.splitlines()
        return set(changed)
    except OSError:
        return set()


def git_untracked_paths(root: Path) -> set[str]:
    try:
        untracked = subprocess.run(
            ["git", "ls-files", "--others", "--exclude-standard"],
            cwd=root,
            check=False,
            capture_output=True,
            text=True,
        ).stdout.splitlines()
        return set(untracked)
    except OSError:
        return set()


@contextmanager
def staged_checkout(root: Path):
    with tempfile.TemporaryDirectory() as directory:
        snapshot = Path(directory)
        git_dir = subprocess.run(
            ["git", "rev-parse", "--absolute-git-dir"],
            cwd=root,
            check=True,
            capture_output=True,
            text=True,
        ).stdout.strip()
        subprocess.run(
            ["git", "checkout-index", "--all", "--force", f"--prefix={snapshot}/"],
            cwd=root,
            check=True,
        )
        entries = subprocess.run(
            ["git", "ls-files", "--stage", "-z"],
            cwd=root,
            check=True,
            capture_output=True,
            text=True,
        ).stdout.split("\0")
        for entry in filter(None, entries):
            metadata, path = entry.split("\t", 1)
            mode, object_id, _stage = metadata.split()
            if mode != "160000":
                continue
            archive = snapshot / f".gitlink-{object_id}.tar"
            with archive.open("wb") as stream:
                subprocess.run(
                    ["git", "-C", str(root / path), "archive", object_id],
                    check=True,
                    stdout=stream,
                )
            shutil.unpack_archive(archive, snapshot / path, "tar")
            archive.unlink()
        (snapshot / ".git").write_text(f"gitdir: {git_dir}\n", encoding="utf-8")
        yield snapshot


def legacy_cutoff(root: Path, result: Result) -> date | None:
    """Optional CONVENTIONS deadline after which legacy naming is an error.

    Unregistered (the default) keeps the transitional warnings forever;
    a registered past date turns every legacy-name tolerance into errors.
    """
    path = root / "CONVENTIONS.md"
    if not path.is_file():
        return None
    text = read_text_checked(path, result, "CONVENTIONS.md")
    if text is None:
        return None
    loose = LEGACY_CUTOFF_LOOSE_RE.search(text)
    if not loose:
        return None
    match = LEGACY_CUTOFF_RE.search(text)
    if not match:
        result.errors.append("CONVENTIONS.md: legacy 迁移截止 must be YYYY-MM-DD")
        return None
    try:
        return date.fromisoformat(match.group(1))
    except ValueError:
        result.errors.append("CONVENTIONS.md: legacy 迁移截止 must be YYYY-MM-DD")
        return None


def legacy_deadline_passed(result: Result) -> bool:
    return result.legacy_cutoff is not None and date.today() >= result.legacy_cutoff


def check_system_files(root: Path, result: Result, changed: set[str]) -> None:
    for canonical, expected_file in SYSTEM_FILES.items():
        legacy = LEGACY_MAP_FILES.get(canonical)
        path = root / canonical
        if legacy and path.exists() and (root / legacy[0]).exists():
            result.errors.append(
                f"conflict: both {canonical} and legacy {legacy[0]} exist; remove one"
            )
            continue
        name, (doc_type, mutation, id_prefix) = canonical, expected_file
        if not path.exists() and legacy:
            name, doc_type = legacy
            path = root / name
            message = (
                f"legacy map file {name} in use; migrate to {canonical} "
                "via bootstrap --migrate-legacy-maps"
            )
            if legacy_deadline_passed(result):
                result.errors.append(
                    f"legacy migration deadline passed ({result.legacy_cutoff.isoformat()}): {message}"
                )
            else:
                result.warnings.append(message)
        if not path.exists():
            result.errors.append(f"missing: {name}")
            continue
        text = read_text_checked(path, result, name)
        if text is None:
            continue
        fm = parse_frontmatter(text)
        if fm is None:
            result.errors.append(f"{name}: missing frontmatter")
            continue
        expected = {"doc-type": doc_type, "mutation": mutation}
        if id_prefix:
            expected["id-prefix"] = id_prefix
        for key, value in expected.items():
            if fm.get(key) != value:
                result.errors.append(f"{name}: {key} should be {value}, got {fm.get(key)}")
        if fm.get("mutation") not in MUTATIONS:
            result.errors.append(f"{name}: invalid mutation {fm.get('mutation')}")
        if not fm.get("owner"):
            result.errors.append(f"{name}: missing owner")
        if name == "SOLUTION.md":
            verified = fm.get("核对日期")
            if not verified:
                result.warnings.append(
                    "SOLUTION.md: frontmatter lacks 核对日期: YYYY-MM-DD; record the date "
                    "of the last solution-vs-implementation verification"
                )
            elif not re.fullmatch(r"\d{4}-\d{2}-\d{2}", verified):
                result.errors.append(f"SOLUTION.md: 核对日期 must be YYYY-MM-DD, got {verified}")
        if name in APPEND_ONLY_FILES:
            current_entries = decision_entries(text)
            appended = ""
            if name in changed:
                entries_old = decision_entries(head_decision_text(root))
                appended = ""
                if entries_old:
                    failure = decision_transition_failure(entries_old, current_entries)
                    if failure:
                        result.errors.append(f"{name}: append-only content {failure}")
                    else:
                        old_count = len(decision_entry_signatures(entries_old))
                        new_matches = list(C_HEADING_RE.finditer(current_entries))
                        start = new_matches[old_count].start() if len(new_matches) > old_count else len(current_entries)
                        appended = current_entries[start:]
                else:
                    appended = current_entries
            if appended and DECISION_EVIDENCE_RE.search(strip_code_fences(appended)):
                result.errors.append(
                    f"{name}: new decision entry contains implementation evidence; "
                    "code paths, commits, and solution details belong in SOLUTION"
                )


def check_todo_entries(root: Path, result: Result) -> None:
    path = root / "TODO.md"
    if not path.is_file():
        return
    text = read_text_checked(path, result, "TODO.md")
    if text is None:
        return
    for line_number, line in enumerate(text.splitlines(), 1):
        if line.startswith("- ") and not TODO_ENTRY_RE.match(line):
            result.errors.append(
                f"TODO.md:{line_number}: entry needs one valid intake type tag"
            )


def check_core_document_budget(root: Path, result: Result) -> None:
    """Enforce the registered size ceiling on the current-state document layer.

    The ceiling constrains the living documents an agent must re-read per
    session (PRD/SOLUTION/DOMAIN/CONVENTIONS/AGENTS.md); RATIONALE and
    tasks/ are queryable archives and stay out of scope. A registered
    核心文档分片方案 line downgrades the violation to a warning so an
    in-progress reorganization stays visible without blocking work.
    """
    path = root / "CONVENTIONS.md"
    text = read_text_checked(path, result, "CONVENTIONS.md")
    if text is None:
        return
    match = CORE_BUDGET_RE.search(text)
    if not match:
        result.warnings.append(
            "CONVENTIONS.md: 核心文档上限 not registered under AgentMap 本地参数; "
            "the core document size gate stays disabled until it is"
        )
        return
    limit = int(match.group(1)) * CORE_BUDGET_BYTES_PER_TOKEN
    total = 0
    for name in CORE_BUDGET_FILES:
        file_path = root / name
        try:
            if file_path.is_file():
                total += file_path.stat().st_size
        except OSError as error:
            result.errors.append(f"{name}: cannot measure size ({error.__class__.__name__}: {error})")
    if total <= limit:
        return
    detail = (
        f"core documents total {total} bytes (PRD+SOLUTION+DOMAIN+CONVENTIONS+AGENTS.md) "
        f"over the registered limit {match.group(1)} token × {CORE_BUDGET_BYTES_PER_TOKEN} "
        f"bytes = {limit} bytes"
    )
    if CORE_SPLIT_PLAN_RE.search(text):
        result.warnings.append(f"{detail}; the registered 核心文档分片方案 covers the transition")
    else:
        result.errors.append(
            f"{detail}; reorganize the current-state layer or register a "
            "核心文档分片方案 line in CONVENTIONS"
        )


def id_scan_files(root: Path) -> list[Path]:
    paths: list[Path] = []
    for canonical in SYSTEM_FILES:
        if canonical == "CONVENTIONS.md":
            # CONVENTIONS documents the id formats themselves; scanning it
            # would flag the format examples as malformed ids.
            continue
        path = root / canonical
        legacy = LEGACY_MAP_FILES.get(canonical)
        if legacy and (root / legacy[0]).exists():
            if path.exists():
                continue  # conflict is already reported by check_system_files
            path = root / legacy[0]
        if path.is_file():
            paths.append(path)
    tasks_dir = root / "tasks"
    if tasks_dir.is_dir():
        paths.extend(sorted(tasks_dir.rglob("*.md")))
    return paths


def check_id_formats(root: Path, result: Result) -> None:
    """Fail loudly on id-shaped tokens that violate the canonical formats.

    Code blocks are stripped first: format examples inside ``` fences are
    documentation, not references (calibration 2026-11).
    """
    for path in id_scan_files(root):
        relative = path.relative_to(root).as_posix()
        try:
            text = strip_code_fences(path.read_text(encoding="utf-8"))
        except UnicodeDecodeError:
            result.errors.append(
                f"{relative}: file is not valid UTF-8; re-save it with UTF-8 encoding"
            )
            continue
        for family, loose, expected in ID_NEAR_MISS_RULES:
            for mid in sorted(set(loose.findall(text))):
                if not ID_STRICT_VALIDATORS[family](mid):
                    result.errors.append(
                        f"{relative}: invalid {family} id {mid}: expected {expected}"
                    )


# Writing-style warnings enforce the AGENTS.md 写作风格 rule with heuristics:
# one rule per list item, shallow parentheses. The framework canonical
# AGENTS.md is excluded because bootstrap owns it, not project authors.
# Terminal tasks are excluded because they are immutable history and the
# style rule applies to living documents; their warnings could never be
# remediated without violating task immutability.
STYLE_FILES = ("PRD.md", "SOLUTION.md", "DOMAIN.md", "RATIONALE.md", "TODO.md", "CONVENTIONS.md")
# RATIONALE narrative paragraphs are the designated home of prose reasoning.
STYLE_PROSE_EXEMPT_FILES = {"RATIONALE.md", "DECISIONS.md"}
STYLE_LIST_ITEM_MAX_STOPS = 3
STYLE_LIST_ITEM_RE = re.compile(r"^(?:[-*]|\d+\.)\s+")
STYLE_OPENERS = "([（［【"
STYLE_CLOSERS = ")]）］】"
# Closed set of vague hedges and quantities. Keep it a closed list. Some words
# are productive substrings that can match across word boundaries (视情况 in
# 忽视情况, 也许 in 也许诺); such hits stay warning-level review prompts, and
# the known collision families are recorded here rather than promised away.
STYLE_VAGUE_WORDS = (
    "尽量", "酌情", "适当", "也许", "或许", "差不多", "原则上",
    "必要时", "尽快", "视情况", "一些", "等等", "之类",
)
# Negation prefixes flip the meaning of a hedge (不适当 states a hard
# requirement); a hit directly preceded by one of these characters is not
# vague wording.
STYLE_NEGATION_PREFIXES = set("不非无未")
# A long run of CJK characters without particles, connectors, or prepositions
# reads as stacked nouns whose referent cannot be parsed; the threshold is
# deliberately high so normal four-character compounds never trigger it.
# The breaker set stays closed; every addition must be backed by a real
# false positive. 而且把被让使将向从到为以于给每该各中可都 come from the
# postfix calibration (2026-10): predicate chains built on these particles
# were flagged although they read fine. Accepted trade-off: 为/中/到 also
# occur inside compound nouns (行为/中间件/到期), so a pile hinging on them
# splits into shorter runs and stays unflagged.
STYLE_NOUN_STACK_MAX_CHARS = 14
STYLE_NOUN_BREAKERS = set(
    "的了着过与和或之及是不等在并按地得"
    "而且把被让使将向从到为以于给每该各中可都"
)


def style_prose_exempt(path: Path) -> bool:
    return path.name in STYLE_PROSE_EXEMPT_FILES


def strip_inline_noise(text: str) -> str:
    text = re.sub(r"`[^`]*`", "", text)
    return re.sub(r"\((?:https?://[^)]*)\)", "", text)


def max_bracket_depth(text: str) -> int:
    depth = 0
    deepest = 0
    for char in text:
        if char in STYLE_OPENERS:
            depth += 1
            if depth > deepest:
                deepest = depth
        elif char in STYLE_CLOSERS:
            depth = max(0, depth - 1)
    return deepest


def first_vague_word(text: str) -> str | None:
    # 「不适当」「不明确」等否定前缀反转词义，不是模糊表述；命中紧邻否定
    # 前缀时跳过该处继续找，无前缀命中仍照常报告。
    for word in STYLE_VAGUE_WORDS:
        index = text.find(word)
        while index != -1:
            if index == 0 or text[index - 1] not in STYLE_NEGATION_PREFIXES:
                return word
            index = text.find(word, index + 1)
    return None


def max_noun_stack(text: str) -> int:
    longest = 0
    current = 0
    for char in text:
        if "\u4e00" <= char <= "\u9fff" and char not in STYLE_NOUN_BREAKERS:
            current += 1
            if current > longest:
                longest = current
        else:
            current = 0
    return longest


def check_writing_style(root: Path, result: Result, changed: set[str]) -> None:
    # Dirty tree (pre-commit / staged): only flag files inside the pending change
    # (staged or unstaged edits, plus untracked new files) so historical warnings
    # do not repeat on every commit. Clean tree (--report): scan everything as
    # the standing inventory. In staged mode the snapshot worktree points at the
    # real git dir, so git diff HEAD equals the staged change set.
    paths = []
    for name in STYLE_FILES:
        path = root / name
        if path.is_file():
            paths.append(path)
            continue
        legacy = LEGACY_MAP_FILES.get(name)
        if legacy and (root / legacy[0]).is_file():
            paths.append(root / legacy[0])
    tasks_dir = root / "tasks"
    task_paths = set()
    if tasks_dir.is_dir():
        task_entries = sorted(tasks_dir.glob("*.md"))
        paths.extend(task_entries)
        task_paths.update(entry.relative_to(root).as_posix() for entry in task_entries)
    scan = changed | git_untracked_paths(root)
    scan_all = not scan
    for path in paths:
        relative = path.relative_to(root).as_posix()
        if not scan_all and relative not in scan:
            continue
        text = read_text_checked(path, result, relative)
        if text is None:
            continue
        if relative in task_paths:
            state = task_state(text)
            if state in TERMINAL_STATES:
                continue
        in_frontmatter = False
        in_fence = False
        for line_number, line in enumerate(text.splitlines(), 1):
            if line.strip().startswith("```"):
                in_fence = not in_fence
                continue
            if in_fence:
                continue
            if line_number == 1 and line.strip() == "---":
                in_frontmatter = True
                continue
            if in_frontmatter:
                if line.strip() == "---":
                    in_frontmatter = False
                continue
            stripped = line.strip()
            if not stripped or stripped.startswith(("#", "|")):
                continue
            if stripped.startswith(">"):
                stripped = stripped.lstrip(">").strip()
                if not stripped:
                    continue
            noisy = strip_inline_noise(stripped)
            list_match = STYLE_LIST_ITEM_RE.match(noisy)
            if list_match:
                content = noisy[list_match.end():]
                stops = len(re.findall(r"[。；]", content))
                if stops >= STYLE_LIST_ITEM_MAX_STOPS:
                    result.warnings.append(
                        f"{relative}:{line_number}: list item may carry multiple rules; "
                        "split so each line has one condition and one action"
                    )
                    continue
            if not style_prose_exempt(path):
                # One style warning per line: vague wording, then noun stacks,
                # then bracket depth.
                vague = first_vague_word(noisy)
                if vague:
                    result.warnings.append(
                        f'{relative}:{line_number}: vague wording "{vague}"; '
                        "state the exact condition, quantity, or modality"
                    )
                    continue
                if max_noun_stack(noisy) >= STYLE_NOUN_STACK_MAX_CHARS:
                    result.warnings.append(
                        f"{relative}:{line_number}: long noun stack; "
                        "connect the nouns or split the phrase into a sub-list"
                    )
                    continue
            if max_bracket_depth(noisy) >= 2:
                result.warnings.append(
                    f"{relative}:{line_number}: nested parentheses; move long parenthetical content into a sub-list"
                )


def check_traceability(root: Path, result: Result) -> None:
    prd_path = root / "PRD.md"
    solution_path = resolve_map_file(root, "SOLUTION.md")
    domain_path = root / "DOMAIN.md"
    decisions_path = resolve_map_file(root, "RATIONALE.md")
    if not all(path and path.exists() for path in (prd_path, solution_path, domain_path, decisions_path)):
        return

    prd = read_text_checked(prd_path, result, "PRD.md")
    solution = read_text_checked(solution_path, result, solution_path.name)
    domain = read_text_checked(domain_path, result, "DOMAIN.md")
    decisions = read_text_checked(decisions_path, result, decisions_path.name)
    if None in (prd, solution, domain, decisions):
        return
    conventions_path = root / "CONVENTIONS.md"
    conventions = ""
    if conventions_path.is_file():
        conventions = read_text_checked(conventions_path, result, "CONVENTIONS.md") or ""
    prd_plain = strip_code_fences(prd)
    solution_plain = strip_code_fences(solution)
    decisions_plain = strip_code_fences(decisions)
    conventions_plain = strip_code_fences(conventions)
    legacy_requirement_ids = LEGACY_R_HEADING_RE.findall(prd_plain)
    for rid in legacy_requirement_ids:
        result.errors.append(f"PRD.md: legacy requirement id {rid} must migrate to R-gg-nnn before lint")
    requirement_ids = R_HEADING_RE.findall(prd_plain)
    result.requirements = set(requirement_ids)
    if requirement_ids:
        check_solution_views(solution, result)
        check_solution_details(root, solution, result)
        check_implementation_readiness(root, solution, result)
    requirement_groups = REQUIREMENT_GROUP_RE.findall(conventions_plain)
    registered_groups = {group for group, _ in requirement_groups}
    for group in sorted(duplicate_ids([group for group, _ in requirement_groups])):
        result.errors.append(f"CONVENTIONS.md: duplicate requirement group {group}")
    for role in sorted(duplicate_ids([role for _, role in requirement_groups])):
        result.errors.append(f"CONVENTIONS.md: duplicate requirement group role {role}")
    group_numbers = [int(group) for group, _ in requirement_groups]
    if group_numbers != list(range(1, len(group_numbers) + 1)):
        result.errors.append("CONVENTIONS.md: requirement groups must be registered once in 01..nn order")
    for group in sorted({rid[2:4] for rid in requirement_ids} - registered_groups):
        result.errors.append(f"CONVENTIONS.md: missing requirement group {group}")
    for rid in sorted(set(LEGACY_R_ID_RE.findall(solution_plain))):
        result.errors.append(f"SOLUTION.md: legacy requirement reference {rid} must migrate to R-gg-nnn")
    goal_ids = GOAL_RE.findall(prd_plain)
    non_goal_ids = NON_GOAL_RE.findall(prd_plain)
    result.goals = set(goal_ids)
    decision_ids = C_HEADING_RE.findall(decisions_plain)
    result.decision_ids = set(decision_ids)
    old_decisions = head_decision_text(root)
    old_decision_ids = set(C_HEADING_RE.findall(old_decisions))

    superseded: dict[str, str] = {}
    entry_matches = list(C_HEADING_RE.finditer(decisions_plain))
    for index, entry_match in enumerate(entry_matches):
        block_end = entry_matches[index + 1].start() if index + 1 < len(entry_matches) else len(decisions_plain)
        block = decisions_plain[entry_match.end():block_end]
        for declaration in SUPERSEDED_DECLARATION_RE.findall(block):
            if declaration == entry_match.group(1):
                result.errors.append(f"RATIONALE.md: decision {declaration} cannot supersede itself")
            elif declaration in superseded:
                result.errors.append(f"RATIONALE.md: decision {declaration} is superseded more than once")
            else:
                superseded[declaration] = entry_match.group(1)
    for cid, successor in sorted(superseded.items()):
        if cid not in result.decision_ids:
            result.errors.append(f"RATIONALE.md: superseded decision {cid} does not exist")
    result.superseded_decisions = superseded

    for rid in sorted(duplicate_ids(requirement_ids)):
        result.errors.append(f"PRD.md: duplicate requirement id {rid}")
    for gid in sorted(duplicate_ids(goal_ids)):
        result.errors.append(f"PRD.md: duplicate goal id {gid}")
    for ngid in sorted(duplicate_ids(non_goal_ids)):
        result.errors.append(f"PRD.md: duplicate non-goal id {ngid}")
    for cid in sorted(duplicate_ids(decision_ids)):
        result.errors.append(f"RATIONALE.md: duplicate decision id {cid}")
    for cid in sorted(set(decision_ids) - old_decision_ids):
        if re.fullmatch(r"C-\d{3}[A-Z]", cid):
            result.errors.append(f"RATIONALE.md: new decision id {cid} cannot use a legacy suffix")
    decision_order = []
    for cid in decision_ids:
        match = re.fullmatch(r"C-(\d{3})([A-Z]?)", cid)
        if match:
            decision_order.append((int(match.group(1)), match.group(2) or ""))
    if decision_order != sorted(decision_order):
        result.errors.append("RATIONALE.md: decision ids are not in chronological order")

    modules = solution_modules(solution_plain)
    for module in modules:
        count = len(re.findall(rf"^-\s*\*\*{re.escape(module)}\*\*\s*[:：]", domain, re.MULTILINE))
        if count != 1:
            result.errors.append(f"DOMAIN.md: solution module {module} must be defined exactly once, got {count}")
    trace_body = solution_trace_body(solution)
    trace_rows = solution_trace_rows(trace_body)
    trace_ids = re.findall(r"^\|\s*(R-\d{2}-\d{3})\s*\|", trace_body or "", re.MULTILINE)
    if trace_body is not None and not re.search(
        r"^\|\s*需求\s*\|\s*主责子系统\s*\|\s*(?:方案|设计)落点\s*\|\s*实现位置\s*\|\s*$",
        trace_body,
        re.MULTILINE,
    ):
        result.errors.append("SOLUTION.md: 需求追溯索引 must use 需求 | 主责子系统 | 方案落点 | 实现位置 header")
    traces: dict[str, list[tuple[str, str, str]]] = {}
    for rid, subsystem, solution_locations, implementation_locations in trace_rows:
        traces.setdefault(rid, []).append((subsystem, solution_locations, implementation_locations))
    requirement_sections = sections(prd_plain, R_HEADING_RE)
    used_goals: set[str] = set()
    for rid, body in requirement_sections.items():
        if not EARS_RE.search(body):
            result.errors.append(f"PRD.md: {rid} must have at least one EARS acceptance criterion")
        goals = re.findall(r"^- 关联目标:\s*(G-\d+)\s*$", body, re.MULTILINE)
        solutions = re.findall(r"^- 关联(?:方案|设计):\s*(.+?)\s*$", body, re.MULTILINE)
        if len(goals) != 1:
            result.errors.append(f"PRD.md: {rid} must have exactly one 关联目标")
        elif goals[0] not in result.goals:
            result.errors.append(f"PRD.md: {rid} references missing goal {goals[0]}")
        else:
            used_goals.add(goals[0])
        module_covered = False
        if len(solutions) != 1:
            result.errors.append(f"PRD.md: {rid} must have exactly one 关联方案")
        elif solutions[0] not in modules:
            result.errors.append(f"PRD.md: {rid} references missing solution module {solutions[0]}")
        elif rid not in expand_requirement_ids(modules[solutions[0]]):
            result.errors.append(f"SOLUTION.md: module {solutions[0]} does not declare {rid}")
        else:
            module_covered = True

        rows = traces.get(rid, [])
        if trace_ids.count(rid) != 1:
            result.errors.append(f"SOLUTION.md: {rid} must have exactly one 需求追溯索引 row")
        elif len(rows) != 1:
            result.errors.append(f"SOLUTION.md: {rid} trace row must have four non-empty columns")
        elif len(solutions) == 1 and rows[0][0] != solutions[0]:
            result.errors.append(
                f"SOLUTION.md: {rid} trace subsystem {rows[0][0]} does not match PRD 关联方案 {solutions[0]}"
            )
        elif module_covered:
            result.solution_covered.add(rid)
        forbidden_metadata = re.search(
            r"^-\s*(验证|测试|代码|实现|证据|task|commit)\s*:", body, re.MULTILINE | re.IGNORECASE
        )
        forbidden_reference = IMPLEMENTATION_EVIDENCE_RE.search(body)
        if forbidden_metadata or forbidden_reference:
            result.errors.append(
                f"PRD.md: {rid} contains implementation evidence; keep code, tests, tasks, and commits below SOLUTION"
            )
        for cid in C_ID_RE.findall(
            "\n".join(re.findall(r"^- 出处:\s*(.+)$", body, re.MULTILINE))
        ):
            if cid not in decision_ids:
                result.errors.append(f"PRD.md: {rid} references missing decision {cid}")
            elif cid in superseded:
                result.errors.append(
                    f"PRD.md: {rid} references superseded decision {cid} superseded by {superseded[cid]}"
                )

    for goal in sorted(result.goals - used_goals):
        result.errors.append(f"PRD.md: {goal} has no requirement")
    for rid in sorted(expand_requirement_ids(solution_plain, result) - result.requirements):
        result.errors.append(f"SOLUTION.md: references missing requirement {rid}")
    for cid in sorted(set(C_ID_RE.findall(solution_plain)) - set(decision_ids)):
        result.errors.append(f"SOLUTION.md: references missing decision {cid}")
    for cid in sorted(set(C_ID_RE.findall(solution_plain)) & set(superseded)):
        result.errors.append(
            f"SOLUTION.md: references superseded decision {cid} superseded by {superseded[cid]}"
        )


def task_state(text: str) -> str | None:
    """Read the task lifecycle state from its header block only.

    The canonical position is right after the H1 title and before the first
    `## ` section (write_fixture emits exactly that shape). A full-text search
    would let any prose line `状态: completed` inside a body section hijack
    the machine state — for example a task quoting another task's lifecycle —
    so everything from the first section heading on is ignored here.
    """
    header = re.split(r"^## ", text, maxsplit=1, flags=re.MULTILINE)[0]
    match = re.search(
        r"^状态:\s*(active|completed|abandoned|superseded)\s*$", header, re.MULTILINE
    )
    return match.group(1) if match else None


def is_commit_evidence_repair(root: Path, old_text: str, new_text: str) -> bool:
    """True when a terminal-task edit only swaps unreachable commit-evidence
    hashes for reachable ones (audit-chain repair after an upstream amend).

    The immutability contract protects the audit record, while completed-task
    evidence must resolve to commits reachable from HEAD; once an amend
    destroys a referenced commit the two rules cannot both hold. This
    admission resolves that conflict narrowly: same terminal state, same line
    count, only lines matching the `- commit:` evidence shape may differ and
    only at identical line positions (evidence lines cannot move between
    sections), each differing position pairing one unreachable old hash with
    one reachable new hash. The shape check is line-local and section-blind:
    any line carrying the evidence shape qualifies wherever it sits in the
    document, so prose lines that happen to match are inside the coverage too.
    """
    old_state = task_state(old_text)
    if old_state is None or old_state not in TERMINAL_STATES:
        return False
    if task_state(new_text) != old_state:
        return False
    old_lines = old_text.splitlines()
    new_lines = new_text.splitlines()
    if len(old_lines) != len(new_lines):
        return False
    replacements: list[tuple[str, str]] = []
    for old_line, new_line in zip(old_lines, new_lines):
        if old_line == new_line:
            continue
        old_match = COMMIT_EVIDENCE_LINE_RE.fullmatch(old_line)
        new_match = COMMIT_EVIDENCE_LINE_RE.fullmatch(new_line)
        if not old_match or not new_match:
            return False
        replacements.append((old_match["hash"], new_match["hash"]))
    if not replacements:
        return False
    for old_hash, new_hash in replacements:
        if old_hash == new_hash:
            return False
        if resolves_to_reachable_commit(root, old_hash):
            return False
        if not resolves_to_reachable_commit(root, new_hash):
            return False
    return True


def git_ref_text(root: Path, ref: str, relative: Path) -> str | None:
    try:
        return subprocess.run(
            ["git", "show", f"{ref}:{relative.as_posix()}"],
            cwd=root,
            check=True,
            capture_output=True,
            text=True,
        ).stdout
    except (OSError, subprocess.CalledProcessError):
        return None


def git_head_text(root: Path, relative: Path) -> str | None:
    return git_ref_text(root, "HEAD", relative)


def resolves_to_reachable_commit(root: Path, value: str) -> bool:
    resolved = subprocess.run(
        ["git", "rev-parse", "--verify", f"{value}^{{commit}}"],
        cwd=root,
        check=False,
        capture_output=True,
        text=True,
    )
    return bool(resolved.stdout.strip()) and is_ancestor(root, resolved.stdout.strip(), "HEAD")


def git_merge_head(root: Path) -> str | None:
    try:
        return subprocess.run(
            ["git", "rev-parse", "--verify", "MERGE_HEAD"],
            cwd=root,
            check=True,
            capture_output=True,
            text=True,
        ).stdout.strip()
    except (OSError, subprocess.CalledProcessError):
        return None


def task_paths_at_ref(root: Path, ref: str) -> list[Path]:
    try:
        names = subprocess.run(
            ["git", "ls-tree", "-r", "--name-only", ref, "--", "tasks"],
            cwd=root,
            check=True,
            capture_output=True,
            text=True,
        ).stdout.splitlines()
    except (OSError, subprocess.CalledProcessError):
        return []
    return [Path(name) for name in names if TASK_NAME_RE.match(Path(name).name)]


def ref_task_texts(root: Path, ref: str) -> dict[Path, str]:
    texts = {}
    for path in task_paths_at_ref(root, ref):
        text = git_ref_text(root, ref, path)
        if text is not None:
            texts[path] = text
    return texts


def commit_parents(root: Path, commit: str) -> list[str]:
    result = subprocess.run(
        ["git", "rev-list", "--parents", "-n", "1", commit],
        cwd=root,
        check=True,
        capture_output=True,
        text=True,
    ).stdout.split()
    return result[1:]


def adoption_commit(root: Path, tips: list[str]) -> str | None:
    commits = subprocess.run(
        [
            "git",
            "log",
            "--reverse",
            "--diff-filter=A",
            "--format=%H",
            *tips,
            "--",
            "tools/agentmap_lint.py",
        ],
        cwd=root,
        check=False,
        capture_output=True,
        text=True,
    ).stdout.splitlines()
    return commits[0] if commits else None


def is_ancestor(root: Path, ancestor: str, descendant: str) -> bool:
    return (
        subprocess.run(
            ["git", "merge-base", "--is-ancestor", ancestor, descendant],
            cwd=root,
            check=False,
            capture_output=True,
        ).returncode
        == 0
    )


def outgoing_push_lines(root: Path, input_text: str, result: Result) -> list[list[str]]:
    lines: list[list[str]] = []
    seen: set[str] = set()
    for line in input_text.splitlines():
        fields = line.split()
        if len(fields) != 4:
            result.errors.append(f"pre-push: malformed ref update: {line}")
            continue
        _local_ref, local_sha, _remote_ref, remote_sha = fields
        if local_sha == "0" * 40:
            continue
        command = ["git", "rev-list", "--reverse"]
        if remote_sha == "0" * 40:
            command.extend([local_sha, "--not", "--remotes"])
        else:
            command.append(f"{remote_sha}..{local_sha}")
        history = subprocess.run(
            command,
            cwd=root,
            check=False,
            capture_output=True,
            text=True,
        )
        if history.returncode != 0:
            result.errors.append(f"pre-push: cannot resolve outgoing range for {local_sha}")
            continue
        line_commits: list[str] = []
        for commit in history.stdout.splitlines():
            if commit not in seen:
                seen.add(commit)
                line_commits.append(commit)
        lines.append(line_commits)
    return lines


def ref_decision_entry(root: Path, ref: str) -> tuple[str, str] | None:
    for name in APPEND_ONLY_FILES:
        text = git_ref_text(root, ref, Path(name))
        if text is not None:
            return name, text
    return None


def check_history_transition(root: Path, result: Result, parent: str, commit: str, check_additions: bool) -> None:
    old_entry = ref_decision_entry(root, parent)
    new_entry = ref_decision_entry(root, commit)
    if check_additions and old_entry and old_entry[1]:
        old_name, old_text = old_entry
        if new_entry is None:
            result.errors.append(f"{commit[:12]}: {old_name} removed existing history")
        else:
            failure = decision_transition_failure(decision_entries(old_text), decision_entries(new_entry[1]))
            if failure:
                result.errors.append(f"{commit[:12]}: {old_name} {failure}")
    if check_additions and new_entry is not None:
        old_ids = set(C_HEADING_RE.findall(decision_entries(old_entry[1]))) if old_entry else set()
        for cid in set(C_HEADING_RE.findall(decision_entries(new_entry[1]))) - old_ids:
            if re.fullmatch(r"C-\d{3}[A-Z]", cid):
                result.errors.append(f"{commit[:12]}: new decision id {cid} cannot use a legacy suffix")

    old_tasks = ref_task_texts(root, parent)
    new_tasks = ref_task_texts(root, commit)
    for path, old_text in old_tasks.items():
        if task_state(old_text) not in TERMINAL_STATES:
            continue
        if new_tasks.get(path) == old_text:
            continue
        if is_commit_evidence_repair(root, old_text, new_tasks.get(path, "")):
            continue
        result.errors.append(f"{commit[:12]}: {path} changed after reaching a terminal state")

    if not check_additions:
        return
    for path, text in new_tasks.items():
        if task_state(text) not in TERMINAL_STATES or path in old_tasks:
            continue
        result.errors.append(f"{commit[:12]}: {path} was created directly in a terminal state")


def check_outgoing_history(root: Path, result: Result, input_text: str) -> None:
    # The adoption baseline is shared across the whole push: the earliest
    # commit that added tools/agentmap_lint.py anywhere in the outgoing
    # tips' union history. is_ancestor(baseline, commit) is true exactly
    # when that add sits in the commit's own history, so one O(history)
    # walk replaces the former per-commit history scans (O(commits ×
    # history) on large pushes).
    lines = outgoing_push_lines(root, input_text, result)
    total = sum(len(commits) for commits in lines)
    tips = [commits[-1] for commits in lines if commits]
    baseline = adoption_commit(root, tips) if tips else None
    baseline_seen = False
    for commits in lines:
        for commit in commits:
            if baseline is None or not is_ancestor(root, baseline, commit):
                # Commits predating the tool are outside the audit; skipping
                # them is only legitimate when another outgoing commit
                # establishes the adoption baseline, which the post-loop
                # check enforces.
                continue
            baseline_seen = True
            if commit == baseline:
                continue
            parents = commit_parents(root, commit)
            for index, parent in enumerate(parents):
                check_history_transition(root, result, parent, commit, check_additions=index == 0)
    if total and not baseline_seen:
        result.errors.append(
            "pre-push: no outgoing commit has tools/agentmap_lint.py in its history; "
            "the outgoing history audit cannot establish an adoption baseline — "
            "commit the tool into the pushed history first"
        )


def historical_task_ids(root: Path, merge_head: str | None = None) -> set[str]:
    try:
        refs = ["HEAD", merge_head] if merge_head else ["HEAD"]
        history_names = subprocess.run(
            ["git", "log", *refs, "--format=", "--name-only", "--", "tasks"],
            cwd=root,
            check=False,
            capture_output=True,
            text=True,
        ).stdout.splitlines()
        current_names = subprocess.run(
            ["git", "ls-tree", "-r", "--name-only", "HEAD", "--", "tasks"],
            cwd=root,
            check=False,
            capture_output=True,
            text=True,
        ).stdout.splitlines()
    except OSError:
        return set()
    task_ids = set()
    for name in history_names + current_names:
        match = TASK_NAME_RE.match(Path(name).name)
        if match:
            task_ids.add(match.group(1))
    return task_ids


def verification_matrix_start(root: Path, result: Result) -> int | None:
    path = root / "CONVENTIONS.md"
    if not path.is_file():
        return None
    text = read_text_checked(path, result, "CONVENTIONS.md")
    if text is None:
        return None
    match = re.search(r"^-\s*验证矩阵起始 task:\s*T-(\d{3})\s*$", text, re.MULTILINE)
    if not match:
        result.errors.append("CONVENTIONS.md: missing 验证矩阵起始 task: T-nnn")
        return None
    start = int(match.group(1))
    old = git_head_text(root, Path("CONVENTIONS.md"))
    old_match = (
        re.search(r"^-\s*验证矩阵起始 task:\s*T-(\d{3})\s*$", old, re.MULTILINE)
        if old
        else None
    )
    if old_match and start > int(old_match.group(1)):
        result.errors.append("CONVENTIONS.md: 验证矩阵起始 task cannot move forward")
    return start


def code_review_start(root: Path, result: Result) -> int | None:
    path = root / "CONVENTIONS.md"
    if not path.is_file():
        return None
    text = read_text_checked(path, result, "CONVENTIONS.md")
    if text is None:
        return None
    match = re.search(
        r"^-\s*代码审核起始 task:\s*T-(\d{3})\s*$",
        text,
        re.MULTILINE,
    )
    if not match:
        result.errors.append("CONVENTIONS.md: missing 代码审核起始 task: T-nnn")
        return None
    start = int(match.group(1))
    old = git_head_text(root, Path("CONVENTIONS.md"))
    old_match = (
        re.search(r"^-\s*代码审核起始 task:\s*T-(\d{3})\s*$", old, re.MULTILINE)
        if old
        else None
    )
    if old_match and start > int(old_match.group(1)):
        result.errors.append("CONVENTIONS.md: 代码审核起始 task cannot move forward")
    return start


def agentmap_spec_version(root: Path, result: Result) -> int:
    """CONVENTIONS 登记的规范版本：1 = 全量矩阵与独立审核，2 = micro/standard/high 分级。"""
    path = root / "CONVENTIONS.md"
    if not path.is_file():
        return 1
    text = read_text_checked(path, result, "CONVENTIONS.md")
    if text is None:
        return 1
    match = re.search(
        r"^-\s*agentmap 规范版本:\s*(\d+)\s*$",
        text,
        re.MULTILINE,
    )
    if match is None:
        result.warnings.append(
            "CONVENTIONS.md: missing agentmap 规范版本, linting with v1 rules; "
            "bootstrap upgrade registers 规范版本: 2"
        )
        return 1
    version = int(match.group(1))
    if version not in (1, 2):
        result.errors.append("CONVENTIONS.md: agentmap 规范版本 must be 1 or 2")
        return 1
    return version


REVIEW_EVIDENCE_LABELS = ("审核方", "目的理解", "执行方式", "问题与修复", "复审结论")


def check_review_evidence(root: Path, result: Result, path: Path, evidence: str) -> None:
    matches = list(re.finditer(r"^-[ \t]*review:[ \t]*(.*)$", evidence, re.MULTILINE))
    if len(matches) != 1 or matches[0].group(1).strip():
        result.errors.append(
            f"{path.relative_to(root)}: review evidence must be one structured block"
        )
        return

    review = matches[0]
    lines: list[str] = []
    for line in evidence[review.end():].splitlines():
        if re.match(r"^-[ \t]+\S", line):
            break
        lines.append(line)
    section = "\n".join(lines)
    for label in REVIEW_EVIDENCE_LABELS:
        if not re.search(rf"^[ \t]+-[ \t]*{re.escape(label)}:[ \t]*\S", section, re.MULTILINE):
            result.errors.append(
                f"{path.relative_to(root)}: review evidence needs {label}"
            )


def verification_matrix_rows(text: str) -> tuple[str | None, list[tuple[str, str, str]]]:
    match = re.search(r"^## 验证矩阵\s*$([\s\S]*?)(?=^##\s|\Z)", text, re.MULTILINE)
    if not match:
        return None, []
    lines = [line.strip() for line in match.group(1).splitlines() if line.strip()]
    header = lines[0] if lines else None
    rows: list[tuple[str, str, str]] = []
    for line in lines[1:]:
        if re.fullmatch(r"\|?\s*:?-+\s*\|\s*:?-+\s*\|\s*:?-+\s*\|?", line):
            continue
        cells = [cell.strip() for cell in line.strip("|").split("|")]
        if len(cells) == 3:
            rows.append((cells[0], cells[1], cells[2]))
    return header, rows


def check_task_sections(
    root: Path, result: Result, path: Path, text: str, require_matrix: bool, risk_level: str
) -> None:
    relative = path.relative_to(root).as_posix()
    # micro 档只保留 背景与目标：差距评估/收敛方案/测试计划对行为不变的
    # 变更是仪式性写作，强制非空只会诱导编造内容；micro 的判断点改为
    # 终态证据中的 风险自评 行（见 completed 证据检查）。
    required_sections = (
        ("背景与目标",)
        if risk_level == "micro"
        else ("背景与目标", "差距评估", "收敛方案", "测试计划")
    )
    for heading in required_sections:
        match = re.search(rf"^## {heading}\s*$([\s\S]*?)(?=^##\s|\Z)", text, re.MULTILINE)
        if not match or not match.group(1).strip():
            result.errors.append(f"{relative}: missing non-empty {heading}")
    headings = ("验证矩阵", "终态与证据") if require_matrix else ("终态与证据",)
    for heading in headings:
        if not re.search(rf"^## {heading}\s*$", text, re.MULTILINE):
            result.errors.append(f"{relative}: missing {heading}")


def check_verification_matrix(root: Path, result: Result, path: Path, text: str) -> None:
    relative = path.relative_to(root).as_posix()
    header, rows = verification_matrix_rows(text)
    if header != "| 维度 | 适用性/理由 | 可执行证据 |":
        result.errors.append(
            f"{relative}: 验证矩阵 must use 维度 | 适用性/理由 | 可执行证据 header"
        )
    dimensions = [dimension for dimension, _applicability, _evidence in rows]
    if len(dimensions) != len(set(dimensions)):
        result.errors.append(f"{relative}: 验证矩阵 dimensions must be unique")
        return
    missing_dimensions = sorted(REQUIRED_VERIFICATION_DIMENSIONS - set(dimensions))
    if missing_dimensions:
        result.errors.append(
            f"{relative}: 验证矩阵 missing baseline dimensions: {', '.join(missing_dimensions)}"
        )
        return
    for dimension, applicability, evidence in rows:
        if PLACEHOLDER_RE.search(f"{applicability} {evidence}"):
            result.errors.append(f"{relative}: 验证矩阵 {dimension} cannot use placeholder evidence")
        not_applicable = re.fullmatch(r"不适用[:：](.+)", applicability)
        if not_applicable:
            if not not_applicable.group(1).strip():
                result.errors.append(f"{relative}: 验证矩阵 {dimension} needs a concrete N/A reason")
            continue
        if not re.fullmatch(r"适用[:：].+", applicability):
            result.errors.append(f"{relative}: 验证矩阵 {dimension} needs 适用 or 不适用 with reason")
            continue
        references = re.findall(r"`([^`]+)`", evidence)
        if not references:
            result.errors.append(f"{relative}: 验证矩阵 {dimension} needs executable evidence")
            continue
        fixture_references = 0
        consumer_references = 0
        for reference in references:
            separator = "::" if "::" in reference else "#" if "#" in reference else None
            if separator is None:
                result.errors.append(f"{relative}: invalid evidence reference {reference}")
                continue
            file_name, anchor = reference.rsplit(separator, 1)
            target = Path(file_name)
            if target.is_absolute() or ".." in target.parts:
                result.errors.append(f"{relative}: unsafe evidence path {file_name}")
                continue
            target_path = root / target
            if not target_path.is_file():
                result.errors.append(f"{relative}: missing evidence file {file_name}")
                continue
            try:
                target_text = target_path.read_text(encoding="utf-8")
            except UnicodeDecodeError:
                result.errors.append(f"{relative}: evidence file is not text {file_name}")
                continue
            if not anchor or anchor not in target_text:
                result.errors.append(f"{relative}: missing evidence anchor {reference}")
            if separator == "#":
                fixture_references += 1
            else:
                consumer_references += 1
        if fixture_references and not consumer_references:
            result.errors.append(
                f"{relative}: 验证矩阵 {dimension} fixture evidence needs a consumer"
            )


def check_tasks(root: Path, result: Result, changed: set[str]) -> None:
    tasks_dir = root / "tasks"
    if not tasks_dir.is_dir():
        result.errors.append("missing: tasks/")
        return
    try:
        tracked_lifecycle = subprocess.run(
            ["git", "grep", "-l", r"^mutation: lifecycle$", "HEAD", "--", "tasks/*.md"],
            cwd=root,
            check=False,
            capture_output=True,
            text=True,
        ).stdout.splitlines()
    except OSError:
        tracked_lifecycle = []
    merge_head = git_merge_head(root)
    for entry in tracked_lifecycle:
        relative = entry[5:] if entry.startswith("HEAD:") else entry
        old = git_head_text(root, Path(relative))
        if old and task_state(old) in TERMINAL_STATES and not (root / relative).is_file():
            result.errors.append(f"{relative}: terminal task was deleted or moved")
    counts = {"active": 0, "completed": 0, "abandoned": 0, "superseded": 0}
    historical_ids = historical_task_ids(root, merge_head)
    new_task_ids: list[str] = []
    task_ids: list[str] = []
    states: dict[str, str] = {}
    matrix_start = verification_matrix_start(root, result)
    review_start = code_review_start(root, result)
    spec_version = agentmap_spec_version(root, result)
    for path in sorted(tasks_dir.glob("*.md")):
        name_match = TASK_NAME_RE.match(path.name)
        relative = path.relative_to(root)
        old = git_head_text(root, relative)
        if old is None and merge_head:
            old = git_ref_text(root, merge_head, relative)
        if not name_match and not (LEGACY_TASK_NAME_RE.match(path.name) and old is not None):
            result.errors.append(
                f"tasks/{path.name}: bad name, expect T-nnn-YYYYMMDD-slug.md"
            )
        elif (
            not name_match
            and legacy_deadline_passed(result)
        ):
            result.errors.append(
                f"tasks/{path.name}: legacy task name outlived the legacy 迁移截止 "
                f"({result.legacy_cutoff.isoformat()}); rename to T-nnn-YYYYMMDD-slug.md"
            )
        text = read_text_checked(path, result, f"tasks/{path.name}")
        if text is None:
            continue
        current_state = task_state(text)
        fm = parse_frontmatter(text)
        if fm is None or fm.get("doc-type") != "task":
            result.errors.append(f"tasks/{path.name}: doc-type should be task")
            continue
        require_review = False
        require_review_labels = False
        require_self_check = False
        risk: list[str] = []
        if name_match and fm.get("id") != name_match.group(1):
            result.errors.append(
                f"tasks/{path.name}: id should be {name_match.group(1)}, got {fm.get('id')}"
            )
        if name_match:
            task_id = name_match.group(1)
            task_ids.append(task_id)
            result.task_line_counts[task_id] = len(text.splitlines())
            within_scope = matrix_start is not None and int(task_id[2:]) >= matrix_start
            allowed_risk = "micro|standard|high" if spec_version >= 2 else "standard|high"
            risk = re.findall(rf"^风险等级:\s*({allowed_risk})\s*$", text, re.MULTILINE)
            risk_level = risk[0] if len(risk) == 1 else "standard"
            require_matrix = within_scope
            require_review = review_start is not None and int(task_id[2:]) >= review_start
            if spec_version >= 2:
                if within_scope and len(risk) != 1:
                    result.errors.append(
                        f"tasks/{path.name}: needs exactly one 风险等级: micro, standard or high"
                    )
                require_matrix = within_scope and risk_level != "micro"
                require_review = require_review and risk_level in ("standard", "high")
                require_review_labels = require_review and risk_level == "high"
                require_self_check = within_scope and risk_level == "standard"
            else:
                require_review_labels = require_review
                if require_review and len(risk) != 1:
                    result.errors.append(f"tasks/{path.name}: needs exactly one 风险等级: standard or high")
            check_task_sections(root, result, path, text, require_matrix, risk_level)
            if old is None:
                new_task_ids.append(task_id)
            if require_matrix and current_state not in TERMINAL_STATES:
                check_verification_matrix(root, result, path, text)
        if fm.get("mutation") != "lifecycle":
            result.errors.append(f"tasks/{path.name}: mutation should be lifecycle")
        state = current_state
        if state is None:
            result.errors.append(f"tasks/{path.name}: missing valid 状态")
            continue
        counts[state] += 1
        if state == "active":
            for rid in sorted(set(LEGACY_R_ID_RE.findall(text))):
                result.errors.append(
                    f"tasks/{path.name}: active task legacy requirement reference {rid} must migrate to R-gg-nnn"
                )
        if not (old and task_state(old) in TERMINAL_STATES):
            for cid in sorted(set(C_ID_RE.findall(strip_code_fences(text))) - result.decision_ids):
                result.errors.append(f"tasks/{path.name}: references missing decision {cid}")
        if name_match:
            states[name_match.group(1)] = state
        if state in TERMINAL_STATES:
            terminal = re.search(r"^## 终态与证据\s*$([\s\S]*)", text, re.MULTILINE)
            if not terminal or not terminal.group(1).strip():
                result.errors.append(f"tasks/{path.name}: terminal task needs 终态与证据")
            elif state == "completed":
                evidence = terminal.group(1)
                labels = ["实现", "测试", "commit"]
                if old is None or task_state(old) not in TERMINAL_STATES:
                    labels.append("SOLUTION 对照")
                if risk_level == "micro":
                    # micro 免矩阵/免审核/免自查清单，风险自评行是它唯一的
                    # 判断点：一句话说明为何行为不变、为何 micro 足够
                    labels.append("风险自评")
                for label in labels:
                    if not re.search(rf"^-\s*{label}:\s*\S", evidence, re.MULTILINE):
                        result.errors.append(
                            f"tasks/{path.name}: completed task needs {label} evidence"
                        )
                # hash 提取用 hex 字符类而非 \S+：全角括号紧跟 hash（「54f4309（说明）」）
                # 会被 \S+ 整体吞掉再被 fullmatch 拒绝，误伤合法格式
                # 证据值逐行验证而非 findall 后 all()：占位值（如「待补」）不产出
                # hex，findall 结果为空列表、all() 空集为真，completed 任务即可
                # 用占位证据蒙混过关；改成逐行后非 hash 开头的值直接报错
                commit_lines = re.findall(r"^-\s*commit:\s*(\S.*)$", evidence, re.MULTILINE)
                for evidence_line in commit_lines:
                    hash_match = re.match(r"[0-9a-f]{7,40}\b", evidence_line)
                    if hash_match is None:
                        result.errors.append(
                            f"tasks/{path.name}: commit evidence line is not a commit"
                            f" hash: {evidence_line}"
                        )
                    elif not resolves_to_reachable_commit(root, hash_match.group(0)):
                        result.errors.append(
                            f"tasks/{path.name}: commit evidence must resolve to a reachable commit"
                        )
                if require_review and not re.search(
                    r"^-[ \t]*review:[ \t]*(?:\S.*)?$", evidence, re.MULTILINE
                ):
                    result.errors.append(
                        f"tasks/{path.name}: completed task needs independent code review evidence"
                    )
                elif require_review_labels and (old is None or task_state(old) not in TERMINAL_STATES):
                    check_review_evidence(root, result, path, evidence)
                elif require_self_check and (old is None or task_state(old) not in TERMINAL_STATES):
                    checklist = re.search(
                        r"^## 自查清单\s*$([\s\S]*?)(?=^##\s|\Z)", text, re.MULTILINE
                    )
                    items = (
                        re.findall(r"^[ \t]*-[ \t]+\S", checklist.group(1), re.MULTILINE)
                        if checklist
                        else []
                    )
                    if len(items) < 3:
                        result.errors.append(
                            f"tasks/{path.name}: completed standard task needs 自查清单"
                            " with at least three items"
                        )
            elif state == "abandoned" and not re.search(
                r"^-\s*原因:\s*\S", terminal.group(1), re.MULTILINE
            ):
                result.errors.append(f"tasks/{path.name}: abandoned task needs 原因")
            elif state == "superseded" and not re.search(
                r"^-\s*后继:\s*\S", terminal.group(1), re.MULTILINE
            ):
                result.errors.append(f"tasks/{path.name}: superseded task needs 后继")
        changed_old = old if relative.as_posix() in changed else None
        if changed_old and parse_frontmatter_text(changed_old).get("mutation") == "lifecycle":
            old_state = task_state(changed_old)
            if (
                old_state in TERMINAL_STATES
                and changed_old != text
                and not is_commit_evidence_repair(root, changed_old, text)
            ):
                result.errors.append(f"tasks/{path.name}: terminal task is immutable")
    for task_id in sorted(duplicate_ids(task_ids)):
        result.errors.append(f"tasks/: duplicate task id {task_id}")
    for task_id in sorted(set(new_task_ids) & historical_ids):
        result.errors.append(f"tasks/: reused task id {task_id}")
    result.tasks = counts
    result.task_states = states


def parse_frontmatter_text(text: str) -> dict[str, str]:
    match = re.match(r"^---\n(.*?)\n---\n", text, re.DOTALL)
    if not match:
        return {}
    fields: dict[str, str] = {}
    for line in match.group(1).splitlines():
        if ":" in line:
            key, _, value = line.partition(":")
            fields[key.strip()] = value.strip()
    return fields


def test_anchor_patterns(root: Path, result: Result) -> list[str]:
    path = root / "CONVENTIONS.md"
    if not path.is_file():
        return []
    text = read_text_checked(path, result, "CONVENTIONS.md")
    if text is None:
        return []
    values = re.findall(
        r"^-\s*测试锚点路径:\s*(.+?)\s*$", text, re.MULTILINE
    )
    return [pattern.strip() for value in values for pattern in value.split(";") if pattern.strip()]


def is_test_file(path: Path, patterns: list[str]) -> bool:
    if any(fnmatchcase(path.as_posix(), pattern) for pattern in patterns):
        return not any(part in IGNORED_PARTS for part in path.parts)
    if path.suffix.lower() not in CODE_SUFFIXES or any(part in IGNORED_PARTS for part in path.parts):
        return False
    lowered = [part.lower() for part in path.parts]
    stem = path.stem.lower()
    return (
        any(part in {"test", "tests", "spec", "specs"} for part in lowered)
        or stem.startswith("test_")
        or stem.endswith(("_test", ".spec", ".test"))
    )


def test_anchor_text(path: Path, text: str, patterns: list[str]) -> str | None:
    if is_test_file(path, patterns):
        return text
    if path.suffix.lower() == ".rs":
        marker = re.search(r"^\s*#\[cfg\(test\)\]", text, re.MULTILINE)
        if marker:
            return text[marker.start() :]
    return None


def tracked_candidates(root: Path) -> list[Path]:
    try:
        tracked = subprocess.run(
            ["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
            cwd=root,
            check=True,
            capture_output=True,
            text=True,
        ).stdout.split("\0")
        return [Path(item) for item in tracked if item]
    except (OSError, subprocess.CalledProcessError, UnicodeDecodeError):
        candidates = []
        for directory, dirnames, filenames in os.walk(root):
            dirnames[:] = [name for name in dirnames if name not in IGNORED_PARTS]
            candidates.extend(Path(directory, filename).relative_to(root) for filename in filenames)
        return candidates


def check_test_anchors(root: Path, result: Result, strict: bool) -> None:
    anchored: set[str] = set()
    legacy_anchored: dict[Path, set[str]] = {}
    candidates = tracked_candidates(root)
    patterns = test_anchor_patterns(root, result)
    for relative in candidates:
        path = root / relative
        if not path.is_file():
            continue
        try:
            text = path.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            continue
        anchor_text = test_anchor_text(relative, text, patterns)
        if anchor_text is not None:
            anchored.update(AC_ID_RE.findall(anchor_text))
            legacy = set(LEGACY_R_ID_RE.findall(anchor_text))
            if legacy:
                legacy_anchored[relative] = legacy
    prd_path = root / "PRD.md"
    prd = ""
    if prd_path.is_file():
        prd = read_text_checked(prd_path, result, "PRD.md") or ""
    acceptance_ids: set[str] = set()
    requirements_without_acceptance_ids: list[str] = []
    for rid, body in sections(strip_code_fences(prd), R_HEADING_RE).items():
        local_ids = AC_LINE_RE.findall(body)
        for duplicate in sorted(duplicate_ids(local_ids)):
            result.errors.append(f"PRD.md: {rid} duplicate acceptance criterion {duplicate}")
        if not local_ids:
            requirements_without_acceptance_ids.append(rid)
        if len(EARS_RE.findall(body)) != len(local_ids):
            target = result.errors if strict else result.warnings
            target.append(f"PRD.md: {rid} has unnumbered EARS acceptance criteria")
        acceptance_ids.update(f"{rid}/{local_id}" for local_id in local_ids)
    result.test_anchored = {item.split("/", 1)[0] for item in anchored & acceptance_ids}
    result.acceptance_criteria = acceptance_ids
    result.test_anchored_acceptance_criteria = anchored & acceptance_ids
    missing = sorted(acceptance_ids - anchored)
    unknown = sorted(anchored - acceptance_ids)
    target = result.errors if strict else result.warnings
    if requirements_without_acceptance_ids:
        target.append(
            "PRD.md: requirements without AC-ID acceptance criteria: "
            + ", ".join(sorted(requirements_without_acceptance_ids))
        )
    if missing:
        target.append(f"tests: acceptance criteria without test anchor: {', '.join(missing)}")
    if unknown:
        result.errors.append(
            f"tests: test anchors reference missing acceptance criteria: {', '.join(unknown)}"
        )
    for relative, ids in sorted(legacy_anchored.items()):
        result.errors.append(
            f"{relative}: legacy requirement anchors must migrate to R-gg-nnn: {', '.join(sorted(ids))}"
        )


def code_anchors_enabled(root: Path, result: Result) -> bool:
    conventions = root / "CONVENTIONS.md"
    if not conventions.is_file():
        return False
    text = read_text_checked(conventions, result, "CONVENTIONS.md")
    if text is None:
        return False
    match = re.search(
        r"^-\s*代码锚点:\s*(\S+)\s*$",
        text,
        re.MULTILINE,
    )
    if not match:
        return False
    if match.group(1) not in ("开启", "关闭"):
        result.errors.append("CONVENTIONS.md: invalid 代码锚点, expect 开启 or 关闭")
        return False
    return match.group(1) == "开启"


def check_code_anchors(root: Path, result: Result, enabled: bool) -> None:
    """Validate optional `AgentMap: R-… / T-…` code-comment anchors against the map.

    Disabled by default (CONVENTIONS 代码锚点: 关闭); historical references are
    validated by existence only, so anchors never go stale silently.
    """
    if not enabled:
        return
    task_ids = historical_task_ids(root)
    patterns = test_anchor_patterns(root, result)
    anchor_re = re.compile(r"AgentMap:\s*(.*)$", re.MULTILINE)
    for relative in tracked_candidates(root):
        path = root / relative
        if not path.is_file() or is_test_file(relative, patterns):
            continue
        if path.suffix.lower() not in CODE_SUFFIXES:
            continue
        try:
            text = path.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            continue
        for match in anchor_re.finditer(text):
            for rid in sorted(set(R_ID_RE.findall(match.group(1))) - result.requirements):
                result.errors.append(
                    f"{relative.as_posix()}: code anchor references missing requirement {rid}"
                )
            for tid in sorted(set(T_ID_RE.findall(match.group(1))) - task_ids):
                result.errors.append(
                    f"{relative.as_posix()}: code anchor references missing task {tid}"
                )


def git_index_mode(root: Path, relative: Path) -> int | None:
    result = subprocess.run(
        ["git", "ls-files", "-s", "--", relative.as_posix()],
        cwd=root,
        check=False,
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        return None
    fields = result.stdout.split()
    if not fields:
        return None
    try:
        return int(fields[0], 8)
    except ValueError:
        return None


EXECUTABLE_HOOKS = {
    ".githooks/commit-msg",
    ".githooks/pre-commit",
    ".githooks/pre-push",
    ".githooks/commit-msg.d/50-project.sh",
    ".githooks/pre-commit.d/10-validate-staged.sh",
    ".githooks/pre-commit.d/20-agentmap-lint.sh",
    ".githooks/pre-push.d/10-lfs.sh",
    ".githooks/pre-push.d/20-agentmap-lint.sh",
}


def is_executable_path(root: Path, path: Path) -> bool:
    """POSIX checks the filesystem exec bit; Windows checks the Git index mode or the hook allow-list.

    On Windows there is no POSIX executable bit and git add writes 100644, so the index mode alone
    cannot prove executability. The allow-list covers every hook the scaffold installs and chmods.
    """
    if os.name != "nt":
        return bool(path.stat().st_mode & 0o111)
    relative = path.relative_to(root).as_posix()
    if relative in EXECUTABLE_HOOKS:
        return True
    mode = git_index_mode(root, path.relative_to(root))
    return bool(mode is not None and mode & 0o111)


def check_hooks(root: Path, result: Result) -> None:
    for relative in (
        Path(".githooks/commit-msg"),
        Path(".githooks/pre-commit"),
        Path(".githooks/pre-push"),
        Path(".githooks/pre-commit.d/20-agentmap-lint.sh"),
        Path(".githooks/pre-push.d/20-agentmap-lint.sh"),
    ):
        path = root / relative
        if not path.is_file():
            result.errors.append(f"missing: {relative}")
        elif not is_executable_path(root, path):
            result.errors.append(f"{relative}: must be executable")
    for name in ("commit-msg", "pre-commit", "pre-push"):
        path = root / ".githooks" / name
        if path.is_file():
            text = read_text_checked(path, result, f".githooks/{name}")
            if text is None:
                continue
            if f"{name}.d/" not in text or "continue" not in text:
                result.errors.append(f".githooks/{name}: must safely dispatch an empty {name}.d/")

    actual: set[str] = set()
    for directory in (root / ".githooks/pre-commit.d", root / ".githooks/pre-push.d"):
        if not directory.is_dir():
            continue
        orders: dict[str, str] = {}
        for path in sorted(directory.glob("*.sh")):
            relative = path.relative_to(root).as_posix()
            actual.add(relative)
            match = HOOK_NAME_PATTERN.fullmatch(path.name)
            if not match:
                result.errors.append(f"{relative}: hook name must use NN-name.sh")
            else:
                order = match.group("order")
                if order in orders:
                    result.errors.append(
                        f"{directory.relative_to(root)}: duplicate hook order {order}: "
                        f"{orders[order]}, {path.name}"
                    )
                orders[order] = path.name
            if not is_executable_path(root, path):
                result.errors.append(f"{relative}: must be executable")

    conventions = root / "CONVENTIONS.md"
    if conventions.is_file():
        text = read_text_checked(conventions, result, "CONVENTIONS.md")
        if text is None:
            return
        authority = re.findall(r"^-\s*权威验证入口:\s*(\S+)\s*$", text, re.MULTILINE)
        if len(authority) != 1:
            result.errors.append("CONVENTIONS.md: missing 权威验证入口")
        else:
            target = Path(authority[0])
            if target.is_absolute() or ".." in target.parts or not (root / target).is_file():
                result.errors.append(
                    "CONVENTIONS.md: 权威验证入口 must be an existing repository file"
                )
            elif not is_executable_path(root, root / target):
                result.errors.append("CONVENTIONS.md: 权威验证入口 must be executable")
        ci_gate = re.findall(r"^-\s*CI 门禁:\s*(.+?)\s*$", text, re.MULTILINE)
        if len(ci_gate) != 1 or not re.fullmatch(
            r"(?:适用|不适用)[:：].+", ci_gate[0] if ci_gate else ""
        ):
            result.errors.append(
                "CONVENTIONS.md: CI 门禁 needs 适用/不适用 with a concrete reason or path"
            )
        elif ci_gate[0].startswith(("适用:", "适用：")):
            ci_paths = re.findall(r"`([^`]+)`", ci_gate[0])
            if not ci_paths or any(not (root / path).is_file() for path in ci_paths):
                result.errors.append("CONVENTIONS.md: applicable CI 门禁 needs existing configuration paths")
        match = re.search(
            r"^## 验证门禁\s*$([\s\S]*?)(?=^##\s|\Z)", text, re.MULTILINE
        )
        registered = (
            set(re.findall(r"`(\.githooks/(?:pre-commit|pre-push)\.d/[^`]+\.sh)`", match.group(1)))
            if match
            else set()
        )
        if actual != registered:
            missing = sorted(actual - registered)
            stale = sorted(registered - actual)
            if missing:
                result.errors.append(f"CONVENTIONS.md: unregistered gate scripts: {', '.join(missing)}")
            if stale:
                result.errors.append(f"CONVENTIONS.md: missing registered gate scripts: {', '.join(stale)}")
        sources = (
            re.findall(
                r"`([^`]+)`",
                "\n".join(
                    re.findall(r"^-\s*扫描来源[:：]\s*(.+)$", match.group(1), re.MULTILINE)
                ),
            )
            if match
            else []
        )
        if not sources:
            result.errors.append("CONVENTIONS.md: 验证门禁 needs 扫描来源")
        for source in sources:
            if not (root / source).exists():
                result.errors.append(f"CONVENTIONS.md: missing validation scan source {source}")


def check_runtime_contract(root: Path, result: Result) -> None:
    for relative, expected in CANONICAL_FILES_SHA256.items():
        path = root / relative
        if not path.is_file():
            result.errors.append(f"missing: {relative}")
            continue
        if hashlib.sha256(path.read_bytes()).hexdigest() != expected:
            result.errors.append(f"{relative}: must match the canonical AgentMap runtime contract")
    lint_path = root / "tools/agentmap_lint.py"
    if lint_path.is_file() and lint_path.resolve() != Path(__file__).resolve():
        if lint_path.read_bytes() != Path(__file__).read_bytes():
            result.errors.append("tools/agentmap_lint.py: staged content differs from the running canonical lint")


def strict_test_anchors(root: Path, result: Result, forced: bool) -> bool:
    conventions = root / "CONVENTIONS.md"
    if not conventions.is_file():
        return True
    text = read_text_checked(conventions, result, "CONVENTIONS.md")
    if text is None:
        return True
    match = re.search(r"^-\s*测试锚定模式:\s*(.+?)\s*$", text, re.MULTILINE)
    if not match:
        result.errors.append("CONVENTIONS.md: missing 测试锚定模式: strict, lite or migration T-nnn")
        return True
    mode = match.group(1)
    if mode in ("strict", "lite"):
        return mode == "strict"
    migration = re.fullmatch(r"migration\s+(T-\d{3})", mode)
    if not migration:
        result.errors.append("CONVENTIONS.md: invalid 测试锚定模式")
        return True
    task_id = migration.group(1)
    if result.task_states.get(task_id) != "active":
        result.errors.append(f"CONVENTIONS.md: migration task {task_id} must exist and be active")
        return True
    return forced


def lint(root: Path, strict_tests: bool = False) -> Result:
    result = Result()
    changed = git_changed_paths(root)
    result.legacy_cutoff = legacy_cutoff(root, result)
    check_system_files(root, result, changed)
    check_todo_entries(root, result)
    check_id_formats(root, result)
    check_writing_style(root, result, changed)
    check_traceability(root, result)
    check_core_document_budget(root, result)
    check_tasks(root, result, changed)
    check_test_anchors(root, result, strict_test_anchors(root, result, strict_tests))
    check_code_anchors(root, result, code_anchors_enabled(root, result))
    check_hooks(root, result)
    check_runtime_contract(root, result)
    return result


def print_result(result: Result, report: bool) -> None:
    if report:
        print(
            "AgentMap report: "
            f"requirements={len(result.requirements)}, "
            f"acceptance-criteria={len(result.acceptance_criteria)}, "
            f"solution-covered={len(result.solution_covered)}, "
            f"test-anchored={len(result.test_anchored_acceptance_criteria)}, "
            f"goals={len(result.goals)}, "
            f"tasks={result.tasks}"
        )
        if result.task_line_counts:
            counts = ", ".join(
                f"{task_id}={lines}" for task_id, lines in sorted(result.task_line_counts.items())
            )
            print(
                "AgentMap task 文书行数: "
                f"{counts} (total={sum(result.task_line_counts.values())})"
            )
    if result.warnings:
        print("agentmap lint warnings:")
        for warning in result.warnings:
            print(f"  - {warning}")
    if result.errors:
        print("agentmap lint failed:")
        for error in result.errors:
            print(f"  - {error}")
    else:
        print("agentmap lint passed")


def write_fixture(root: Path) -> None:
    docs = {
        "PRD.md": """---
doc-type: prd
mutation: living
id-prefix: R
owner: owner
---
# PRD
## 目标
- **G-1 Search**
## 需求清单
#### R-01-001 Search
The user can search.
- AC-01 当查询存在时，系统应当返回结果。
- 关联目标: G-1
- 关联方案: Search
""",
        "SOLUTION.md": """---
doc-type: solution
mutation: living
owner: agent
核对日期: 2026-08-01
---
# SOLUTION
## 架构视图清单
| 视图 | 适用性/理由 | 图表位置 |
|---|---|---|
| 系统上下文 | 适用：存在用户与系统边界 | 系统上下文图 |
| 一级静态分解 | 适用：需要说明主要运行单元 | 一级静态分解图 |
| 内部组件分解 | 不适用：示例只有一个简单单元 | — |
| 运行时交互 | 适用：查询跨越用户与搜索单元 | 运行时交互图 |
| 数据与领域模型 | 适用：查询与结果构成核心契约 | 数据与领域模型图 |
| 状态与生命周期 | 不适用：查询没有持久生命周期 | — |
| 数据流与信任边界 | 不适用：示例不处理敏感数据且不跨信任边界 | — |
| 部署 | 不适用：示例是不可独立部署的库 | — |
| 分层与依赖 | 不适用：示例没有分层约束 | — |
| 系统景观 | 不适用：示例不属于多系统平台 | — |
## 方案细化清单
| 关注面 | 适用性/理由 | 方案落点 |
|---|---|---|
| 边界与对外契约 | 适用：搜索公开一个调用边界 | SOLUTION.md#Search |
| 核心数据与不变量 | 适用：查询与结果具有稳定关系 | SOLUTION.md#数据与领域模型图 |
| 状态与生命周期 | 不适用：搜索没有持久状态 | — |
| 运行时、并发与失败语义 | 适用：查询需要明确调用与失败返回 | SOLUTION.md#运行时交互图 |
| 外部集成 | 不适用：示例没有外部集成 | — |
| 配置与可变点 | 不适用：示例没有配置 | — |
| 安全与信任边界 | 不适用：示例不处理敏感数据 | — |
| 部署、迁移与恢复 | 不适用：示例是不可独立部署的库 | — |
| 兼容性与版本演进 | 不适用：示例没有既有兼容契约 | — |
| 可观测性与运维 | 不适用：示例没有独立运行时 | — |
## 实现就绪检查
| 条件 | 结论 | 证据或落点 |
|---|---|---|
| 边界与契约已明确 | 通过 | SOLUTION.md#Search |
| 关键不变量已明确 | 通过 | SOLUTION.md#数据与领域模型图 |
| 重大方案选择已收敛 | 通过 | 无未决重大选择：示例只有一种搜索路径 |
| 目标实现归属已明确 | 通过 | SOLUTION.md#子系统与模块 |
| 现状差距已有 task 承接 | 通过 | tasks/T-001-20260801-search.md#差距评估 |
| 可派生验证 | 通过 | tasks/T-001-20260801-search.md#测试计划 |
## 静态架构
### 系统上下文图
```mermaid
flowchart TB
    User --> Search
```
### 一级静态分解图
```mermaid
flowchart LR
    Search --> Store
```
## 运行时视图
### 运行时交互图
```mermaid
sequenceDiagram
    User->>Search: query
```
## 数据视图
### 数据与领域模型图
```mermaid
classDiagram
    Query --> Result
```
## 需求追溯索引
| 需求 | 主责子系统 | 方案落点 | 实现位置 |
|---|---|---|---|
| R-01-001 | Search | Search flow | src/search.py |
## 子系统与模块
### Search
- 职责: Search (R-01-001)
- 代码位置: src/search.py
""",
        "DOMAIN.md": "---\ndoc-type: domain\nmutation: living\nowner: agent\n---\n# DOMAIN\n- **Search**: Search subsystem.\n",
        "RATIONALE.md": "---\ndoc-type: rationale\nmutation: append-only\nid-prefix: C\nowner: agent\n---\n# RATIONALE\n",
        "TODO.md": "---\ndoc-type: todo\nmutation: inbox\nowner: both\n---\n# TODO\n- [维护想法] Simplify tooling\n",
        "CONVENTIONS.md": """---
doc-type: conventions
mutation: living
owner: agent
---
# CONVENTIONS
## AgentMap 本地参数
- agentmap 规范版本: 2
- 需求组 01: User
- 验证矩阵起始 task: T-001
- 代码审核起始 task: T-001
- 测试锚定模式: strict
- 核心文档上限: 20000 token
## 验证门禁
- 权威验证入口: .githooks/pre-push
- CI 门禁: 不适用：fixture 没有共享集成分支
- `.githooks/pre-commit.d/20-agentmap-lint.sh`: AgentMap lint
- `.githooks/pre-push.d/20-agentmap-lint.sh`: AgentMap history
- 扫描来源: `tests/test_search.py`
""",
    }
    for name, content in docs.items():
        (root / name).write_text(content, encoding="utf-8")
    source = Path(__file__).read_text(encoding="utf-8")
    (root / "tools").mkdir()
    (root / "tools/agentmap_lint.py").write_text(source, encoding="utf-8")
    agents_template = Path(__file__).parents[1] / "AGENTS.md.tmpl"
    if not agents_template.is_file():
        agents_template = Path(__file__).parents[1] / "AGENTS.md"
    (root / "AGENTS.md").write_bytes(agents_template.read_bytes())
    (root / "tasks").mkdir()
    (root / "tasks/T-001-20260801-search.md").write_text(
        """---
doc-type: task
mutation: lifecycle
id: T-001
---
# Search
状态: active
关联: R-01-001 → Search
风险等级: high
## 背景与目标
Provide searchable results.
## 差距评估
Search is not implemented.
## 收敛方案
Implement one search path.
## 测试计划
Run the search test.
## 验证矩阵
| 维度 | 适用性/理由 | 可执行证据 |
|---|---|---|
| 成功 | 适用：搜索成功 | `tests/contract.json#case.success`、`tests/test_search.py::test_search` |
| 异常 | 适用：搜索异常 | `tests/test_search.py::test_search` |
| 边界配置 | 适用：搜索边界 | `tests/test_search.py::test_search` |
| 副作用 | 不适用：搜索 fixture 无持久副作用 | — |
| 跨实现 | 不适用：fixture 只有一个实现 | — |
## 终态与证据
""",
        encoding="utf-8",
    )
    (root / "tests").mkdir()
    (root / "tests/test_search.py").write_text(
        "# R-01-001/AC-01\ndef test_search(): pass\n", encoding="utf-8"
    )
    (root / "tests/contract.json").write_text('{"id":"case.success"}\n', encoding="utf-8")
    canonical_root = Path(__file__).parents[1]
    for relative in (
        Path(".githooks/commit-msg"),
        Path(".githooks/pre-commit"),
        Path(".githooks/pre-push"),
        Path("tools/agentmap_validate_commit_msg.py"),
    ):
        path = root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes((canonical_root / relative).read_bytes())
        path.chmod(0o755)
    for relative in (
        Path(".githooks/pre-commit.d/20-agentmap-lint.sh"),
        Path(".githooks/pre-push.d/20-agentmap-lint.sh"),
    ):
        hook = root / relative
        hook.parent.mkdir(parents=True, exist_ok=True)
        hook.write_bytes((canonical_root / relative).read_bytes())
        hook.chmod(0o755)


def self_test_risk_tiers() -> None:
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        write_fixture(root)
        subprocess.run(["git", "init", "-q"], cwd=root, check=True)
        subprocess.run(["git", "config", "user.email", "agentmap@example.invalid"], cwd=root, check=True)
        subprocess.run(["git", "config", "user.name", "AgentMap"], cwd=root, check=True)
        base = (root / "tasks/T-001-20260801-search.md").read_text(encoding="utf-8")

        def variant(
            task_id: str,
            title: str,
            risk: str,
            *,
            drop_matrix: bool = False,
            minimal: bool = False,
        ) -> str:
            text = base.replace("id: T-001", f"id: {task_id}")
            text = text.replace("# Search", f"# {title}")
            text = text.replace("风险等级: high", f"风险等级: {risk}")
            if drop_matrix:
                text = re.sub(r"## 验证矩阵[\s\S]*?(?=## 终态与证据)", "", text)
            if minimal:
                # micro 章节分层：差距评估/收敛方案/测试计划 不再要求
                for heading in ("测试计划", "收敛方案", "差距评估"):
                    text = re.sub(rf"## {heading}[\s\S]*?(?=## |\Z)", "", text)
            return text

        micro = root / "tasks/T-002-20260801-micro.md"
        micro.write_text(
            variant("T-002", "Micro", "micro", drop_matrix=True, minimal=True),
            encoding="utf-8",
        )
        standard = root / "tasks/T-003-20260801-standard.md"
        standard.write_text(variant("T-003", "Standard", "standard"), encoding="utf-8")
        subprocess.run(["git", "add", "."], cwd=root, check=True)
        subprocess.run(
            ["git", "-c", "core.hooksPath=/dev/null", "commit", "-qm", "initial"],
            cwd=root,
            check=True,
        )
        implementation_commit = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=root,
            check=True,
            capture_output=True,
            text=True,
        ).stdout.strip()
        clean = lint(root, strict_tests=True)
        assert not clean.errors, clean.errors

        def complete(path: Path, evidence: str) -> None:
            text = path.read_text(encoding="utf-8").replace("状态: active", "状态: completed")
            path.write_text(text + evidence, encoding="utf-8")

        micro_active_text = micro.read_text(encoding="utf-8")
        complete(
            micro,
            f"""
- 实现: src/search.py
- 测试: tests/test_search.py passed
- SOLUTION 对照: SOLUTION 与实现一致
- commit: {implementation_commit}
""",
        )
        micro_missing = lint(root, strict_tests=True)
        assert any(
            "completed task needs 风险自评 evidence" in error
            for error in micro_missing.errors
        ), micro_missing.errors
        # 终态不可变：先回退到已提交的 active 文本，再带风险自评重关
        micro.write_text(micro_active_text, encoding="utf-8")
        complete(
            micro,
            f"""
- 实现: src/search.py
- 测试: tests/test_search.py passed
- SOLUTION 对照: SOLUTION 与实现一致
- commit: {implementation_commit}
- 风险自评: 注释级调整，无行为变化
""",
        )
        micro_ok = lint(root, strict_tests=True)
        assert not micro_ok.errors, micro_ok.errors

        complete(
            standard,
            f"""
- 实现: src/search.py
- 测试: tests/test_search.py passed
- SOLUTION 对照: SOLUTION 与实现一致
- commit: {implementation_commit}
""",
        )
        standard_missing = lint(root, strict_tests=True)
        assert any(
            "completed task needs independent code review evidence" in error
            for error in standard_missing.errors
        )

        standard.write_text(
            standard.read_text(encoding="utf-8")
            + "- review: 子代理 code-review，无 blocking finding\n",
            encoding="utf-8",
        )
        standard_missing_checklist = lint(root, strict_tests=True)
        assert any(
            "completed standard task needs 自查清单" in error
            for error in standard_missing_checklist.errors
        )

        standard.write_text(
            standard.read_text(encoding="utf-8")
            + "\n## 自查清单\n"
            + "- 边界：空查询返回空结果\n"
            + "- 异常路径：非法输入返回错误\n"
            + "- 回归影响：既有搜索用例全部通过\n",
            encoding="utf-8",
        )
        standard_ok = lint(root, strict_tests=True)
        assert not standard_ok.errors, standard_ok.errors
        standard_completed_text = standard.read_text(encoding="utf-8")

        standard.write_text(
            standard_completed_text.replace("风险等级: standard\n", ""), encoding="utf-8"
        )
        missing_risk = lint(root, strict_tests=True)
        assert any(
            "needs exactly one 风险等级: micro, standard or high" in error
            for error in missing_risk.errors
        )
        standard.write_text(standard_completed_text, encoding="utf-8")

        conventions = root / "CONVENTIONS.md"
        original_conventions = conventions.read_text(encoding="utf-8")
        conventions.write_text(
            original_conventions.replace("- agentmap 规范版本: 2\n", ""), encoding="utf-8"
        )
        v1_lint = lint(root, strict_tests=True)
        assert any("missing agentmap 规范版本" in warning for warning in v1_lint.warnings)
        assert any(
            "needs exactly one 风险等级: standard or high" in error for error in v1_lint.errors
        )

        conventions.write_text(
            original_conventions.replace("- 测试锚定模式: strict", "- 测试锚定模式: lite"),
            encoding="utf-8",
        )
        anchored_test = root / "tests/test_search.py"
        original_test = anchored_test.read_text(encoding="utf-8")
        anchored_test.write_text("def test_search(): pass\n", encoding="utf-8")
        lite = lint(root, strict_tests=True)
        assert not lite.errors, lite.errors
        assert any(
            "acceptance criteria without test anchor" in warning for warning in lite.warnings
        )
        anchored_test.write_text(original_test, encoding="utf-8")
        conventions.write_text(original_conventions, encoding="utf-8")


def self_test_id_formats() -> None:
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        write_fixture(root)
        subprocess.run(["git", "init", "-q"], cwd=root, check=True)
        subprocess.run(["git", "config", "user.email", "agentmap@example.invalid"], cwd=root, check=True)
        subprocess.run(["git", "config", "user.name", "AgentMap"], cwd=root, check=True)
        subprocess.run(["git", "add", "."], cwd=root, check=True)
        subprocess.run(
            ["git", "-c", "core.hooksPath=/dev/null", "commit", "-qm", "initial"],
            cwd=root,
            check=True,
        )
        clean = lint(root, strict_tests=True)
        assert not clean.errors, clean.errors

        prd = root / "PRD.md"
        original = prd.read_text(encoding="utf-8")
        prd.write_text(
            original
            + "\n参照需求R-100-001与任务T-0001、决策C-001AB、验收R-01-001/AC-021收口。\n",
            encoding="utf-8",
        )
        flagged = lint(root, strict_tests=True)
        for fragment in (
            "invalid requirement id R-100-001",
            "invalid task id T-0001",
            "invalid decision id C-001AB",
            "invalid acceptance id R-01-001/AC-021",
        ):
            assert any(fragment in error for error in flagged.errors), flagged.errors
        prd.write_text(original + "\n参见任务T-001与需求R-01-001。\n", encoding="utf-8")
        cjk_clean = lint(root, strict_tests=True)
        assert not cjk_clean.errors, cjk_clean.errors
        prd.write_text(original, encoding="utf-8")
        assert not lint(root, strict_tests=True).errors


def self_test_terminal_evidence_repair() -> None:
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        write_fixture(root)
        (root / "tools").mkdir(exist_ok=True)
        shutil.copy(Path(__file__).resolve(), root / "tools/agentmap_lint.py")
        subprocess.run(["git", "init", "-q"], cwd=root, check=True)
        subprocess.run(["git", "config", "user.email", "agentmap@example.invalid"], cwd=root, check=True)
        subprocess.run(["git", "config", "user.name", "AgentMap"], cwd=root, check=True)

        def commit(message: str) -> str:
            subprocess.run(
                ["git", "-c", "core.hooksPath=/dev/null", "commit", "-qm", message],
                cwd=root,
                check=True,
            )
            return subprocess.run(
                ["git", "rev-parse", "HEAD"], cwd=root, check=True, capture_output=True, text=True
            ).stdout.strip()

        subprocess.run(["git", "add", "."], cwd=root, check=True)
        initial = commit("initial")
        assert not lint(root, strict_tests=True).errors
        branch = subprocess.run(
            ["git", "branch", "--show-current"],
            cwd=root,
            check=True,
            capture_output=True,
            text=True,
        ).stdout.strip()
        # A commit that becomes unreachable from HEAD (side branch deleted),
        # mirroring a referenced commit destroyed by an upstream amend.
        subprocess.run(["git", "checkout", "-qb", "side"], cwd=root, check=True)
        todo = root / "TODO.md"
        todo.write_text(todo.read_text(encoding="utf-8") + "\nscratch\n", encoding="utf-8")
        subprocess.run(["git", "add", "."], cwd=root, check=True)
        dangling = commit("dangling")
        subprocess.run(["git", "checkout", "-q", branch], cwd=root, check=True)
        subprocess.run(["git", "branch", "-qD", "side"], cwd=root, check=True)
        assert not resolves_to_reachable_commit(root, dangling)
        assert resolves_to_reachable_commit(root, initial)

        # Closure with evidence already referencing the destroyed hash: the
        # state the real amend scenario leaves behind for the next commit.
        task = root / "tasks/T-001-20260801-search.md"
        active_text = task.read_text(encoding="utf-8")
        task.write_text(
            active_text.replace("状态: active", "状态: completed")
            + f"""
- 实现: src/search.py
- 测试: tests/test_search.py passed
- SOLUTION 对照: SOLUTION 与实现一致
- review:
  - 审核方: reviewer-agent
  - 目的理解: 验证 Search task 的结果目标
  - 执行方式: code-review skill
  - 问题与修复: 无
  - 复审结论: pass
- commit: {dangling}
""",
            encoding="utf-8",
        )
        subprocess.run(["git", "add", "."], cwd=root, check=True)
        closure = commit("close")

        # Current-tree axis: the evidence repair edit is admitted.
        task.write_text(
            task.read_text(encoding="utf-8").replace(f"- commit: {dangling}", f"- commit: {initial}"),
            encoding="utf-8",
        )
        repaired = lint(root, strict_tests=True)
        assert not any("terminal task is immutable" in error for error in repaired.errors), repaired.errors
        subprocess.run(["git", "add", "."], cwd=root, check=True)
        repair = commit("repair")

        # History axis: the repair commit is admitted on push.
        result = Result()
        check_outgoing_history(root, result, f"refs/heads/{branch} {repair} refs/heads/{branch} {'0' * 40}\n")
        assert not any("changed after reaching a terminal state" in error for error in result.errors), result.errors
        result = Result()
        check_history_transition(root, result, closure, repair, check_additions=True)
        assert not result.errors, result.errors

        # Shape-level assertions on multi-evidence-line texts: partial in-place
        # replacement is admitted, moving an evidence line to another position
        # is not.
        synthetic_old = (
            "---\ndoc-type: task\nmutation: lifecycle\nid: T-001\n---\n# T\n状态: completed\n\n## 终态与证据\n\n"
            f"- 实现: x\n- 测试: x\n- commit: {dangling}\n- 注: mid\n- commit: {initial}\n"
        )
        synthetic_fixed = synthetic_old.replace(f"- commit: {dangling}", f"- commit: {closure}")
        assert is_commit_evidence_repair(root, synthetic_old, synthetic_fixed)
        synthetic_moved = synthetic_old.replace(f"- commit: {initial}\n", "").replace(
            "- 注: mid\n", f"- commit: {initial}\n- 注: mid\n"
        )
        assert not is_commit_evidence_repair(root, synthetic_old, synthetic_moved)
        # Repeated same-hash replacement (the real 8eac96c shape: two lines
        # citing one destroyed commit, both redirected to its amended self).
        repeated_old = synthetic_old.replace(f"- commit: {initial}", f"- commit: {dangling}")
        repeated_fixed = repeated_old.replace(f"- commit: {dangling}", f"- commit: {closure}")
        assert is_commit_evidence_repair(root, repeated_old, repeated_fixed)

        # Negative: reachable → reachable hash swap is not a repair.
        task.write_text(
            task.read_text(encoding="utf-8").replace(f"- commit: {initial}", f"- commit: {closure}"),
            encoding="utf-8",
        )
        swapped = lint(root, strict_tests=True)
        assert any("terminal task is immutable" in error for error in swapped.errors), swapped.errors
        task.write_text(git_head_text(root, task.relative_to(root)) or "", encoding="utf-8")

        # Negative: any non-commit-line post-terminal edit stays rejected.
        task.write_text(task.read_text(encoding="utf-8") + "\ntampered\n", encoding="utf-8")
        tampered = lint(root, strict_tests=True)
        assert any("terminal task is immutable" in error for error in tampered.errors), tampered.errors
        subprocess.run(["git", "add", "."], cwd=root, check=True)
        tamper = commit("tamper")
        result = Result()
        check_history_transition(root, result, repair, tamper, check_additions=True)
        assert any("changed after reaching a terminal state" in error for error in result.errors), result.errors

        # Negative: reachable → reachable hash swap stays rejected on push.
        task.write_text(
            task.read_text(encoding="utf-8").replace(f"- commit: {initial}", f"- commit: {closure}"),
            encoding="utf-8",
        )
        subprocess.run(["git", "add", "."], cwd=root, check=True)
        swapped_commit = commit("swap")
        result = Result()
        check_history_transition(root, result, tamper, swapped_commit, check_additions=True)
        assert any("changed after reaching a terminal state" in error for error in result.errors), result.errors


def self_test_state_scope_and_evidence() -> None:
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        write_fixture(root)
        (root / "tools").mkdir(exist_ok=True)
        shutil.copy(Path(__file__).resolve(), root / "tools/agentmap_lint.py")
        subprocess.run(["git", "init", "-q"], cwd=root, check=True)
        subprocess.run(["git", "config", "user.email", "agentmap@example.invalid"], cwd=root, check=True)
        subprocess.run(["git", "config", "user.name", "AgentMap"], cwd=root, check=True)
        subprocess.run(["git", "add", "."], cwd=root, check=True)
        subprocess.run(
            ["git", "-c", "core.hooksPath=/dev/null", "commit", "-qm", "initial"],
            cwd=root,
            check=True,
        )
        initial = subprocess.run(
            ["git", "rev-parse", "HEAD"], cwd=root, check=True, capture_output=True, text=True
        ).stdout.strip()
        assert not lint(root, strict_tests=True).errors

        task = root / "tasks/T-001-20260801-search.md"
        active_text = task.read_text(encoding="utf-8")

        # 状态劫持防线：正文节内的「状态: completed」行只是引用文字，任务
        # 仍以标题块的 active 为准；若全文搜索回归，此处会按 completed
        # 追加实现/测试等证据缺失错误。
        task.write_text(active_text + "状态: completed\n")
        hijacked = lint(root, strict_tests=True)
        assert not hijacked.errors, hijacked.errors
        task.write_text(active_text)

        # 终态证据占位防线：`- commit: 待补` 满足标签存在性检查，但值不是
        # hash，不得当作已满足 commit 证据蒙混过关。
        placeholder_text = active_text.replace("状态: active", "状态: completed") + f"""
- 实现: src/search.py
- 测试: tests/test_search.py passed
- SOLUTION 对照: SOLUTION 与实现一致
- review:
  - 审核方: reviewer-agent
  - 目的理解: 验证 Search task 的结果目标
  - 执行方式: code-review skill
  - 问题与修复: 无
  - 复审结论: pass
- commit: 待补
"""
        task.write_text(placeholder_text)
        flagged = lint(root, strict_tests=True)
        assert any(
            "commit evidence line is not a commit hash: 待补" in error for error in flagged.errors
        ), flagged.errors
        assert not any(
            "commit evidence must resolve to a reachable commit" in error
            for error in flagged.errors
        ), flagged.errors

        task.write_text(placeholder_text.replace("- commit: 待补", f"- commit: {initial}"))
        resolved = lint(root, strict_tests=True)
        assert not resolved.errors, resolved.errors


def self_test_io_errors() -> None:
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        write_fixture(root)
        subprocess.run(["git", "init", "-q"], cwd=root, check=True)
        subprocess.run(["git", "config", "user.email", "agentmap@example.invalid"], cwd=root, check=True)
        subprocess.run(["git", "config", "user.name", "AgentMap"], cwd=root, check=True)
        subprocess.run(["git", "add", "."], cwd=root, check=True)
        subprocess.run(
            ["git", "-c", "core.hooksPath=/dev/null", "commit", "-qm", "initial"],
            cwd=root,
            check=True,
        )
        todo = root / "TODO.md"
        todo.write_bytes(todo.read_bytes() + b"\n\xff\xfe not utf-8\n")
        task = root / "tasks/T-001-20260801-search.md"
        task.write_bytes(task.read_bytes() + b"\n\xff\xfe not utf-8\n")
        result = lint(root, strict_tests=True)
        assert any(
            "TODO.md: cannot read file (UnicodeDecodeError" in error for error in result.errors
        ), result.errors
        assert any(
            "tasks/T-001-20260801-search.md: cannot read file (UnicodeDecodeError" in error
            for error in result.errors
        ), result.errors
        # The unreadable task is skipped, not hallucinated into a state: no
        # secondary "missing valid 状态" error for the same file.
        assert not any(
            "missing valid 状态" in error for error in result.errors
        ), result.errors


def self_test_document_budget_and_decisions() -> None:
    """Core-document budget gate plus RATIONALE supersession references."""
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        write_fixture(root)
        subprocess.run(["git", "init", "-q"], cwd=root, check=True)
        subprocess.run(["git", "config", "user.email", "agentmap@example.invalid"], cwd=root, check=True)
        subprocess.run(["git", "config", "user.name", "AgentMap"], cwd=root, check=True)
        subprocess.run(["git", "add", "."], cwd=root, check=True)
        subprocess.run(
            ["git", "-c", "core.hooksPath=/dev/null", "commit", "-qm", "initial"],
            cwd=root,
            check=True,
        )
        conventions = root / "CONVENTIONS.md"
        conventions_original = conventions.read_text(encoding="utf-8")
        solution = root / "SOLUTION.md"
        solution_original = solution.read_text(encoding="utf-8")

        conventions.write_text(conventions_original.replace("- 核心文档上限: 20000 token\n", ""))
        unregistered = lint(root, strict_tests=True)
        assert any("核心文档上限 not registered" in warning for warning in unregistered.warnings)
        conventions.write_text(conventions_original)

        solution.write_text(solution_original + "\n" + "x" * 70000 + "\n")
        over_limit = lint(root, strict_tests=True)
        assert any("over the registered limit" in error for error in over_limit.errors), over_limit.errors
        conventions.write_text(conventions_original + "- 核心文档分片方案: SOLUTION.md 拆分见 tasks/\n")
        planned = lint(root, strict_tests=True)
        assert any("over the registered limit" in warning for warning in planned.warnings)
        assert not any("over the registered limit" in error for error in planned.errors)
        solution.write_text(solution_original)
        conventions.write_text(conventions_original)

        solution_line = "核对日期: 2026-08-01\n"
        solution.write_text(solution_original.replace(solution_line, ""))
        unverified = lint(root, strict_tests=True)
        assert any("lacks 核对日期" in warning for warning in unverified.warnings)
        solution.write_text(solution_original.replace(solution_line, "核对日期: 2026/08/01\n"))
        malformed = lint(root, strict_tests=True)
        assert any("核对日期 must be YYYY-MM-DD" in error for error in malformed.errors)
        solution.write_text(solution_original)

        rationale = root / "RATIONALE.md"
        rationale_original = rationale.read_text(encoding="utf-8")
        entries = (
            "\n### C-001 采用单文件存储\n日期: 2026-08-01\n\n#### 上下文\n原型阶段。\n"
            "#### 决策\n先用单文件。\n#### 被否方案及原因\n外部数据库过重。\n#### 影响面\n文档服务\n"
            "\n### C-002 改用嵌入式存储\n日期: 2026-08-02\n\n#### 上下文\n并发写入受损。\n"
            "#### 决策\n改用嵌入式存储。\n- 废弃: C-001\n#### 被否方案及原因\n维持单文件会继续损坏。\n#### 影响面\n文档服务\n"
        )
        rationale.write_text(rationale_original + entries)
        clean = lint(root, strict_tests=True)
        assert not any("superseded" in error for error in clean.errors), clean.errors
        prd = root / "PRD.md"
        prd_original = prd.read_text(encoding="utf-8")
        prd.write_text(prd_original.replace("- 关联方案: Search", "- 关联方案: Search\n- 出处: C-001"))
        stale = lint(root, strict_tests=True)
        assert any(
            "references superseded decision C-001 superseded by C-002" in error for error in stale.errors
        ), stale.errors
        prd.write_text(prd_original)

        rationale.write_text(rationale_original + entries.replace("- 废弃: C-001", "- 废弃: C-999"))
        dangling = lint(root, strict_tests=True)
        assert any("superseded decision C-999 does not exist" in error for error in dangling.errors)
        rationale.write_text(rationale_original)


def self_test_legacy_cutoff() -> None:
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        write_fixture(root)
        subprocess.run(["git", "init", "-q"], cwd=root, check=True)
        subprocess.run(["git", "config", "user.email", "agentmap@example.invalid"], cwd=root, check=True)
        subprocess.run(["git", "config", "user.name", "AgentMap"], cwd=root, check=True)
        legacy = root / "tasks/20260731-legacy.md"
        legacy.write_text(
            "---\ndoc-type: task\nmutation: lifecycle\n---\n# Legacy\n状态: active\n",
            encoding="utf-8",
        )
        subprocess.run(["git", "add", "."], cwd=root, check=True)
        subprocess.run(
            ["git", "-c", "core.hooksPath=/dev/null", "commit", "-qm", "initial"],
            cwd=root,
            check=True,
        )
        tolerated = lint(root, strict_tests=True)
        assert not any("legacy task name" in error for error in tolerated.errors), tolerated.errors

        conventions = root / "CONVENTIONS.md"
        original = conventions.read_text(encoding="utf-8")
        conventions.write_text(original + "- legacy 迁移截止: 2026-01-01\n", encoding="utf-8")
        expired = lint(root, strict_tests=True)
        assert any(
            "legacy task name outlived the legacy 迁移截止" in error for error in expired.errors
        ), expired.errors

        conventions.write_text(original + "- legacy 迁移截止: 2099-01-01\n", encoding="utf-8")
        future = lint(root, strict_tests=True)
        assert not any(
            "legacy task name outlived" in error or "迁移截止" in error for error in future.errors
        ), future.errors

        conventions.write_text(original + "- legacy 迁移截止: 2026-1-1\n", encoding="utf-8")
        malformed = lint(root, strict_tests=True)
        assert any(
            "legacy 迁移截止 must be YYYY-MM-DD" in error for error in malformed.errors
        ), malformed.errors
        conventions.write_text(original, encoding="utf-8")


def self_test() -> None:
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        write_fixture(root)
        subprocess.run(["git", "init", "-q"], cwd=root, check=True)
        subprocess.run(["git", "config", "user.email", "agentmap@example.invalid"], cwd=root, check=True)
        subprocess.run(["git", "config", "user.name", "AgentMap"], cwd=root, check=True)
        legacy = root / "tasks/20260731-legacy.md"
        legacy.write_text(
            "---\ndoc-type: task\nmutation: lifecycle\n---\n# Legacy\n状态: active\n",
            encoding="utf-8",
        )
        subprocess.run(["git", "add", "."], cwd=root, check=True)
        subprocess.run(
            ["git", "-c", "core.hooksPath=/dev/null", "commit", "-qm", "initial"],
            cwd=root,
            check=True,
        )
        valid = lint(root, strict_tests=True)
        assert not valid.errors, valid.errors

        style_conventions = root / "CONVENTIONS.md"
        style_original = style_conventions.read_text(encoding="utf-8")
        style_conventions.write_text(style_original + "- " + "一条超长规则。" * 30 + "\n", encoding="utf-8")
        style_flagged = lint(root, strict_tests=True)
        assert any("list item may carry multiple rules" in warning for warning in style_flagged.warnings)
        style_conventions.write_text(
            style_original + "- 外层（中含嵌套（内层））括号的列表项。\n", encoding="utf-8"
        )
        nested_flagged = lint(root, strict_tests=True)
        assert any("nested parentheses" in warning for warning in nested_flagged.warnings)
        style_conventions.write_text(
            style_original + "- 尽量在完成后适当调整相关文档。\n", encoding="utf-8"
        )
        vague_flagged = lint(root, strict_tests=True)
        assert any("vague wording" in warning for warning in vague_flagged.warnings)
        style_conventions.write_text(
            style_original + "- 系统配置文件读取模块错误处理逻辑由该层负责。\n", encoding="utf-8"
        )
        stack_flagged = lint(root, strict_tests=True)
        assert any("long noun stack" in warning for warning in stack_flagged.warnings)
        style_conventions.write_text(style_original, encoding="utf-8")
        style_clean = lint(root, strict_tests=True)
        assert not any(
            "may carry multiple rules" in warning
            or "nested parentheses" in warning
            or "vague wording" in warning
            or "long noun stack" in warning
            for warning in style_clean.warnings
        )
        implementation_commit = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=root,
            check=True,
            capture_output=True,
            text=True,
        ).stdout.strip()

        todo = root / "TODO.md"
        original_todo = todo.read_text(encoding="utf-8")
        todo.write_text(original_todo.replace("[维护想法]", "[其他]"), encoding="utf-8")
        invalid_todo = lint(root, strict_tests=True)
        assert any("entry needs one valid intake type tag" in error for error in invalid_todo.errors)
        todo.write_text(original_todo, encoding="utf-8")

        solution = root / "SOLUTION.md"
        original_solution = solution.read_text(encoding="utf-8")
        solution.write_text(original_solution + "\n覆盖 R-01-001～R-02-003。\n", encoding="utf-8")
        cross_group = lint(root, strict_tests=True)
        assert any("spans requirement groups" in error for error in cross_group.errors)
        solution.write_text(original_solution + "\n覆盖 R-01-001～R-01-999。\n", encoding="utf-8")
        wide_range = lint(root, strict_tests=True)
        assert any("spans over 100 ids" in error for error in wide_range.errors)
        solution.write_text(original_solution, encoding="utf-8")

        task = root / "tasks/T-001-20260801-search.md"
        active_text = task.read_text(encoding="utf-8")
        task.write_text(active_text.replace("id: T-001", "id: T-002"), encoding="utf-8")
        mismatched_task_id = lint(root, strict_tests=True)
        assert any("id should be T-001" in error for error in mismatched_task_id.errors)
        task.write_text(active_text, encoding="utf-8")

        duplicate_task = root / "tasks/T-001-20260802-other.md"
        duplicate_task.write_text(active_text.replace("# Search", "# Other"), encoding="utf-8")
        duplicate_task_id = lint(root, strict_tests=True)
        assert any("duplicate task id T-001" in error for error in duplicate_task_id.errors)
        duplicate_task.unlink()

        skipped_task = root / "tasks/T-003-20260802-skipped.md"
        skipped_task.write_text(
            active_text.replace("id: T-001", "id: T-003").replace("# Search", "# Skipped"),
            encoding="utf-8",
        )
        skipped_task_id = lint(root, strict_tests=True)
        assert not skipped_task_id.errors, skipped_task_id.errors
        skipped_task.unlink()

        task.unlink()
        reused_task = root / "tasks/T-001-20260802-reused.md"
        reused_task.write_text(active_text.replace("# Search", "# Reused"), encoding="utf-8")
        reused_task_id = lint(root, strict_tests=True)
        assert any("reused task id T-001" in error for error in reused_task_id.errors)
        reused_task.unlink()
        task.write_text(active_text, encoding="utf-8")

        new_legacy = root / "tasks/20260801-new-legacy.md"
        new_legacy.write_text(
            "---\ndoc-type: task\nmutation: lifecycle\n---\n# New legacy\n状态: active\n",
            encoding="utf-8",
        )
        invalid_legacy = lint(root, strict_tests=True)
        assert any("expect T-nnn-YYYYMMDD-slug.md" in error for error in invalid_legacy.errors)
        new_legacy.unlink()

        matrix_row = "| 异常 | 适用：搜索异常 | `tests/test_search.py::test_search` |\n"
        task.write_text(active_text.replace(matrix_row, ""), encoding="utf-8")
        missing_matrix_dimension = lint(root, strict_tests=True)
        assert any("missing baseline dimensions: 异常" in error for error in missing_matrix_dimension.errors)
        task.write_text(active_text, encoding="utf-8")

        task.write_text(
            active_text.replace("tests/test_search.py::test_search", "tests/missing.py::test_search", 1),
            encoding="utf-8",
        )
        missing_matrix_file = lint(root, strict_tests=True)
        assert any("missing evidence file tests/missing.py" in error for error in missing_matrix_file.errors)
        task.write_text(active_text, encoding="utf-8")

        task.write_text(
            active_text.replace("tests/test_search.py::test_search", "tests/test_search.py::missing_test", 1),
            encoding="utf-8",
        )
        missing_matrix_anchor = lint(root, strict_tests=True)
        assert any("missing evidence anchor" in error for error in missing_matrix_anchor.errors)
        task.write_text(active_text, encoding="utf-8")

        task.write_text(
            active_text.replace(
                "`tests/test_search.py::test_search`",
                "`tests/test_search.py#R-01-001`",
                1,
            ),
            encoding="utf-8",
        )
        fixture_without_consumer = lint(root, strict_tests=True)
        assert any("fixture evidence needs a consumer" in error for error in fixture_without_consumer.errors)
        task.write_text(active_text, encoding="utf-8")

        task.write_text(
            active_text.replace(
                "不适用：搜索 fixture 无持久副作用",
                "不适用：待补",
            ),
            encoding="utf-8",
        )
        placeholder_matrix = lint(root, strict_tests=True)
        assert any("cannot use placeholder evidence" in error for error in placeholder_matrix.errors)
        task.write_text(active_text, encoding="utf-8")

        conventions = root / "CONVENTIONS.md"
        original_conventions = conventions.read_text(encoding="utf-8")
        conventions.write_text(
            original_conventions.replace("验证矩阵起始 task: T-001", "验证矩阵起始 task: T-002"),
            encoding="utf-8",
        )
        moved_matrix_start = lint(root, strict_tests=True)
        assert any("cannot move forward" in error for error in moved_matrix_start.errors)
        conventions.write_text(original_conventions, encoding="utf-8")

        solution = root / "SOLUTION.md"
        original_solution = solution.read_text(encoding="utf-8")
        solution.write_text(original_solution.replace("(R-01-001)", ""), encoding="utf-8")
        invalid = lint(root, strict_tests=True)
        assert any("does not declare R-01-001" in error for error in invalid.errors), invalid.errors
        solution.write_text(original_solution, encoding="utf-8")

        solution.write_text(original_solution.replace("| R-01-001 | Search | Search flow | src/search.py |\n", ""), encoding="utf-8")
        missing_trace = lint(root, strict_tests=True)
        assert any("exactly one 需求追溯索引 row" in error for error in missing_trace.errors)
        solution.write_text(original_solution, encoding="utf-8")

        trace_row = "| R-01-001 | Search | Search flow | src/search.py |\n"
        solution.write_text(original_solution.replace(trace_row, trace_row * 2), encoding="utf-8")
        duplicate_trace = lint(root, strict_tests=True)
        assert any("exactly one 需求追溯索引 row" in error for error in duplicate_trace.errors)
        solution.write_text(original_solution, encoding="utf-8")

        solution.write_text(
            original_solution.replace(trace_row, trace_row + "| R-01-001 | Search | Extra | src/extra.py | extra |\n"),
            encoding="utf-8",
        )
        malformed_duplicate = lint(root, strict_tests=True)
        assert any("exactly one 需求追溯索引 row" in error for error in malformed_duplicate.errors)
        solution.write_text(original_solution, encoding="utf-8")

        solution.write_text(original_solution.replace("| 需求 | 主责子系统 |", "| Requirement | 主责子系统 |"), encoding="utf-8")
        wrong_trace_header = lint(root, strict_tests=True)
        assert any("需求追溯索引 must use" in error for error in wrong_trace_header.errors)
        solution.write_text(original_solution, encoding="utf-8")

        solution.write_text(original_solution.replace("| R-01-001 | Search |", "| R-01-001 | Other |"), encoding="utf-8")
        mismatched_trace = lint(root, strict_tests=True)
        assert any("does not match PRD 关联方案" in error for error in mismatched_trace.errors)
        solution.write_text(original_solution, encoding="utf-8")

        prd = root / "PRD.md"
        original_prd = prd.read_text(encoding="utf-8")
        prd.write_text(original_prd.replace("- AC-01 当查询存在时，系统应当返回结果。\n", ""), encoding="utf-8")
        missing_ears = lint(root, strict_tests=True)
        assert any("must have at least one EARS acceptance criterion" in error for error in missing_ears.errors)
        prd.write_text(original_prd, encoding="utf-8")

        domain = root / "DOMAIN.md"
        original_domain = domain.read_text(encoding="utf-8")
        domain.write_text(original_domain.replace("- **Search**: Search subsystem.\n", ""), encoding="utf-8")
        missing_domain_module = lint(root, strict_tests=True)
        assert any("solution module Search must be defined exactly once" in error for error in missing_domain_module.errors)
        domain.write_text(original_domain, encoding="utf-8")

        prd.write_text(original_prd + "实现提交为 `a1b2c3d`。\n", encoding="utf-8")
        leaked = lint(root, strict_tests=True)
        assert any("contains implementation evidence" in error for error in leaked.errors)
        prd.write_text(original_prd, encoding="utf-8")

        task.write_text(active_text.replace("状态: active", "状态: completed") + "\ndone\n", encoding="utf-8")
        weak_evidence = lint(root, strict_tests=True)
        assert any("needs 实现 evidence" in error for error in weak_evidence.errors)
        task.write_text(active_text, encoding="utf-8")
        task.write_text(
            task.read_text(encoding="utf-8").replace(
                "状态: active",
                "状态: completed",
            )
            + f"""
- 实现: src/search.py
- 测试: tests/test_search.py passed
- SOLUTION 对照: SOLUTION 与实现一致
- review:
  - 审核方: reviewer-agent
  - 目的理解: 验证 Search task 的结果目标
  - 执行方式: code-review skill
  - 问题与修复: 无
  - 复审结论: pass
- commit: {implementation_commit}
""",
            encoding="utf-8",
        )
        assert not lint(root, strict_tests=True).errors
        subprocess.run(["git", "add", "."], cwd=root, check=True)
        subprocess.run(
            ["git", "-c", "core.hooksPath=/dev/null", "commit", "-qm", "complete"],
            cwd=root,
            check=True,
        )
        task.write_text(task.read_text(encoding="utf-8") + "\ntampered\n", encoding="utf-8")
        immutable = lint(root, strict_tests=True)
        assert any("terminal task is immutable" in error for error in immutable.errors)
        task.write_text(task.read_text(encoding="utf-8")[: -len("\ntampered\n")], encoding="utf-8")
        task.unlink()
        deleted = lint(root, strict_tests=True)
        assert any("terminal task was deleted or moved" in error for error in deleted.errors)
        task.write_text(git_head_text(root, task.relative_to(root)) or "", encoding="utf-8")
        pre_rename = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=root,
            check=True,
            capture_output=True,
            text=True,
        ).stdout.strip()
        renamed = root / "tasks/T-002-20260801-search.md"
        task.rename(renamed)
        renamed.write_text(
            renamed.read_text(encoding="utf-8").replace("id: T-001", "id: T-002"),
            encoding="utf-8",
        )
        subprocess.run(["git", "add", "-A"], cwd=root, check=True)
        subprocess.run(
            ["git", "-c", "core.hooksPath=/dev/null", "commit", "-qm", "rename"],
            cwd=root,
            check=True,
        )
        rename_history = Result()
        check_history_transition(root, rename_history, pre_rename, "HEAD", check_additions=True)
        assert any(
            "changed after reaching a terminal state" in error for error in rename_history.errors
        )
        assert any(
            "created directly in a terminal state" in error for error in rename_history.errors
        )
        assert "T-002" in historical_task_ids(root)
    self_test_id_formats()
    self_test_state_scope_and_evidence()
    self_test_io_errors()
    self_test_document_budget_and_decisions()
    self_test_legacy_cutoff()
    self_test_terminal_evidence_repair()
    self_test_risk_tiers()
    print("agentmap lint self-test passed")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--report", action="store_true")
    parser.add_argument("--strict-tests", action="store_true")
    parser.add_argument("--staged", action="store_true")
    parser.add_argument("--pre-push", action="store_true")
    parser.add_argument("--self-test", action="store_true")
    parser.add_argument("hook_args", nargs="*")
    args = parser.parse_args()
    if args.self_test:
        self_test()
        return 0
    root = args.root.resolve()
    try:
        if args.staged:
            with staged_checkout(root) as snapshot:
                result = lint(snapshot, strict_tests=args.strict_tests)
        else:
            result = lint(root, strict_tests=args.strict_tests)
        if args.pre_push:
            stdin_text = sys.stdin.read()
            if not stdin_text.strip():
                # git always passes <remote-name> <remote-url> to pre-push and
                # sends an empty ref list only when there is nothing to push.
                # Empty stdin without that context means the hook was invoked
                # outside git, which would silently skip the history audit.
                if len(args.hook_args) != 2:
                    result.errors.append(
                        "pre-push: no ref updates on stdin and no hook context "
                        "(git passes <remote-name> <remote-url>); refusing to run "
                        "without the outgoing history audit"
                    )
            else:
                check_outgoing_history(root, result, stdin_text)
    except (OSError, UnicodeDecodeError, subprocess.CalledProcessError) as error:
        # Last-resort backstop for environment failures (broken repository,
        # vanished files, undecodable bytes) so the hook fails closed with an
        # actionable message instead of a traceback the agent cannot act on.
        detail = (getattr(error, "stderr", "") or "").strip()
        print(
            "agentmap lint failed on an unrecoverable I/O or git error:"
            f" {error.__class__.__name__}: {error}{(' | ' + detail) if detail else ''}",
            file=sys.stderr,
        )
        print_result(
            Result(errors=[f"I/O or git error: {error.__class__.__name__}: {error}"]),
            args.report,
        )
        return 1
    print_result(result, args.report)
    return bool(result.errors)


if __name__ == "__main__":
    sys.exit(main())
