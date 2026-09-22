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
IMPLEMENTATION_EVIDENCE_RE = re.compile(
    r"(?:\b(?:src|tests?|tasks)/|\b[0-9a-f]{7,40}\b|`[^`]+\.(?:py|rs|go|js|ts|java|kt|rb|sh)`)",
    re.IGNORECASE,
)
# Decision entries may reference tasks via T-ID and may name tasks/ as workflow
# vocabulary (the audit chain), so only src/tests paths, hashes, and code-file
# references count as implementation evidence there. Checked against newly
# appended entries only; historical entries are immutable and grandfathered.
DECISION_EVIDENCE_RE = re.compile(
    r"(?:\b(?:src|tests?)/|\b[0-9a-f]{7,40}\b|`[^`]+\.(?:py|rs|go|js|ts|java|kt|rb|sh)`)",
    re.IGNORECASE,
)
MUTATIONS = {"living", "append-only", "inbox", "lifecycle"}
TERMINAL_STATES = {"completed", "abandoned", "superseded"}
TASK_NAME_RE = re.compile(r"^(T-\d{3})-\d{8}-.+\.md$")
LEGACY_TASK_NAME_RE = re.compile(r"^\d{8}-.+\.md$")
T_ID_RE = re.compile(r"\bT-\d{3}\b")
GOAL_RE = re.compile(r"\*\*(G-\d+)\b")
NON_GOAL_RE = re.compile(r"\*\*(NG-\d+)\b")
R_HEADING_RE = re.compile(r"^####\s+(R-\d{2}-\d{3})\b.*$", re.MULTILINE)
LEGACY_R_HEADING_RE = re.compile(r"^####\s+(R-\d{3})\b.*$", re.MULTILINE)
LEGACY_R_ID_RE = re.compile(r"\bR-\d{3}\b")
C_HEADING_RE = re.compile(r"^###\s+(C-\d{3}[A-Z]?)\b", re.MULTILINE)
R_ID_RE = re.compile(r"\bR-\d{2}-\d{3}\b")
AC_ID_RE = re.compile(r"\bR-\d{2}-\d{3}/AC-\d{2}\b")
C_ID_RE = re.compile(r"\bC-\d{3}[A-Z]?\b")
R_RANGE_RE = re.compile(r"R-(\d{2})-(\d{3})\s*[～~-]\s*(?:R-(\d{2})-)?(\d{3})")
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
EARS_RE = re.compile(
    r"^-\s*(?:AC-\d{2}\s+)?(?=.*应当)(?:系统|当.+时|若.+|在.+期间|具备.+时)",
    re.MULTILINE,
)
AC_LINE_RE = re.compile(
    r"^-\s*(AC-\d{2})\s+(?=.*应当)(?:系统|当.+时|若.+|在.+期间|具备.+时)",
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
    "AGENTS.md": "f147014436b5f7548e70dd176e1ce4bb7ea02b8d80a80b5c3d998e13850b13c4",
    ".githooks/commit-msg": "8e2d1dd49ab9fd71e8bb3b87fe5786c0ea0314327e58558b518499541e75a51d",
    ".githooks/pre-commit": "83cfb74e7792ed1cf1264105941249d06a37872455faf83297220eb4268325fa",
    ".githooks/pre-push": "c85da06d5f5423959656195835bb570912839e9e65483d3cc20bf096aea9cd4c",
    ".githooks/pre-commit.d/20-agentmap-lint.sh": "95c7df8021cceb8b357c7ea4edafbb2559ddd4179527327f5197ae851d9aa9c4",
    ".githooks/pre-push.d/20-agentmap-lint.sh": "8151ed2cccbb2077f5fafc0a784269fa89815e1a173845c0de90b8563fee6f7d",
    "tools/agentmap_validate_commit_msg.py": "c82459264158781832739346af9a89fbc825b5b1cc8d7d77236ceba7bf11b9cc",
}
HOOK_NAME_PATTERN = re.compile(r"^(?P<order>[0-9]{2})-[a-z0-9][a-z0-9-]*\.sh$")


@dataclass
class Result:
    errors: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    requirements: set[str] = field(default_factory=set)
    acceptance_criteria: set[str] = field(default_factory=set)
    solution_covered: set[str] = field(default_factory=set)
    decision_ids: set[str] = field(default_factory=set)
    test_anchored: set[str] = field(default_factory=set)
    test_anchored_acceptance_criteria: set[str] = field(default_factory=set)
    goals: set[str] = field(default_factory=set)
    tasks: dict[str, int] = field(default_factory=dict)
    task_states: dict[str, str] = field(default_factory=dict)


def parse_frontmatter(path: Path) -> dict[str, str] | None:
    text = path.read_text(encoding="utf-8")
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


def expand_requirement_ids(text: str) -> set[str]:
    ids = set(R_ID_RE.findall(text))
    for group, start, end_group, end in R_RANGE_RE.findall(text):
        if end_group and end_group != group:
            continue
        first, last = int(start), int(end)
        if first <= last and last - first <= 100:
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
    text = target.read_text(encoding="utf-8")
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
        if re.search(r"\b(?:TBD|TODO|N/A)\b|待评估|待定|待补", applicability, re.IGNORECASE):
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
        if re.search(r"\b(?:TBD|TODO|N/A)\b|待评估|待定|待补", applicability, re.IGNORECASE):
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
        if evidence == "—" or re.search(r"\b(?:TBD|TODO|N/A)\b|待评估|待定|待补", evidence, re.IGNORECASE):
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
            result.warnings.append(
                f"legacy map file {name} in use; migrate to {canonical} "
                "via bootstrap --migrate-legacy-maps"
            )
        if not path.exists():
            result.errors.append(f"missing: {name}")
            continue
        fm = parse_frontmatter(path)
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
        if name in APPEND_ONLY_FILES:
            text = path.read_text(encoding="utf-8")
            current_entries = decision_entries(text)
            appended = ""
            if name in changed:
                entries_old = decision_entries(head_decision_text(root))
                if entries_old and not current_entries.startswith(entries_old):
                    result.errors.append(
                        f"{name}: append-only content was modified or removed"
                    )
                elif entries_old:
                    appended = current_entries[len(entries_old):]
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
    for line_number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        if line.startswith("- ") and not TODO_ENTRY_RE.match(line):
            result.errors.append(
                f"TODO.md:{line_number}: entry needs one valid intake type tag"
            )


def check_traceability(root: Path, result: Result) -> None:
    prd_path = root / "PRD.md"
    solution_path = resolve_map_file(root, "SOLUTION.md")
    domain_path = root / "DOMAIN.md"
    decisions_path = resolve_map_file(root, "RATIONALE.md")
    if not all(path and path.exists() for path in (prd_path, solution_path, domain_path, decisions_path)):
        return

    prd = prd_path.read_text(encoding="utf-8")
    solution = solution_path.read_text(encoding="utf-8")
    domain = domain_path.read_text(encoding="utf-8")
    decisions = decisions_path.read_text(encoding="utf-8")
    conventions_path = root / "CONVENTIONS.md"
    conventions = conventions_path.read_text(encoding="utf-8") if conventions_path.is_file() else ""
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

    for goal in sorted(result.goals - used_goals):
        result.errors.append(f"PRD.md: {goal} has no requirement")
    for rid in sorted(expand_requirement_ids(solution_plain) - result.requirements):
        result.errors.append(f"SOLUTION.md: references missing requirement {rid}")
    for cid in sorted(set(C_ID_RE.findall(solution_plain)) - set(decision_ids)):
        result.errors.append(f"SOLUTION.md: references missing decision {cid}")


def task_state(text: str) -> str | None:
    match = re.search(
        r"^状态:\s*(active|completed|abandoned|superseded)\s*$", text, re.MULTILINE
    )
    return match.group(1) if match else None


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


def merge_task_renumbering(root: Path, merge_head: str | None) -> list[tuple[Path, Path]]:
    if merge_head is None:
        return []
    try:
        merge_base = subprocess.run(
            ["git", "merge-base", "HEAD", merge_head],
            cwd=root,
            check=True,
            capture_output=True,
            text=True,
        ).stdout.strip()
        names = subprocess.run(
            [
                "git",
                "diff",
                "--name-only",
                "--diff-filter=A",
                merge_base,
                merge_head,
                "--",
                "tasks",
            ],
            cwd=root,
            check=True,
            capture_output=True,
            text=True,
        ).stdout.splitlines()
    except (OSError, subprocess.CalledProcessError):
        return []
    incoming = sorted(
        (Path(name) for name in names if TASK_NAME_RE.match(Path(name).name)),
        key=lambda path: int(path.name[2:5]),
    )
    target_ids = {path.name[:5] for path in task_paths_at_ref(root, "HEAD")}
    incoming_ids = [path.name[:5] for path in incoming]
    if not target_ids.intersection(incoming_ids):
        return []
    next_number = max((int(task_id[2:]) for task_id in target_ids), default=0) + 1
    return [
        (
            path,
            path.with_name(
                path.name.replace(task_id, f"T-{next_number + index:03d}", 1)
            ),
        )
        for index, (path, task_id) in enumerate(zip(incoming, incoming_ids))
    ]


def replace_task_ids(text: str, mapping: dict[str, str]) -> str:
    return T_ID_RE.sub(lambda match: mapping.get(match.group(), match.group()), text)


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


def adoption_commit(root: Path, tip: str) -> str | None:
    commits = subprocess.run(
        [
            "git",
            "log",
            "--reverse",
            "--diff-filter=A",
            "--format=%H",
            tip,
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


def outgoing_commits(root: Path, input_text: str, result: Result) -> list[str]:
    commits: list[str] = []
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
        for commit in history.stdout.splitlines():
            if commit not in seen:
                seen.add(commit)
                commits.append(commit)
    return commits


def task_renumbering(old: dict[Path, str], new: dict[Path, str]) -> tuple[dict[Path, Path], dict[str, str]]:
    paths: dict[Path, Path] = {}
    ids: dict[str, str] = {}
    for old_path in old:
        matches = [
            new_path
            for new_path in new
            if new_path.name[5:] == old_path.name[5:] and new_path.name[:5] != old_path.name[:5]
        ]
        if len(matches) == 1:
            paths[old_path] = matches[0]
            ids[old_path.name[:5]] = matches[0].name[:5]
    return paths, ids


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
        if new_entry is None or not decision_entries(new_entry[1]).startswith(decision_entries(old_text)):
            result.errors.append(f"{commit[:12]}: {old_name} modified or removed existing history")
    if check_additions and new_entry is not None:
        old_ids = set(C_HEADING_RE.findall(decision_entries(old_entry[1]))) if old_entry else set()
        for cid in set(C_HEADING_RE.findall(decision_entries(new_entry[1]))) - old_ids:
            if re.fullmatch(r"C-\d{3}[A-Z]", cid):
                result.errors.append(f"{commit[:12]}: new decision id {cid} cannot use a legacy suffix")

    old_tasks = ref_task_texts(root, parent)
    new_tasks = ref_task_texts(root, commit)
    renamed_paths, renamed_ids = task_renumbering(old_tasks, new_tasks)
    for path, old_text in old_tasks.items():
        if task_state(old_text) not in TERMINAL_STATES:
            continue
        if new_tasks.get(path) == old_text:
            continue
        renamed = renamed_paths.get(path)
        if renamed and new_tasks.get(renamed) == replace_task_ids(old_text, renamed_ids):
            continue
        result.errors.append(f"{commit[:12]}: {path} changed after reaching a terminal state")

    if not check_additions:
        return
    reverse_renames = {new: old for old, new in renamed_paths.items()}
    for path, text in new_tasks.items():
        if task_state(text) not in TERMINAL_STATES or path in old_tasks:
            continue
        source = reverse_renames.get(path)
        if source is None:
            result.errors.append(f"{commit[:12]}: {path} was created directly in a terminal state")


def check_outgoing_history(root: Path, result: Result, input_text: str) -> None:
    for commit in outgoing_commits(root, input_text, result):
        baseline = adoption_commit(root, commit)
        if baseline is None or commit == baseline or not is_ancestor(root, baseline, commit):
            continue
        parents = commit_parents(root, commit)
        for index, parent in enumerate(parents):
            check_history_transition(root, result, parent, commit, check_additions=index == 0)


def check_merge_task_renumbering(
    root: Path, result: Result, merge_head: str, renumbering: list[tuple[Path, Path]]
) -> set[str]:
    mapping = {source.name[:5]: target.name[:5] for source, target in renumbering}
    for source, target in renumbering:
        old = git_ref_text(root, merge_head, source)
        current = (
            (root / target).read_text(encoding="utf-8")
            if (root / target).is_file()
            else None
        )
        if old is None or current != replace_task_ids(old, mapping):
            result.errors.append(
                f"tasks/: incoming {source.name[:5]} should be renumbered to "
                f"{target.name[:5]} without other changes"
            )
    return set(mapping.values())


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
    text = path.read_text(encoding="utf-8")
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
    match = re.search(
        r"^-\s*代码审核起始 task:\s*T-(\d{3})\s*$",
        path.read_text(encoding="utf-8"),
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
    root: Path, result: Result, path: Path, text: str, require_matrix: bool
) -> None:
    relative = path.relative_to(root).as_posix()
    for heading in ("背景与目标", "差距评估", "收敛方案", "测试计划"):
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
        if re.search(r"\b(?:TBD|TODO|N/A)\b|待补", f"{applicability} {evidence}", re.IGNORECASE):
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
    merge_renumbering = merge_task_renumbering(root, merge_head)
    merge_task_ids = (
        check_merge_task_renumbering(root, result, merge_head, merge_renumbering)
        if merge_head and merge_renumbering
        else set()
    )
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
        text = path.read_text(encoding="utf-8")
        current_state = task_state(text)
        fm = parse_frontmatter(path)
        if fm is None or fm.get("doc-type") != "task":
            result.errors.append(f"tasks/{path.name}: doc-type should be task")
            continue
        require_review = False
        risk: list[str] = []
        if name_match and fm.get("id") != name_match.group(1):
            result.errors.append(
                f"tasks/{path.name}: id should be {name_match.group(1)}, got {fm.get('id')}"
            )
        if name_match:
            task_id = name_match.group(1)
            task_ids.append(task_id)
            require_matrix = matrix_start is not None and int(task_id[2:]) >= matrix_start
            require_review = review_start is not None and int(task_id[2:]) >= review_start
            check_task_sections(root, result, path, text, require_matrix)
            risk = re.findall(r"^风险等级:\s*(standard|high)\s*$", text, re.MULTILINE)
            if require_review and len(risk) != 1:
                result.errors.append(f"tasks/{path.name}: needs exactly one 风险等级: standard or high")
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
                for label in labels:
                    if not re.search(rf"^-\s*{label}:\s*\S", evidence, re.MULTILINE):
                        result.errors.append(
                            f"tasks/{path.name}: completed task needs {label} evidence"
                        )
                commits = re.findall(r"^-\s*commit:\s*(\S+)", evidence, re.MULTILINE)
                if commits and not all(
                    re.fullmatch(r"[0-9a-f]{7,40}", item)
                    and resolves_to_reachable_commit(root, item)
                    for item in commits
                ):
                    result.errors.append(
                        f"tasks/{path.name}: commit evidence must resolve to a reachable commit"
                    )
                if require_review and not re.search(
                    r"^-[ \t]*review:[ \t]*(?:\S.*)?$", evidence, re.MULTILINE
                ):
                    result.errors.append(
                        f"tasks/{path.name}: completed task needs independent code review evidence"
                    )
                elif require_review and (old is None or task_state(old) not in TERMINAL_STATES):
                    check_review_evidence(root, result, path, evidence)
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
            if old_state in TERMINAL_STATES and changed_old != text:
                result.errors.append(f"tasks/{path.name}: terminal task is immutable")
    for task_id in sorted(duplicate_ids(task_ids)):
        result.errors.append(f"tasks/: duplicate task id {task_id}")
    for task_id in sorted((set(new_task_ids) & historical_ids) - merge_task_ids):
        result.errors.append(f"tasks/: reused task id {task_id}")
    if merge_task_ids:
        for task_id in sorted(set(new_task_ids) - merge_task_ids):
            result.errors.append(f"tasks/: unexpected new task id during reconciliation: {task_id}")
    elif new_task_ids:
        next_number = max((int(task_id[2:]) for task_id in historical_ids), default=0) + 1
        actual = sorted({int(task_id[2:]) for task_id in new_task_ids})
        expected = list(range(next_number, next_number + len(actual)))
        if actual != expected:
            got = ", ".join(f"T-{number:03d}" for number in actual)
            result.errors.append(
                f"tasks/: new task ids must continue from T-{next_number:03d}, got {got}"
            )
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


def test_anchor_patterns(root: Path) -> list[str]:
    path = root / "CONVENTIONS.md"
    if not path.is_file():
        return []
    values = re.findall(
        r"^-\s*测试锚点路径:\s*(.+?)\s*$", path.read_text(encoding="utf-8"), re.MULTILINE
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
    patterns = test_anchor_patterns(root)
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
    prd = prd_path.read_text(encoding="utf-8") if prd_path.is_file() else ""
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
    match = re.search(
        r"^-\s*代码锚点:\s*(\S+)\s*$",
        conventions.read_text(encoding="utf-8"),
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
    patterns = test_anchor_patterns(root)
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
            text = path.read_text(encoding="utf-8")
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
        text = conventions.read_text(encoding="utf-8")
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
    text = conventions.read_text(encoding="utf-8")
    match = re.search(r"^-\s*测试锚定模式:\s*(.+?)\s*$", text, re.MULTILINE)
    if not match:
        result.errors.append("CONVENTIONS.md: missing 测试锚定模式: strict or migration T-nnn")
        return True
    mode = match.group(1)
    if mode == "strict":
        return True
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
    check_system_files(root, result, changed)
    check_todo_entries(root, result)
    check_traceability(root, result)
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
- 需求组 01: User
- 验证矩阵起始 task: T-001
- 代码审核起始 task: T-001
- 测试锚定模式: strict
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
    (root / "AGENTS.md").write_bytes((Path(__file__).parents[1] / "AGENTS.md").read_bytes())
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
风险等级: standard
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


def self_test_merge_task_renumbering() -> None:
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
        target_branch = subprocess.run(
            ["git", "branch", "--show-current"],
            cwd=root,
            check=True,
            capture_output=True,
            text=True,
        ).stdout.strip()
        implementation_commit = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=root,
            check=True,
            capture_output=True,
            text=True,
        ).stdout.strip()
        task = (root / "tasks/T-001-20260801-search.md").read_text(encoding="utf-8")
        incoming = root / "tasks/T-002-20260802-incoming.md"
        incoming.write_text(
            task.replace("id: T-001", "id: T-002")
            .replace("# Search", "# Incoming")
            .replace("关联: R-01-001 → Search", "关联: T-003")
            .replace("状态: active", "状态: completed")
            + f"""
- 实现: merged
- 测试: passed
- SOLUTION 对照: SOLUTION 与实现一致
- review:
  - 审核方: reviewer-agent
  - 目的理解: 验证 incoming task 的合并目标
  - 执行方式: code-review skill
  - 问题与修复: 无
  - 复审结论: pass
- commit: {implementation_commit}
""",
            encoding="utf-8",
        )
        followup = root / "tasks/T-003-20260802-followup.md"
        followup.write_text(
            task.replace("id: T-001", "id: T-003")
            .replace("# Search", "# Followup")
            .replace("关联: R-01-001 → Search", "关联: T-002"),
            encoding="utf-8",
        )
        subprocess.run(["git", "switch", "-qc", "incoming"], cwd=root, check=True)
        subprocess.run(["git", "add", "tasks"], cwd=root, check=True)
        subprocess.run(
            ["git", "-c", "core.hooksPath=/dev/null", "commit", "-qm", "incoming tasks"],
            cwd=root,
            check=True,
        )
        subprocess.run(["git", "switch", "-q", target_branch], cwd=root, check=True)
        target = root / "tasks/T-002-20260802-target.md"
        target.write_text(
            task.replace("id: T-001", "id: T-002").replace("# Search", "# Target"),
            encoding="utf-8",
        )
        subprocess.run(["git", "add", "tasks"], cwd=root, check=True)
        subprocess.run(
            ["git", "-c", "core.hooksPath=/dev/null", "commit", "-qm", "target task"],
            cwd=root,
            check=True,
        )
        subprocess.run(
            [
                "git",
                "-c",
                "core.hooksPath=/dev/null",
                "merge",
                "--no-commit",
                "--no-ff",
                "incoming",
            ],
            cwd=root,
            check=True,
            capture_output=True,
        )
        unresolved = lint(root, strict_tests=True)
        assert any("incoming T-002 should be renumbered to T-003" in error for error in unresolved.errors)
        assert any("incoming T-003 should be renumbered to T-004" in error for error in unresolved.errors)

        mapping = {"T-002": "T-003", "T-003": "T-004"}
        for old, new in ((incoming, incoming.with_name("T-003-20260802-incoming.md")),
                         (followup, followup.with_name("T-004-20260802-followup.md"))):
            text = old.read_text(encoding="utf-8")
            old.unlink()
            new.write_text(replace_task_ids(text, mapping), encoding="utf-8")
        resolved = lint(root, strict_tests=True)
        assert not resolved.errors, resolved.errors


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
        assert any("new task ids must continue from T-002" in error for error in skipped_task_id.errors)
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
        assert "T-002" in historical_task_ids(root)
    self_test_merge_task_renumbering()
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
    if args.staged:
        with staged_checkout(root) as snapshot:
            result = lint(snapshot, strict_tests=args.strict_tests)
    else:
        result = lint(root, strict_tests=args.strict_tests)
    if args.pre_push:
        check_outgoing_history(root, result, sys.stdin.read())
    print_result(result, args.report)
    return bool(result.errors)


if __name__ == "__main__":
    sys.exit(main())
