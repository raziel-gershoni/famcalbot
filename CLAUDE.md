# CLAUDE.md

Rules for coding agents in this repo. Setup, env vars and deployment are in README.md.

- Never replace `ENCRYPTION_KEY` without setting `ENCRYPTION_KEY_PREVIOUS` to the old value in the same deploy, and remove `ENCRYPTION_KEY_PREVIOUS` only after the key sweep logs `[key-sweep] SAFE` (README, "Rotating `ENCRYPTION_KEY`").
