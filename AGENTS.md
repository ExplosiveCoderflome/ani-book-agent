# Project Guidance

## Product Boundary

- This is an independent Mastra-based Agent application.
- `G:\documents\ani-book-skill` and `D:\code\AI-Novel-Writing-Assistant-v2` are read-only design sources, never runtime dependencies.
- Optimize for beginners completing a full Chinese novel.
- Keep one serial chapter-production chain per novel.

## Architecture Authority

- Mastra is the only Agent execution runtime. Do not introduce a second Agent loop, workflow engine, model router, trace store, or memory framework.
- Domain policy owns legal state transitions, permissions, idempotency, author protection, and stale propagation.
- Mastra Workflow owns execution, retries, suspend/resume, streaming, tracing, and evaluation.
- Mastra Agents own creative judgment and tool selection; they cannot write authoritative artifacts directly.

## Data Authority

- Versioned Markdown/YAML is authoritative for creative artifacts and author decisions.
- `novel-state.yaml` is authoritative for novel production progress.
- Mastra storage is authoritative only for operational snapshots, traces, evaluations, approvals, and conversational memory.
- Memory and vector recall are never authoritative novel facts.
- Never overwrite protected or user-edited prose without explicit approval.

## AI Contracts

- Every product prompt is a named, versioned asset with context requirements and a structured output contract.
- AI owns creative interpretation, planning, prose, diagnosis, and repair proposals.
- Deterministic code validates AI output before any domain commit.
- Do not add keyword or regular-expression routing as a fallback for AI-native product behavior.

## Development

- Use Node.js 22.18 or newer, TypeScript, ESM, and UTF-8.
- Dependencies flow inward: Mastra/UI/infrastructure -> application -> domain.
- Domain modules must not import Mastra.
- Add the smallest runnable test for every non-trivial domain rule.
- Do not copy whole modules or database schemas from either source project.
