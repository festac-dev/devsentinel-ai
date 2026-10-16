-- Shared (cross-instance) fixed-window rate limiting (ADR-011): replaces the
-- former in-memory limiter so web replicas enforce one limit together.
-- CreateTable
CREATE TABLE "RateLimitWindow" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "windowStart" TIMESTAMP(3) NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RateLimitWindow_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RateLimitWindow_key_windowStart_key" ON "RateLimitWindow"("key", "windowStart");

-- CreateIndex
CREATE INDEX "RateLimitWindow_expiresAt_idx" ON "RateLimitWindow"("expiresAt");

-- Immutability trigger (spec 9.4, docs/decisions.md): a TestRun's repository and
-- commit binding are set at creation and must never change — results always
-- validate the exact commit they tested. Application code never updates these
-- columns; the database enforces it even if a future code path tries.
-- (pullRequestId is deliberately not covered: deleting a PR nulls it.)
CREATE FUNCTION "prevent_run_commit_rebind"() RETURNS trigger AS $$
BEGIN
  IF NEW."repoOwner" IS DISTINCT FROM OLD."repoOwner"
     OR NEW."repoName" IS DISTINCT FROM OLD."repoName"
     OR NEW."commitSha" IS DISTINCT FROM OLD."commitSha" THEN
    RAISE EXCEPTION 'TestRun %: repoOwner, repoName and commitSha are immutable (set at creation)', OLD."id";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "test_run_commit_binding"
BEFORE UPDATE ON "TestRun"
FOR EACH ROW
EXECUTE FUNCTION "prevent_run_commit_rebind"();
