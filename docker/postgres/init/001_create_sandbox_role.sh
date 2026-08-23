#!/usr/bin/env bash
set -euo pipefail

if [[ -z "${SQL_MENTOR_SANDBOX_PASSWORD:-}" ]]; then
  echo "SQL_MENTOR_SANDBOX_PASSWORD e obrigatoria" >&2
  exit 1
fi

psql \
  --username "$POSTGRES_USER" \
  --dbname "$POSTGRES_DB" \
  --set=ON_ERROR_STOP=1 \
  --set=sandbox_password="$SQL_MENTOR_SANDBOX_PASSWORD" <<'SQL'
CREATE ROLE mentor_sandbox
  LOGIN
  NOSUPERUSER
  NOCREATEDB
  NOCREATEROLE
  NOINHERIT
  NOREPLICATION
  NOBYPASSRLS
  PASSWORD :'sandbox_password';

ALTER ROLE mentor_sandbox SET default_transaction_read_only = on;
ALTER ROLE mentor_sandbox SET statement_timeout = '3s';
SQL

