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
    skips = 0
    current: str | None = None
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
            executed.append(title)
            details.setdefault(title, [])
            if "# SKIP" in raw_title or "# skip" in raw_title:
                skips += 1
            if line.startswith("not ok"):
                continue
            passing.add(title)
            continue
        if line.startswith("  ") and current:
            details[current].append(line.strip())
    if plan_total is None and executed:
        plan_total = len(executed)
    return details, passing, plan_total, skips


def compare(
    details: dict[str, list[str]],
    passing: set[str],
    ledger: dict,
    plan_total: int | None,
    skips: int = 0,
) -> list[str]:
    expected: set[str] = {entry["test"] for entry in ledger.get("entries", [])}
    expected |= {item["file"] for item in ledger.get("files", [])}
    failing = set(details) - passing
    errors: list[str] = []

    # 计数等式隐含零 skip/todo：skip 是「已执行未运行」，须显式暴露
    if skips:
        errors.append(f"存在 {skips} 个 skip/todo 测试——计数等式隐含零 skip，请显式处置")


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
    """合成 fixture 实跑全部分支并精确断言错误集（adv-9/adv-10 收口）。"""
    failures: list[str] = []
    ledger = {
        "entries": [
            {"test": "用例甲", "expect": "Expected values to be strictly equal"},
            {"test": "用例乙", "expect": "Expected values to be strictly equal"},
        ],
        "files": [],
        "baselineExecuted": 2,
    }
    detail = ["Expected values to be strictly equal: + actual - expected"]

    # 场景一：账本条目已转绿 → stale 报错（错误集精确匹配）
    errors = compare({"用例甲": detail}, {"用例乙"}, ledger, 2)
    expected_errors = [
        "账本条目已转绿，请从 test/expected-fail.json 移除（转绿以运行输出为凭）:",
        "  - 用例乙",
    ]
    print(f"[self-test:turned-green] errors={errors}")
    if errors != expected_errors:
        failures.append(f"turned-green 场景错误集不符: {errors}")

    # 场景二：计划外失败 → unexpected 逐项列出（独立账本基线 3）
    ledger2 = dict(ledger, baselineExecuted=3)
    errors2 = compare(
        {"用例甲": detail, "用例乙": detail, "计划外用例": ["Some unexpected crash"]},
        set(),
        ledger2,
        3,
    )
    print(f"[self-test:unexpected] errors={errors2}")
    if not any("计划外失败" in e for e in errors2) or not any(
        "  - 计划外用例" in e for e in errors2
    ):
        failures.append(f"unexpected 场景未逐项列出计划外用例: {errors2}")

    # 场景三：集合相等 + 签名匹配 → 零错误
    errors3 = compare({"用例甲": detail, "用例乙": detail}, set(), ledger, 2)
    print(f"[self-test:equal] errors={errors3}")
    if errors3 != []:
        failures.append(f"相等场景应零错误: {errors3}")

    # 场景四：签名不匹配（账本 expect 标记未出现在详情）→ 失败签名不符
    ledger4 = {
        "entries": [{"test": "用例甲", "expect": "NeverAppears"}],
        "files": [],
        "baselineExecuted": 1,
    }
    errors4 = compare({"用例甲": detail}, set(), ledger4, 1)
    print(f"[self-test:signature-mismatch] errors={errors4}")
    if not any("失败签名不符" in e and "NeverAppears" in e for e in errors4):
        failures.append(f"签名不匹配场景未触发: {errors4}")

    # 场景五：bail-out（计划数 5 > 失败+通过 1）→ 执行计数不符
    ledger5 = {
        "entries": [{"test": "用例甲", "expect": "Expected values to be strictly equal"}],
        "files": [],
        "baselineExecuted": 5,
    }
    errors5 = compare({"用例甲": detail}, set(), ledger5, 5)
    print(f"[self-test:bail-out] errors={errors5}")
    if not any("执行计数不符" in e for e in errors5):
        failures.append(f"bail-out 场景未触发: {errors5}")

    # 场景六：skip/todo 显式暴露（计数等式隐含零 skip）
    errors6 = compare({}, set(), {"entries": [], "files": []}, 0, skips=1)
    print(f"[self-test:skip] errors={errors6}")
    if not any("skip/todo" in e for e in errors6):
        failures.append(f"skip 场景未触发: {errors6}")

    if failures:
        print("[self-test] failed:")
        for failure in failures:
            print(f"  - {failure}")
        return 1
    print("[self-test] passed: 六场景（转绿/计划外/相等/签名不符/bail-out/skip）全部按定义触发")
    return 0


def main() -> int:
    if "--self-test" in sys.argv:
        return self_test()
    ledger = json.loads(LEDGER.read_text(encoding="utf-8"))
    details, passing, plan_total, skips = run_suite()
    errors = compare(details, passing, ledger, plan_total, skips)
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
