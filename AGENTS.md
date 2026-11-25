# Repository Guidelines

## Subagents

<!-- fast-agent-subagents -->

When running inside herdr-core (`$HC_TERMINAL_ID` set), prefer `hc` over the built-in `subagent` tool for delegated implementation, code review, multi-round iteration, parallel file-disjoint workers, cross-repo tasks, and long-running jobs. Reserve `subagent` for quick, strictly one-shot read-only lookups when you need an inline answer inside the current turn with no follow-up.

Good models for delegated work:
 - `codexresponses.gpt-6.2-astra?reasoning=high` — strong OpenAI model excellent for reviews, coordination, and second opinions. It tends to overcomplicate and hunt contrived edge cases on repeat passes: constrain it to favor simplicity/no extra abstractions, take real correctness/parity catches, and push back when fixes add complexity for synthetic inputs.
 - `codexresponses.gpt-6.2-sol?reasoning=high` — excellent and efficient execution and analysis.
 - `copilot.claude-opus-5.5?reasoning=high` — excellent implementor and designer.

Practical `hc` patterns:
 - Launch `fast-agent` workers with `--shell --no-subagents` and a descriptive `--name` (e.g. `hc run --bg --name <name> --cwd <dir> -- fast-agent go --name <name> --model '<model>' --shell --no-subagents`), `hc wait <name>` for readiness, then `hc send <name> ...`.
 - For non-trivial tasks, write a markdown brief (e.g. `/tmp/<slug>-brief.md`) naming the literal parent return address (`hc send <$HC_TERMINAL_ID>`) and verification steps. When parallel workers share a checkout, give each an explicit file allowlist and forbid `git commit`/`checkout`/`stash`/`reset`.
 - Once long-running `hc` children are running and local work is done, end your turn (naming active children) and let `<hc from="...">` or `<hc>` exit notices wake you instead of chaining `hc wait` / `process(action="wait")` loops.
 - Treat worker reports as claims to verify rather than finished truth: spot-check key diffs or outputs, act on caveats a worker flags, and follow up (or run a quick review pass) before building on or reporting their work.
 - Reuse the same reviewer terminal across fix/re-review rounds to keep context and prompt cache warm, then clean up accepted children immediately (`hc kill <name> && hc rm <name>`).
 - `hc` CLI reminders: `hc wait` takes a single `<t>` or `--children all|any` and integer `--timeout <sec>` (no `s` suffix); multi-line `hc send` takes a positional string (`"$(cat <<'EOF' ... EOF)"`, no `--stdin`).

## Project Structure & Module Organization

- `packages/app`: MCP server plus management web UI. Server code lives in `packages/app/src/server`, UI in `packages/app/src/web`, and tests in `packages/app/test`.
- `packages/mcp`: shared MCP tools/library consumed by the server. Source is in `packages/mcp/src`, with tests in `packages/mcp/test` and a few `*.test.ts` files co-located in `src`.
- `packages/e2e-python`: Python-based end-to-end harnesses and fixtures.
- Root-level docs and support files live in `docs/`, `docs-internal/`, `scripts/`, `spec/`, and `Dockerfile`.

## Build, Test, and Development Commands

- `pnpm install`: install workspace dependencies (Corepack-managed pnpm).
- `pnpm build`: build all workspace packages.
- `pnpm dev`: watch the MCP package and run the server with HMR.
- `pnpm start`: start the production server from `packages/app`.
- `pnpm lint`, `pnpm typecheck`, `pnpm format`, `pnpm test`: run repo-wide checks.
- Package-specific tests: `pnpm -C packages/app test` or `pnpm -C packages/mcp test`.
- Full local pipeline: `pnpm run buildrun` (clean, build, lint, test, start).

## Coding Style & Naming Conventions

- TypeScript ESM across packages.
- Prettier enforces tabs (`useTabs: true`, `tabWidth: 2`), semicolons, single quotes, and `printWidth: 120`.
- ESLint rules are strict in `packages/mcp` and server code (no `any`, consistent type imports, prefer `interface` type definitions).
- Tests use `.test.ts` or `.spec.ts` naming.

## Testing Guidelines

- Unit/integration tests run with Vitest in both `packages/app` and `packages/mcp`.
- Run all tests with `pnpm test` or package-specific commands above.
- No explicit coverage gate is configured; add tests for new tools, transports, or formatting logic.

## Commit & Pull Request Guidelines

- Recent history mixes merge commits and conventional-style messages like `chore: release vX`; no enforced convention.
- Keep commits small and descriptive; add a scope when it clarifies the area (`app`, `mcp`).
- PRs should include a concise summary, test results, linked issue (if applicable), and screenshots for UI changes under `packages/app/src/web`.

## Security & Configuration Tips

- Provide auth via environment variables (`DEFAULT_HF_TOKEN`, `HF_TOKEN`); do not commit secrets.
- `TRANSPORT` controls server mode (`stdio`, `streamableHttp`, `streamableHttpJson`). Document any new env vars in `README.md`.
