#!/usr/bin/env python3
"""Validate the Stage 0 product and architecture contract."""

from __future__ import annotations

import re
import sys
from collections import defaultdict
from pathlib import Path
from urllib.parse import unquote


ROOT = Path(__file__).resolve().parents[1]
EXCLUDED_MARKDOWN_TREES = {
    ".git",
    ".pnpm-store",
    "node_modules",
    "dist",
    "build",
    "coverage",
    "tmp",
}

REQUIRED_FILES = (
    "README.md",
    "AGENTS.md",
    "docs/product/product-contract.md",
    "docs/product/definition-of-done.md",
    "docs/reference-projects/README.md",
    "docs/reference-projects/RP-001-euler-polynomial.md",
    "docs/reference-projects/RP-002-finite-sum-lean.md",
    "docs/reference-projects/RP-003-harmonic-oscillator.md",
    "docs/architecture/invariants.md",
    "docs/architecture/project-format-v0.md",
    "docs/architecture/adr/README.md",
    "docs/architecture/adr/0001-open-event-sourced-project.md",
    "docs/architecture/adr/0002-local-first-modular-monolith.md",
    "docs/architecture/adr/0003-typed-reasoning-and-verification.md",
    "docs/architecture/adr/0004-branch-scoped-agent-runtime.md",
    "docs/architecture/adr/0005-typed-tools-and-sandboxed-execution.md",
    "docs/roadmap/stage-0-exit.md",
)

LINK_RE = re.compile(r"(?<!!)\[[^\]]+\]\(([^)]+)\)")
STABLE_ID_RE = re.compile(
    r"\b(?:PC-\d{2}|DOD-[A-Z]+-\d{2}|INV-[A-Z]+-\d{2}|RP-\d{3}-A\d{2})\b"
)
PLACEHOLDER_RE = re.compile(r"\b(?:TODO|TBD|FIXME)\b")


def markdown_files() -> list[Path]:
    return sorted(
        path
        for path in ROOT.rglob("*.md")
        if EXCLUDED_MARKDOWN_TREES.isdisjoint(path.relative_to(ROOT).parts)
    )


def validate_required_files(errors: list[str]) -> None:
    for relative_path in REQUIRED_FILES:
        if not (ROOT / relative_path).is_file():
            errors.append(f"missing required file: {relative_path}")


def validate_links(files: list[Path], errors: list[str]) -> int:
    checked = 0
    for source in files:
        text = source.read_text(encoding="utf-8")
        for raw_target in LINK_RE.findall(text):
            target = raw_target.strip().strip("<>")
            if not target or target.startswith("#"):
                continue
            if re.match(r"^[a-zA-Z][a-zA-Z0-9+.-]*:", target):
                continue
            target_path = unquote(target.split("#", 1)[0])
            if not target_path:
                continue
            checked += 1
            resolved = (source.parent / target_path).resolve()
            if not resolved.exists():
                errors.append(
                    f"broken local link: {source.relative_to(ROOT)} -> {target}"
                )
    return checked


def validate_stable_ids(files: list[Path], errors: list[str]) -> int:
    definitions: dict[str, list[str]] = defaultdict(list)
    for source in files:
        for line_number, line in enumerate(
            source.read_text(encoding="utf-8").splitlines(), start=1
        ):
            # Stable IDs are definitions when they lead a Markdown heading or
            # list item in their normative document.
            if not (line.startswith("### ") or line.startswith("- **")):
                continue
            for stable_id in STABLE_ID_RE.findall(line):
                definitions[stable_id].append(
                    f"{source.relative_to(ROOT)}:{line_number}"
                )

    for stable_id, locations in sorted(definitions.items()):
        if len(locations) > 1:
            errors.append(
                f"duplicate stable ID definition {stable_id}: {', '.join(locations)}"
            )
    return len(definitions)


def validate_placeholders(files: list[Path], errors: list[str]) -> None:
    for source in files:
        for line_number, line in enumerate(
            source.read_text(encoding="utf-8").splitlines(), start=1
        ):
            if PLACEHOLDER_RE.search(line):
                errors.append(
                    f"unresolved placeholder: {source.relative_to(ROOT)}:{line_number}"
                )


def main() -> int:
    errors: list[str] = []
    files = markdown_files()

    validate_required_files(errors)
    checked_links = validate_links(files, errors)
    stable_ids = validate_stable_ids(files, errors)
    validate_placeholders(files, errors)

    if errors:
        for error in errors:
            print(f"ERROR: {error}", file=sys.stderr)
        print(f"Stage 0 validation failed with {len(errors)} error(s).", file=sys.stderr)
        return 1

    print(
        "Stage 0 validation passed: "
        f"{len(files)} Markdown files, {checked_links} local links, "
        f"{stable_ids} stable ID definitions."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
