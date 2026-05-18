# Shipyard Workspace Tools

The Repo Setup Agent can call tools to work inside the assigned workspace.

The workspace root is the only allowed project area. All file paths are relative to that root.

## Fixed Product Guardrails

When workspace tools are used to create frontend files or agent instructions, preserve these rules.

```text
Background: white
Primary text: black
Primary accent/buttons: yellow #E3F848
Style: clean, direct, minimal, business-focused
Avoid: extra color palettes, decorative gradients, fake marketing pages, AI-slop UI
```

## Tools

### list_files

List files and folders under a relative path.

```json
{
  "path": "."
}
```

### read_file

Read a UTF-8 text file in bounded chunks. Use `offset` and `limit` to continue reading large files.

```json
{
  "path": "README.md",
  "offset": 1,
  "limit": 240,
  "max_bytes": 200000
}
```

The result includes `line_count` and `truncated`. If `truncated` is true, call `read_file` again with a larger `offset`.

### glob

Find files and folders by glob pattern inside the workspace.

```json
{
  "pattern": "**/*.py",
  "path": ".",
  "max_entries": 200
}
```

Use this before reading files when you need to discover the repo shape.

### grep

Search text files inside the workspace with a regex pattern. Results are bounded and returned as `path:line:column:text`.

```json
{
  "pattern": "FastAPI",
  "path": ".",
  "glob": "**/*.py",
  "max_matches": 80
}
```

Use this to find symbols, existing text, TODOs, imports, routes, and config keys without reading whole files.

### write_file

Create or replace a UTF-8 text file.

```json
{
  "path": "backend/app/main.py",
  "content": "..."
}
```

### edit_file

Replace one exact text region in one existing file.

```json
{
  "path": "README.md",
  "old_text": "...",
  "new_text": "..."
}
```

### delete_file

Delete one file or folder inside the workspace.

```json
{
  "path": "frontend/src/old-file.tsx"
}
```

### move_file

Move or rename one file or folder inside the workspace.

```json
{
  "source": "backend/app/old.py",
  "destination": "backend/app/routes/items.py"
}
```

### run_command

Run a shell command from a relative working directory inside the workspace. Commands run directly without approval prompts, but paths must stay inside the generated workspace.

```json
{
  "command": "python -m py_compile backend/app/main.py",
  "cwd": ".",
  "timeout_seconds": 30
}
```

## Guardrails

1. Use relative paths only.
2. Do not use `..` path traversal.
3. Do not edit `.git`.
4. Keep generated files focused on the product brief, system design, and API contract.
5. Prefer writing complete files over many tiny edits during initial scaffold creation.
6. Terminal commands run with workspace-local `HOME` and `TMPDIR`.
