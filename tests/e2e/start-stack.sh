#!/usr/bin/env bash
# E2E stack: applies migrations to a throwaway PostgreSQL test database, starts
# the worker and the Next.js production server in the foreground. Both share the
# environment Playwright injects (see playwright.config.ts). Requires
# TEST_DATABASE_URL (or a local Postgres with the default test database below).
set -euo pipefail
cd "$(dirname "$0")/../.."

: "${TEST_DATABASE_URL:=postgresql://postgres:postgres@127.0.0.1:5432/devsentinel_e2e}"
export DATABASE_URL="$TEST_DATABASE_URL" DIRECT_URL="$TEST_DATABASE_URL"

# Create the test database when it is missing, without requiring psql/createdb:
# connect to the same server's admin database ("postgres") and issue CREATE
# DATABASE. Fails harmlessly when the database already exists; the
# `migrate reset` below fails loudly if creation genuinely did not work.
db_url="${TEST_DATABASE_URL%%\?*}"
db_name="${db_url##*/}"
admin_url="${db_url%/*}/postgres"
printf 'CREATE DATABASE "%s"' "$db_name" | npx prisma db execute --url "$admin_url" --stdin >/dev/null 2>&1 || true

# The suite registers fresh accounts and delivers the same repo/PR/SHA on every
# run; a leftover DB would bind those events to the PREVIOUS execution's project
# (repository connections are keyed by owner/repo, not by account). Always start
# from an empty throwaway database. The reset also runs the configured seed
# (package.json prisma.seed), so the seeded-environment spec has its data.
npx prisma migrate reset --force --skip-generate

npx next build
APP_ROLE=worker node_modules/.bin/tsx worker/index.ts &
worker_pid=$!
cleanup() { kill "$worker_pid" 2>/dev/null || true; }
trap cleanup EXIT INT TERM

APP_ROLE=web node_modules/.bin/next start -p 3311
