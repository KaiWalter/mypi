---
name: obsidian-vault-qa
description: Search an Obsidian markdown vault, resolve [[wikilinks]], assemble a focused context bundle from matching notes, and answer questions grounded in those files. Use when the user refers to my notes, notes folder, Obsidian vault, markdown knowledge base, or says things like find in my notes, search my notes, based on the notes, answer from my notes, or what do my notes say about X.
---

# Obsidian Vault Q&A

Use this skill when working with the user's Obsidian vault at `/Users/y1wle/OneDrive - Carl Zeiss AG/Notes`.

Common trigger phrases include:

- "find in my notes ..."
- "search my notes for ..."
- "based on the notes ..."
- "answer from my notes ..."
- "what do my notes say about ..."
- "look in the Obsidian vault ..."

## What this skill does

- Finds relevant markdown files for a natural-language query
- Shows matching snippets and file paths
- Resolves Obsidian `[[wikilinks]]`
- Builds a compact markdown context bundle for question answering

## Vault path

Default vault path:

```bash
/Users/y1wle/OneDrive - Carl Zeiss AG/Notes
```

Override with `--vault <path>` or `OBSIDIAN_VAULT_PATH=/path/to/vault`.

## Commands

From the project root:

```bash
python3 .pi/skills/obsidian-vault-qa/scripts/obsidian_vault.py search --query "your search terms"
```

Create a context bundle from a query:

```bash
python3 .pi/skills/obsidian-vault-qa/scripts/obsidian_vault.py bundle \
  --query "your search terms" \
  --question "your question" \
  --limit 8 \
  --expand-links 1 \
  --output /tmp/obsidian-context.md
```

Create a context bundle from specific files:

```bash
python3 .pi/skills/obsidian-vault-qa/scripts/obsidian_vault.py bundle \
  --files "path/to/note-a.md" "path/to/note-b.md" \
  --question "your question" \
  --expand-links 1 \
  --output /tmp/obsidian-context.md
```

## Recommended workflow

1. Run `search` with the user's query.
2. If the user wants an answer, run `bundle` with the same query and their question.
3. Use `read` on the generated bundle file.
4. Answer only from the included notes and cite note paths.
5. If coverage looks weak, increase `--limit` or `--expand-links` and rebuild.

## Notes

- The script ignores `.obsidian`, `.git`, and `node_modules` directories.
- `bundle` includes the seed files plus linked notes discovered through `[[...]]` references.
- The generated bundle is meant for reading with the `read` tool before answering.
