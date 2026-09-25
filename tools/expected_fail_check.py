#!/usr/bin/env python3
"""预期失败账本校验（顾问 adv-8/adv-9 门槛 1 机械化；C-011、C-012）。

运行测试套件（TAP reporter），对 `test/expected-fail.json` 账本做三重校验：

1. 标题集合相等：实际失败集合与账本集合必须完全相等——
   实际失败 ⊃ 账本 → 计划外失败（回归或坏锚点），错误；
   账本项不再失败 → 已转绿，账本过期——错误并要求移除条目
   （转绿以运行输出为凭，禁止叙述性宣布）。
2. 失败签名核对：账本每项的 `expect` 标记（AssertionError/TypeError/
   ERR_MODULE_NOT_FOUND/导出缺失等）必须出现在该条目的 TAP 失败详情块中
   ——同一测试以不同原因失败（如断言失败退化为 crash）会被拒绝。
3. 执行计数核对：TAP 计划行 `1..N` 必须等于 ok+not ok 之和，且与账本
   `baselineExecuted` 一致——runner 中途 bail-out 使部分测试未执行时立即暴露
   （「账本外零失败」升级为「账本外零失败且计划全量执行」）。

迁移期容忍账本内失败；迁移终态由 anchor_coverage 的僵尸规则接管。
"""

from __future__ import annotations

import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
LEDGER = ROOT / "test" / "expected-fail.json"
PLAN_RE = re.compile(r"^1\.\.(\d+)\s*$")
ENTRY_RE = re.compile(r"^(?:ok|not ok) (\d+) - (.*)$")


def run_suite() -> tuple[dict[str, list[str]], set[str], int | None]:
    """Run the suite with TAP; return {title: detail lines}, passing set, plan total."""
    command = ["node", "--test", "--test-reporter=tap", "test/**/*.test.js"]
    proc = subprocess.run(command, cwd=ROOT, capture_output=True, text=True)
    details: dict[str, list[str]] = {}
    passing: set[str] = set()
    executed: list[str] = []
    plan_total: int | None = None
    current: str | None = None
    current_failed: bool = False
    for line in proc.stdout.splitlines():
        plan_match = PLAN_RE.match(line)
        if plan_match:
            plan_total = int(plan_match.group(1))
            current = None
            continue
        entry = ENTRY_RE.match(line)
        if entry:
            number, raw_title = entry.group(1), entry.group(2)
            title = raw_title.split("#", 1)[0].strip()
            current = title
            current_failed = line.startswith("not ok")
            executed.append(title)
            details.setdefault(title, [])
            if current_failed:
                pass
            else:
                passing.add(title)
            continue
        if line.startswith("  ") and current:
            details[current].append(line.strip())
    if plan_total is None and executed:
        plan_total = len(executed)
    return details, passing, plan_total


def compare(details: dict[str, list[str]], passing: set[str], ledger: dict, plan_total: int | None) -> list[str]:
    expected: set[str] = {entry["test"] for entry in ledger.get("entries", [])}
    expected |= {item["file"] for item in ledger.get("files", [])}
    failing = set(details) - passing
    errors: list[str] = []

    unexpected = sorted(failing - expected)
    if unexpected:
        errors.append("计划外失败（不在账本）:")
        errors.extend(f"  - {item}" for item in unexpected)

    stale = sorted(expected - failing)
    if stale:
        errors.append("账本条目已转绿，请从 test/expected-fail.json 移除（转绿以运行输出为凭）:")
        errors.extend(f"  - {item}" for item in stale)

    # 失败签名核对：账本 expect 标记必须出现在该条目的详情块中
    entries_by_title = {entry["test"]: entry for entry in ledger.get("entries", [])}
    files_by_name = {item["file"]: item for item in ledger.get("files", [])}
    for title in sorted(failing & expected):
        block = "\n".join(details.get(title, []))
        marker = None
        if title in entries_by_title:
            marker = entries_by_title[title].get("expect")
        elif title in files_by_name:
            marker = files_by_name[title].get("expect")
        if marker and marker not in block:
            errors.append(f"失败签名不符（账本 expect={marker!r} 未出现在失败详情中）: {title}")

    # 执行计数核对：bail-out 立即暴露
    if plan_total is not None and plan_total != len(failing) + len(passing):
        errors.append(
            f"执行计数不符：TAP 计划 {plan_total} != 失败 {len(failing)} + 通过 {len(passing)}"
            "——存在未执行的测试（runner bail-out？）"
        )
    baseline = ledger.get("baselineExecuted")
    if plan_total is not None and isinstance(baseline, int) and plan_total != baseline:
        errors.append(f"执行总数偏离账本基线：plan={plan_total} baselineExecuted={baseline}（新增/移除测试后须更新账本基线）")
    return errors


def self_test() -> int:
    """合成 fixture 实跑两条报错分支（adv-9 收口项 3）：留存输出与判定。"""
    ledger = {
        "entries": [
            {"test": "用例甲", "expect": "Expected values to be strictly equal"},
            {"test": "用例乙", "expect": "Expected values to be strictly equal"},
        ],
        "files": [],
        "baselineExecuted": 2,
    }
    # 场景一：账本条目已转绿（乙通过、甲失败）→ stale 报错
    details = {"用例甲": ["Expected values to be strictly equal: + actual - expected"]}
    passing = {"用例乙"}
    errors = compare(details, passing, ledger, 2)
    fired_stale = any("已转绿" in e for e in errors)
    print(f"[self-test:turned-green] errors={errors}")
    # 场景二：计划外失败（多出一个未知失败）→ unexpected 报错（独立账本基线 3）
    ledger2 = dict(ledger, baselineExecuted=3)
    details2 = {
        "用例甲": ["Expected values to be strictly equal: + actual - expected"],
        "用例乙": ["Expected values to be strictly equal: + actual - expected"],
        "计划外用例": ["Some unexpected crash"],
    }
    errors2 = compare(details2, set(), ledger2, 3)
    fired_unexpected = any("计划外失败" in e for e in errors2) and any(
        "计划外用例" in e for e in errors2
    )
    print(f"[self-test:unexpected] errors={errors2}")
    # 场景三：集合相等 + 签名匹配 → 通过
    details3 = {
        "用例甲": ["Expected values to be strictly equal: + actual - expected"],
        "用例乙": ["Expected values to be strictly equal: + actual - expected"],
    }
    errors3 = compare(details3, set(), ledger, 2)
    fired_signature = any("失败签名不符" in e for e in [])
    print(f"[self-test:equal] errors={errors3}")
    if fired_stale and fired_unexpected and not errors3 and not fired_signature:
        print("[self-test] passed: 转绿分支与计划外分支均触发，相等场景通过")
        return 0
    print("[self-test] failed: 预期分支未按定义触发")
    return 1


def main() -> int:
    if "--self-test" in sys.argv:
        return self_test()
    ledger = json.loads(LEDGER.read_text(encoding="utf-8"))
    details, passing, plan_total = run_suite()
    errors = compare(details, passing, ledger, plan_total)
    failing_count = len(set(details) - passing)
    print(
        f"expected-fail check: failing={failing_count} ledger="
        f"{len(ledger.get('entries', [])) + len(ledger.get('files', []))}"
        f" executed={plan_total}"
    )
    if errors:
        print("expected-fail failed:")
        for error in errors:
            print(error)
        return 1
    print("expected-fail passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
