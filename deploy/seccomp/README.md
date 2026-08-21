# Fireball session seccomp policy

`moby-default.json` is the verbatim Moby default seccomp profile pinned by
`fireball-session.provenance.json`. `fireball-session.json` is a generated
derivative that retains the deny-by-default policy and adds only the namespace
setup calls documented in the provenance file for WPE WebKit's bubblewrap
sandbox.

The upstream profile is distributed under Apache-2.0. Its exact license text is
vendored as `LICENSE-MOBY-PROFILES-APACHE-2.0`. Run
`npm run seccomp:generate` to regenerate network-fetched artifacts, and
`npm run seccomp:check` for the normal offline provenance gate.
