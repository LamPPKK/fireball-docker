# Fireball session seccomp policy

`moby-default.json` is the verbatim Moby default seccomp profile pinned by
`fireball-session.provenance.json`. `fireball-session.json` is a generated
derivative that retains the deny-by-default policy and adds only the namespace
setup calls documented in the provenance file for WPE WebKit's bubblewrap
sandbox. The exact clone rules assume `session/fireball-bwrap-wrapper.c` has
retained Docker's per-tenant PID namespace and replaced WebKit's nested procfs
mount with a read-only bind of the already masked container procfs. The wrapper
rejects any missing or duplicated invariant and preserves WebKit's own seccomp
argument. The outer policy also permits only the exact
`unshare(CLONE_NEWUSER)` call bubblewrap uses for its second-level `/dev/pts`
setup; all other `unshare` flag sets remain denied.

The upstream profile is distributed under Apache-2.0. Its exact license text is
vendored as `LICENSE-MOBY-PROFILES-APACHE-2.0`. Run
`npm run seccomp:generate` to regenerate network-fetched artifacts, and
`npm run seccomp:check` for the normal offline provenance gate.
