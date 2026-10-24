#!/usr/bin/env bash
# Runs every scripts/smoke-*.ts with fake env values only (safe to commit).
# Used by CI and runnable locally: bash scripts/ci-smokes.sh
# Any variable name found in a local .env* file is blanked (names only, never values),
# so Prisma/dotenv cannot load real values for names not faked below.
# Works with macOS bash 3.2 (no associative arrays).
set -u
cd "$(dirname "$0")/.."

FAKES=(
  'DATABASE_URL=postgresql://fake:fake@127.0.0.1:1/fake'
  'DIRECT_URL=postgresql://fake:fake@127.0.0.1:1/fake'
  'TELEGRAM_BOT_TOKEN=000000:fake'
  'WHATSAPP_ACCESS_TOKEN=fake'
  'WHATSAPP_PHONE_NUMBER_ID='
  'WHATSAPP_WEBHOOK_VERIFY_TOKEN=fake'
  'GOOGLE_CLIENT_ID=fake'
  'GOOGLE_CLIENT_SECRET=fake'
  'GOOGLE_REFRESH_TOKEN=fake'
  'ANTHROPIC_API_KEY=fake'
  'CRON_SECRET=fake'
  'ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000'
  'ENCRYPTION_KEY_PREVIOUS='
  'NODE_ENV=development'
  'GOOGLE_TTS_CREDENTIALS={}'
  'TELEGRAM_WEBHOOK_SECRET=fake'
  'GEMINI_API_KEY=fake'
)

ENV_ARGS=(TZ=Asia/Jerusalem "${FAKES[@]}")

# Names only from .env* files; the sed keeps just the name, so values are never read out.
for f in .env .env.*; do
  [ -f "$f" ] || continue
  while IFS= read -r name; do
    [ -z "$name" ] && continue
    skip=0
    for e in "${ENV_ARGS[@]}"; do
      [ "${e%%=*}" = "$name" ] && skip=1 && break
    done
    [ "$skip" -eq 0 ] && ENV_ARGS+=("$name=")
  done < <(sed -nE 's/^[[:space:]]*(export[[:space:]]+)?([A-Za-z_][A-Za-z0-9_]*)=.*/\2/p' "$f")
done

total=0
passed=0
for file in scripts/smoke-*.ts; do
  total=$((total + 1))
  # For a macOS-only smoke, add: echo "SKIPPED $file: <reason>"; passed=$((passed + 1)); continue
  log=$(mktemp)
  if env "${ENV_ARGS[@]}" npx tsx "$file" >"$log" 2>&1; then
    passed=$((passed + 1))
  else
    echo "FAILED $file"
    tail -n 30 "$log" | sed 's/^/    /'
  fi
  rm -f "$log"
done

echo "$passed/$total smoke files passed"
[ "$passed" -eq "$total" ]
