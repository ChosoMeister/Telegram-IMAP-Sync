# Release and documentation maintenance

Documentation is part of the release contract. `npm run docs:check` rejects missing required documents, a version absent from README/CHANGELOG, or environment variables that drift between `src/config.ts`, `.env.example`, and `docs/CONFIGURATION.md`.

For every behavior or configuration change:

1. Update implementation and tests.
2. Update `.env.example` and `docs/CONFIGURATION.md` together for configuration changes.
3. Update `docs/SPEC.md` for user-visible lifecycle or invariant changes.
4. Update `docs/ARCHITECTURE.md` for state, adapter, recovery, or security changes.
5. Update `docs/OPERATIONS.md` for deployment, migration, health, backup, or troubleshooting changes.
6. Keep `README.md` and `README.fa.md` aligned on features, safety gates, and links.
7. Add a dated `CHANGELOG.md` entry for a release.
8. Run `npm run check`, `npm audit --omit=dev`, `docker compose config --quiet`, and a tracked-tree secret/confidentiality scan.
9. After push, require the GitHub Actions run to pass and verify the expected GHCR architecture/tag metadata.

Do not document local credentials, real mail addresses, private folder rules, API keys, host IPs, Telegram IDs, or production logs.
