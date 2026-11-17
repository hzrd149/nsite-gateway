# nsite-gateway

- Append public-facing features, fixes, and behavior changes to the `Unreleased`
  section of `CHANGELOG.md` in the same change. Keep entries ready for the next
  version release; do not alter previously released version notes.
- Keep permission-heavy integration suites outside `__tests__/`; Deno discovers
  every TypeScript file in that directory during the regular unit-test run.
