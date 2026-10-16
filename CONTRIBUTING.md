# Contributing

Thanks for looking at DevSentinel AI.

## Development setup

```bash
npm install
cp .env.example .env   # set ENCRYPTION_KEY at minimum
npx prisma migrate dev
npm run dev            # app
npm run worker         # background worker (separate terminal)
npm test               # unit tests
```

## Ground rules

1. **Honesty first.** Never fabricate results, statuses, health, or integration state.
   If a feature cannot be completed, implement the boundary, label it in the UI, and
   document it. Every run carries a source label; keep it accurate.
2. **Commit binding is sacred.** A run's `commitSha` is immutable. Status publication
   must re-check the PR head at publish time.
3. **Server-side authorization everywhere.** New resources need a
   `requireProjectAccess`-style check and a cross-user denial story (404, not 403).
4. **Validate external input** with Zod at every boundary; redact secrets through
   `src/lib/redact.ts` before storing or forwarding anything.
5. **Migrations are versioned.** Never edit an applied migration; add a new one.

## Checks before a PR

```bash
npm run lint && npm run typecheck && npm test && npm run build
```

All four must pass. Report test counts honestly in the PR description.
