#!/usr/bin/env bash
# Re-clones the production D1 database into the staging D1 so the staging
# Worker (npm run deploy:staging) serves current real data. Drops every app
# table on staging first because `wrangler d1 export` emits plain CREATE TABLE
# statements that fail against existing tables.
set -euo pipefail

PROD_DB="infra-cost-analyzer"
STAGING_DB="infra-cost-analyzer-staging"
DUMP="$(mktemp -t staging-dump).sql"
trap 'rm -f "$DUMP"' EXIT

echo "Exporting $PROD_DB ..."
npx wrangler d1 export "$PROD_DB" --remote --output "$DUMP"

echo "Dropping existing tables on $STAGING_DB ..."
TABLES=$(npx wrangler d1 execute "$STAGING_DB" --remote --json \
  --command "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'sqlite_%'" \
  | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s)[0].results.map(r=>r.name).join(' ')))")
for table in $TABLES; do
  npx wrangler d1 execute "$STAGING_DB" --remote --command "DROP TABLE IF EXISTS $table" > /dev/null
done

echo "Importing into $STAGING_DB ..."
npx wrangler d1 execute "$STAGING_DB" --remote --file "$DUMP" > /dev/null
echo "Done. Staging D1 now mirrors production."
