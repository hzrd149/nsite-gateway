# nsite-gateway

- Commit after each significant, coherent change, once relevant checks pass. Use
  a descriptive commit message and include only changes made for the task; do
  not commit unrelated user work.
- Append public-facing features, fixes, and behavior changes to the `Unreleased`
  section of `CHANGELOG.md` in the same change. Keep entries ready for the next
  version release; do not alter previously released version notes.
- Keep permission-heavy integration suites outside `__tests__/`; Deno discovers
  every TypeScript file in that directory during the regular unit-test run.
