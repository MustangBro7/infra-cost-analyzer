-- MotherDuck analytical schema for cost history.
-- Each statement is separated by the marker consumed by scripts/analytics.mjs.

CREATE TABLE IF NOT EXISTS analytics_schema_migrations (
  version VARCHAR PRIMARY KEY,
  description VARCHAR NOT NULL,
  applied_at TIMESTAMP NOT NULL DEFAULT current_timestamp
);

-- statement
CREATE TABLE IF NOT EXISTS analytics_sync_runs (
  sync_run_id UUID PRIMARY KEY,
  user_id VARCHAR NOT NULL,
  snapshot_key VARCHAR NOT NULL,
  repo_full_name VARCHAR,
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  computed_at TIMESTAMP NOT NULL,
  source VARCHAR NOT NULL,
  status VARCHAR NOT NULL,
  cost_row_count INTEGER NOT NULL,
  usage_row_count INTEGER NOT NULL,
  resource_row_count INTEGER NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT current_timestamp
);

-- statement
CREATE TABLE IF NOT EXISTS cost_observations (
  observation_id VARCHAR PRIMARY KEY,
  sync_run_id UUID NOT NULL,
  user_id VARCHAR NOT NULL,
  snapshot_key VARCHAR NOT NULL,
  repo_full_name VARCHAR,
  fact_key VARCHAR NOT NULL,
  provider_account_id VARCHAR,
  provider VARCHAR NOT NULL,
  service_name VARCHAR NOT NULL,
  resource_id VARCHAR,
  resource_name VARCHAR,
  billing_period_start DATE NOT NULL,
  billing_period_end DATE NOT NULL,
  cost DECIMAL(20, 6) NOT NULL,
  currency VARCHAR NOT NULL,
  attribution VARCHAR NOT NULL,
  attribution_reason VARCHAR NOT NULL,
  signal_id VARCHAR,
  attributed_repo VARCHAR,
  item_key VARCHAR NOT NULL,
  observed_at TIMESTAMP NOT NULL
);

-- statement
CREATE TABLE IF NOT EXISTS usage_observations (
  observation_id VARCHAR PRIMARY KEY,
  sync_run_id UUID NOT NULL,
  user_id VARCHAR NOT NULL,
  snapshot_key VARCHAR NOT NULL,
  repo_full_name VARCHAR,
  fact_key VARCHAR NOT NULL,
  provider VARCHAR NOT NULL,
  plan_name VARCHAR NOT NULL,
  service VARCHAR NOT NULL,
  used DOUBLE,
  usage_limit DOUBLE,
  unit VARCHAR NOT NULL,
  remaining DOUBLE,
  percent_used DOUBLE,
  source VARCHAR NOT NULL,
  note VARCHAR NOT NULL,
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  observed_at TIMESTAMP NOT NULL
);

-- statement
CREATE TABLE IF NOT EXISTS resource_observations (
  observation_id VARCHAR PRIMARY KEY,
  sync_run_id UUID NOT NULL,
  user_id VARCHAR NOT NULL,
  snapshot_key VARCHAR NOT NULL,
  repo_full_name VARCHAR,
  fact_key VARCHAR NOT NULL,
  provider VARCHAR NOT NULL,
  item_key VARCHAR NOT NULL,
  kind VARCHAR NOT NULL,
  name VARCHAR NOT NULL,
  quantity DOUBLE NOT NULL,
  unit VARCHAR NOT NULL,
  attributed_repo VARCHAR,
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  observed_at TIMESTAMP NOT NULL
);

-- statement
CREATE OR REPLACE VIEW latest_cost_observations AS
WITH latest_runs AS (
  SELECT * EXCLUDE (recency)
  FROM (
    SELECT
      analytics_sync_runs.*,
      row_number() OVER (
        PARTITION BY user_id, coalesce(repo_full_name, ''), period_start, period_end
        ORDER BY computed_at DESC, sync_run_id DESC
      ) AS recency
    FROM analytics_sync_runs
    WHERE status = 'complete'
  )
  WHERE recency = 1
)
SELECT cost_observations.*
FROM cost_observations
JOIN latest_runs USING (sync_run_id);

-- statement
CREATE OR REPLACE VIEW latest_usage_observations AS
WITH latest_runs AS (
  SELECT * EXCLUDE (recency)
  FROM (
    SELECT
      analytics_sync_runs.*,
      row_number() OVER (
        PARTITION BY user_id, coalesce(repo_full_name, ''), period_start, period_end
        ORDER BY computed_at DESC, sync_run_id DESC
      ) AS recency
    FROM analytics_sync_runs
    WHERE status = 'complete'
  )
  WHERE recency = 1
)
SELECT usage_observations.*
FROM usage_observations
JOIN latest_runs USING (sync_run_id);

-- statement
CREATE OR REPLACE VIEW latest_resource_observations AS
WITH latest_runs AS (
  SELECT * EXCLUDE (recency)
  FROM (
    SELECT
      analytics_sync_runs.*,
      row_number() OVER (
        PARTITION BY user_id, coalesce(repo_full_name, ''), period_start, period_end
        ORDER BY computed_at DESC, sync_run_id DESC
      ) AS recency
    FROM analytics_sync_runs
    WHERE status = 'complete'
  )
  WHERE recency = 1
)
SELECT resource_observations.*
FROM resource_observations
JOIN latest_runs USING (sync_run_id);

-- statement
CREATE OR REPLACE VIEW latest_cost_facts_compat AS
SELECT * EXCLUDE (recency)
FROM (
  SELECT
    latest_cost_observations.*,
    row_number() OVER (
      PARTITION BY user_id, coalesce(repo_full_name, ''), fact_key, billing_period_start, billing_period_end
      ORDER BY observed_at DESC, sync_run_id DESC
    ) AS recency
  FROM latest_cost_observations
)
WHERE recency = 1;

-- statement
CREATE OR REPLACE VIEW monthly_cost_summary AS
SELECT
  user_id,
  repo_full_name,
  date_trunc('month', billing_period_start)::DATE AS month,
  currency,
  sum(cost) AS total,
  max(observed_at) AS last_observed_at
FROM latest_cost_facts_compat
GROUP BY user_id, repo_full_name, month, currency;

-- statement
CREATE OR REPLACE VIEW provider_monthly_summary AS
SELECT
  user_id,
  repo_full_name,
  date_trunc('month', billing_period_start)::DATE AS month,
  currency,
  provider,
  sum(cost) AS total,
  max(observed_at) AS last_observed_at
FROM latest_cost_facts_compat
GROUP BY user_id, repo_full_name, month, currency, provider;

-- statement
CREATE OR REPLACE VIEW service_monthly_summary AS
SELECT
  user_id,
  repo_full_name,
  date_trunc('month', billing_period_start)::DATE AS month,
  currency,
  provider,
  service_name,
  sum(cost) AS total,
  max(observed_at) AS last_observed_at
FROM latest_cost_facts_compat
GROUP BY user_id, repo_full_name, month, currency, provider, service_name;

-- statement
CREATE OR REPLACE VIEW repo_monthly_summary AS
SELECT
  user_id,
  repo_full_name,
  date_trunc('month', billing_period_start)::DATE AS month,
  currency,
  sum(cost) AS total,
  max(observed_at) AS last_observed_at
FROM latest_cost_facts_compat
WHERE repo_full_name IS NOT NULL
GROUP BY user_id, repo_full_name, month, currency;
