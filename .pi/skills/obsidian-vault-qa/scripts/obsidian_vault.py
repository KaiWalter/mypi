#!/usr/bin/env python3
from __future__ import annotations

import argparse
import os
import re
import sys
from collections import defaultdict
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterable

DEFAULT_VAULT = Path("/Users/y1wle/OneDrive - Carl Zeiss AG/Notes")
IGNORED_DIRS = {".obsidian", ".git", "node_modules", ".trash"}
WIKILINK_RE = re.compile(r"\[\[([^\]]+)\]\]")
WORD_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]*")


@dataclass(order=True)
class SearchResult:
    score: float
    path: Path = field(compare=False)
    snippets: list[tuple[int, str]] = field(default_factory=list, compare=False)
    matched_terms: list[str] = field(default_factory=list, compare=False)


class VaultIndex:
    def __init__(self, root: Path):
        self.root = root.expanduser().resolve()
        if not self.root.exists():
            raise FileNotFoundError(f"Vault path does not exist: {self.root}")
        if not self.root.is_dir():
            raise NotADirectoryError(f"Vault path is not a directory: {self.root}")

        self.files: list[Path] = []
        self.by_stem: dict[str, list[Path]] = defaultdict(list)
        self.by_rel_no_ext: dict[str, Path] = {}
        self.by_rel_with_ext: dict[str, Path] = {}
        self._build()

    def _build(self) -> None:
        for dirpath, dirnames, filenames in os.walk(self.root):
            dirnames[:] = [d for d in dirnames if d not in IGNORED_DIRS and not d.startswith(".")]
            for filename in filenames:
                if not filename.lower().endswith(".md"):
                    continue
                path = Path(dirpath) / filename
                rel = path.relative_to(self.root)
                rel_no_ext = rel.with_suffix("")
                self.files.append(path)
                self.by_stem[path.stem.lower()].append(path)
                self.by_rel_no_ext[str(rel_no_ext).replace("\\", "/").lower()] = path
                self.by_rel_with_ext[str(rel).replace("\\", "/").lower()] = path

    def relative(self, path: Path) -> str:
        return str(path.relative_to(self.root)).replace("\\", "/")

    def read_text(self, path: Path) -> str:
        return path.read_text(encoding="utf-8", errors="ignore")

    def resolve_wikilink(self, source: Path, raw_target: str) -> Path | None:
        target = raw_target.split("|", 1)[0].split("#", 1)[0].strip()
        if not target:
            return None

        normalized = target.replace("\\", "/").strip("/").lower()
        if normalized.endswith(".md") and normalized in self.by_rel_with_ext:
            return self.by_rel_with_ext[normalized]
        if normalized in self.by_rel_no_ext:
            return self.by_rel_no_ext[normalized]
        if not normalized.endswith(".md") and f"{normalized}.md" in self.by_rel_with_ext:
            return self.by_rel_with_ext[f"{normalized}.md"]

        source_parent = source.relative_to(self.root).parent
        if str(source_parent) != ".":
            candidate = (source_parent / target).as_posix().lower().rstrip("/")
            if candidate in self.by_rel_no_ext:
                return self.by_rel_no_ext[candidate]
            if candidate.endswith(".md") and candidate in self.by_rel_with_ext:
                return self.by_rel_with_ext[candidate]
            if f"{candidate}.md" in self.by_rel_with_ext:
                return self.by_rel_with_ext[f"{candidate}.md"]

        matches = self.by_stem.get(Path(target).stem.lower(), [])
        if not matches:
            return None
        return sorted(matches, key=lambda p: (len(self.relative(p)), self.relative(p)))[0]

    def extract_links(self, path: Path) -> list[Path]:
        text = self.read_text(path)
        resolved: list[Path] = []
        seen: set[Path] = set()
        for match in WIKILINK_RE.finditer(text):
            linked = self.resolve_wikilink(path, match.group(1))
            if linked is None or linked == path or linked in seen:
                continue
            seen.add(linked)
            resolved.append(linked)
        return resolved


def normalize_query(query: str) -> tuple[str, list[str]]:
    phrase = query.strip().lower()
    tokens = [token.lower() for token in WORD_RE.findall(query.lower()) if len(token) >= 2]
    deduped: list[str] = []
    seen: set[str] = set()
    for token in tokens:
        if token not in seen:
            seen.add(token)
            deduped.append(token)
    return phrase, deduped


def score_file(index: VaultIndex, path: Path, query: str, tokens: list[str], max_snippets: int) -> SearchResult | None:
    rel = index.relative(path)
    rel_l = rel.lower()
    stem_l = path.stem.lower()

    text = index.read_text(path)
    text_l = text.lower()
    lines = text.splitlines()

    score = 0.0
    matched_terms: list[str] = []

    if query and query in rel_l:
        score += 30
    if query and query in stem_l:
        score += 35
    if query and query in text_l:
        score += 15

    for token in tokens:
        token_hits = 0
        if token in stem_l:
            score += 12
            token_hits += 1
        if token in rel_l:
            score += 8
            token_hits += 1

        count = text_l.count(token)
        if count:
            score += min(count, 12) * 2.0
            token_hits += count

        if token_hits:
            matched_terms.append(token)

    snippets: list[tuple[int, str]] = []
    if query or tokens:
        for lineno, line in enumerate(lines, start=1):
            line_l = line.lower()
            if query and query in line_l:
                snippets.append((lineno, line.strip()))
            elif any(token in line_l for token in tokens):
                snippets.append((lineno, line.strip()))
            if len(snippets) >= max_snippets:
                break

    if score <= 0:
        return None

    if snippets:
        score += min(len(snippets), max_snippets) * 1.5

    return SearchResult(
        score=score,
        path=path,
        snippets=snippets,
        matched_terms=sorted(set(matched_terms)),
    )


def search(index: VaultIndex, query: str, limit: int, max_snippets: int) -> list[SearchResult]:
    phrase, tokens = normalize_query(query)
    results: list[SearchResult] = []
    for path in index.files:
        result = score_file(index, path, phrase, tokens, max_snippets=max_snippets)
        if result is not None:
            results.append(result)
    results.sort(reverse=True)
    return results[:limit]


def format_search_results(index: VaultIndex, query: str, results: list[SearchResult]) -> str:
    lines = [
        f"Vault: {index.root}",
        f"Query: {query}",
        f"Matches: {len(results)}",
        "",
    ]
    if not results:
        lines.append("No matching markdown files found.")
        return "\n".join(lines)

    for i, result in enumerate(results, start=1):
        lines.append(f"{i}. {index.relative(result.path)}  [score={result.score:.1f}]")
        if result.matched_terms:
            lines.append(f"   terms: {', '.join(result.matched_terms)}")
        for lineno, snippet in result.snippets:
            lines.append(f"   L{lineno}: {snippet[:220]}")
        lines.append("")
    return "\n".join(lines).rstrip() + "\n"


def resolve_input_files(index: VaultIndex, files: list[str]) -> list[Path]:
    resolved: list[Path] = []
    seen: set[Path] = set()
    for raw in files:
        path = Path(raw).expanduser()
        candidates: list[Path] = []
        if path.is_absolute():
            candidates.append(path.resolve())
        else:
            candidates.append((index.root / path).resolve())
            rel_key = raw.replace("\\", "/").lower().removesuffix(".md")
            if rel_key in index.by_rel_no_ext:
                candidates.append(index.by_rel_no_ext[rel_key])
            if f"{rel_key}.md" in index.by_rel_with_ext:
                candidates.append(index.by_rel_with_ext[f"{rel_key}.md"])

        chosen = next((candidate for candidate in candidates if candidate.exists() and candidate.is_file()), None)
        if chosen is None:
            matches = index.by_stem.get(path.stem.lower(), [])
            if matches:
                chosen = sorted(matches, key=lambda p: (len(index.relative(p)), index.relative(p)))[0]

        if chosen is None:
            raise FileNotFoundError(f"Could not resolve file: {raw}")
        if chosen not in seen:
            seen.add(chosen)
            resolved.append(chosen)
    return resolved


def expand_links(index: VaultIndex, seeds: list[Path], depth: int) -> list[Path]:
    ordered: list[Path] = []
    seen: set[Path] = set()
    frontier = list(seeds)
    for path in frontier:
        if path not in seen:
            seen.add(path)
            ordered.append(path)

    for _ in range(depth):
        next_frontier: list[Path] = []
        for current in frontier:
            for linked in index.extract_links(current):
                if linked in seen:
                    continue
                seen.add(linked)
                ordered.append(linked)
                next_frontier.append(linked)
        frontier = next_frontier
        if not frontier:
            break
    return ordered


def truncate_content(text: str, max_chars: int) -> tuple[str, bool]:
    if len(text) <= max_chars:
        return text, False
    return text[:max_chars].rstrip() + "\n\n[... truncated ...]\n", True


def build_bundle(
    index: VaultIndex,
    query: str | None,
    question: str | None,
    files: list[Path],
    expand_depth: int,
    max_total_chars: int,
    max_file_chars: int,
) -> str:
    expanded_files = expand_links(index, files, depth=expand_depth)
    out: list[str] = [
        "# Obsidian Vault Context Bundle",
        "",
        f"- Vault: `{index.root}`",
        f"- Query: `{query or ''}`",
        f"- Question: `{question or ''}`",
        f"- Seed files: {len(files)}",
        f"- Expanded files: {len(expanded_files)}`" if False else f"- Expanded files: {len(expanded_files)}",
        "",
        "## Included files",
    ]
    out.extend([f"- `{index.relative(path)}`" for path in expanded_files])
    out.append("")

    total_chars = sum(len(part) for part in out)
    for path in expanded_files:
        content = index.read_text(path)
        links = index.extract_links(path)
        trimmed_content, truncated = truncate_content(content, max_file_chars)
        section = [
            f"## File: {index.relative(path)}",
            "",
            f"- Absolute path: `{path}`",
            f"- Wikilinks: {', '.join(f'`{index.relative(link)}`' for link in links) if links else '(none)'}",
            f"- Truncated: {'yes' if truncated else 'no'}",
            "",
            "```markdown",
            trimmed_content.rstrip(),
            "```",
            "",
        ]
        block = "\n".join(section)
        if total_chars + len(block) > max_total_chars:
            remainder = max_total_chars - total_chars
            if remainder > 200:
                block = block[:remainder].rstrip() + "\n\n[Bundle truncated due to max_total_chars]\n"
                out.append(block)
            else:
                out.append("[Bundle truncated due to max_total_chars]\n")
            break
        out.append(block)
        total_chars += len(block)

    return "\n".join(out).rstrip() + "\n"


def cmd_search(args: argparse.Namespace) -> int:
    index = VaultIndex(resolve_vault(args.vault))
    results = search(index, args.query, limit=args.limit, max_snippets=args.max_snippets)
    sys.stdout.write(format_search_results(index, args.query, results))
    return 0


def cmd_bundle(args: argparse.Namespace) -> int:
    index = VaultIndex(resolve_vault(args.vault))

    selected_files: list[Path]
    query = args.query
    if args.files:
        selected_files = resolve_input_files(index, args.files)
    elif query:
        selected_files = [result.path for result in search(index, query, limit=args.limit, max_snippets=args.max_snippets)]
    else:
        raise SystemExit("bundle requires --query or --files")

    if not selected_files:
        raise SystemExit("No matching files found to build a bundle")

    bundle = build_bundle(
        index=index,
        query=query,
        question=args.question,
        files=selected_files,
        expand_depth=args.expand_links,
        max_total_chars=args.max_total_chars,
        max_file_chars=args.max_file_chars,
    )

    output = Path(args.output).expanduser() if args.output else None
    if output is not None:
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(bundle, encoding="utf-8")
        sys.stdout.write(f"Wrote bundle: {output}\n")
        return 0

    sys.stdout.write(bundle)
    return 0


def resolve_vault(cli_value: str | None) -> Path:
    if cli_value:
        return Path(cli_value)
    env_value = os.environ.get("OBSIDIAN_VAULT_PATH")
    if env_value:
        return Path(env_value)
    return DEFAULT_VAULT


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Search an Obsidian vault and build context bundles.")
    parser.add_argument("--vault", help="Path to the Obsidian vault")

    subparsers = parser.add_subparsers(dest="command", required=True)

    search_parser = subparsers.add_parser("search", help="Search for matching markdown files")
    search_parser.add_argument("--query", required=True, help="Search query")
    search_parser.add_argument("--limit", type=int, default=10, help="Max files to return")
    search_parser.add_argument("--max-snippets", type=int, default=3, help="Max snippets per file")
    search_parser.set_defaults(func=cmd_search)

    bundle_parser = subparsers.add_parser("bundle", help="Build a markdown context bundle")
    bundle_group = bundle_parser.add_mutually_exclusive_group(required=True)
    bundle_group.add_argument("--query", help="Search query used to select seed files")
    bundle_group.add_argument("--files", nargs="+", help="Specific markdown files to include as seeds")
    bundle_parser.add_argument("--question", help="User question to record in the bundle")
    bundle_parser.add_argument("--limit", type=int, default=8, help="Seed file count when using --query")
    bundle_parser.add_argument("--max-snippets", type=int, default=3, help="Unused in bundle scoring except for query selection")
    bundle_parser.add_argument("--expand-links", type=int, default=1, help="Wikilink expansion depth")
    bundle_parser.add_argument("--max-total-chars", type=int, default=120000, help="Max characters in the bundle")
    bundle_parser.add_argument("--max-file-chars", type=int, default=12000, help="Max characters per file")
    bundle_parser.add_argument("--output", help="Output path for the bundle")
    bundle_parser.set_defaults(func=cmd_bundle)

    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
