# Pi Subagent Tool

A standalone Pi package that exposes a generic `subagent` tool, based on Pi's official subagent extension example.

## What it provides

- A reusable `subagent` tool for delegating tasks to isolated Pi subprocesses
- Support for single, parallel, and chained subagent execution
- JSON-mode event capture from child Pi runs
- Agent discovery from:
  - `~/.pi/agent/agents/*.md`
  - `.pi/agents/*.md`

## Install

```bash
pi install git:github.com/san-tian/pi-subagent-tool
```

Project-local install:

```bash
pi install -l git:github.com/san-tian/pi-subagent-tool
```

## Package contents

- `extensions/subagent/index.ts` - the subagent extension and tool
- `extensions/subagent/agents.ts` - agent discovery helpers

## Notes

This package intentionally focuses on the reusable tool/runtime layer. It does not ship opinionated agent definitions; create your own agent markdown files in `~/.pi/agent/agents/` or `.pi/agents/`.

## Example agent

```md
---
name: reviewer
description: Reviews code for bugs and regressions
tools: read, grep, find, ls
model: claude-sonnet-4-5
---

Review the code carefully. Prioritize bugs, regressions, and missing tests.
```

Save that as `~/.pi/agent/agents/reviewer.md`, then you can ask Pi to use the `subagent` tool with `reviewer`.
