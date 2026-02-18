# APT -- AI Process Tester

## Stack
- Runtime: Bun (NEVER npm/node)
- Language: TypeScript 5.x strict
- CLI: Citty
- Validation: Zod 3.x
- DB: bun:sqlite
- Logging: consola
- Linting: Biome
- Tests: bun test

## Conventions
- All imports use @apt/* path aliases
- Types are centralized in src/lib/types.ts
- Each module follows the Pipeline interface pattern
- Error handling uses ModuleError pattern (src/core/errors.ts)
- Events are typed via APTEventMap (src/core/event-bus.ts)
- Repositories accept Database via constructor (DI)
- Tests go in tests/ mirroring src/ structure

## Commands
- `bun test` -- run all tests
- `bun run typecheck` -- TypeScript check
- `bun run lint` -- Biome lint
- `bun run dev` -- run CLI

## Architecture
5-module pipeline: Introspect -> Map -> Generate -> Execute (IRT) -> Analyze
Each module produces a JSON artifact consumed by the next.
