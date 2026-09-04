# Contributing

Keep changes scoped to a concrete user need. Do not install global hooks, change models, restart user services, publish releases or add infrastructure without a requirement.

Run `npm test` with TEMP/TMP pointing to a writable temporary directory. Tests use fake protocol peers; keep live authentication and real model-call evidence separate. Add regressions for delivery uncertainty, duplicate messages, rework limits and identity binding when changing those paths.

Do not add silent retries for writes, automatic acceptance, arbitrary command/RPC proxies, or credential discovery. Preserve third-party attribution if importing code. Public visibility alone is not a license grant; this repository has no selected redistribution license yet.
