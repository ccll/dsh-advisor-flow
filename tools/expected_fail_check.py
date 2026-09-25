#!/usr/bin/env python3
"""预期失败账本校验（顾问 adv-8 门槛 1 机械化；C-011）。

运行测试套件（TAP reporter），把实际失败集合与 `test/expected-fail.json`
账本做集合相等比较：

- 实际失败 ⊃ 账本 → 存在计划外失败（回归或坏锚点），错误；
- 账本项已不再失败 → 该条目已转绿，账本过期——错误并要求移除条目
  （转绿以运行输出为凭，禁止叙述性宣布）；
- 集合相等 → 通过（迁移期容忍账本内失败，迁移终态由 anchor_coverage
  的僵尸规则接管）。
"""

from __future__ import annotations

import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
LEDGER = ROOT / "test" / "expected-fail.json"


def main() -> int:
    ledger = json.loads(LEDGER.read_text(encoding="utf-8"))
    expected = {entry["test"] for entry in ledger.get("entries", [])}
    expected |= {item["file"] for item in ledger.get("files", [])}

    command = ["node", "--test", "--test-reporter=tap", "test/**/*.test.js"]
    proc = subprocess.run(command, cwd=ROOT, capture_output=True, text=True)
    failing: set[str] = set()
    for line in proc.stdout.splitlines():
        stripped = line.strip()
        if not stripped.startswith("not ok "):
            continue
        rest = stripped[len("not ok ") :]
        # TAP 形如 "not ok <n> - <标题>"；取首个分隔符之后的标题
        title = rest.split(" - ", 1)[1].strip() if " - " in rest else rest.strip()
        title = title.split("#", 1)[0].strip()
        failing.add(title)

    unexpected = sorted(failing - expected)
    stale = sorted(expected - failing)

    print(
        f"expected-fail check: failing={len(failing)} ledger={len(expected)}"
        f" unexpected={len(unexpected)} turned-green={len(stale)}"
    )
    errors = False
    if unexpected:
        errors = True
        print("expected-fail failed: 计划外失败（不在账本）:")
        for item in unexpected:
            print(f"  - {item}")
    if stale:
        errors = True
        print("expected-fail failed: 账本条目已转绿，请从 test/expected-fail.json 移除:")
        for item in stale:
            print(f"  - {item}")
    if not errors:
        print("expected-fail passed")
        return 0
    return 1


if __name__ == "__main__":
    sys.exit(main())
