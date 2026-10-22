-- CreateTable
CREATE TABLE "DeliveryTracker" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "seedVersion" INTEGER NOT NULL DEFAULT 1,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "liveUrl" TEXT,
    "repositoryUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeliveryTracker_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeliveryPhase" (
    "id" TEXT NOT NULL,
    "trackerId" TEXT NOT NULL,
    "stableKey" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "phaseOrder" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeliveryPhase_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeliveryTask" (
    "id" TEXT NOT NULL,
    "phaseId" TEXT NOT NULL,
    "stableKey" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "verificationStatus" TEXT NOT NULL DEFAULT 'unverified',
    "completionNotes" TEXT,
    "taskOrder" INTEGER NOT NULL,
    "completedAt" TIMESTAMP(3),
    "verifiedAt" TIMESTAMP(3),
    "verifiedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeliveryTask_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaskEvidence" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "evidenceType" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "referenceUrl" TEXT,
    "artifactReference" TEXT,
    "sourceCommitSha" TEXT,
    "sourceRecordType" TEXT,
    "sourceRecordId" TEXT,
    "notes" TEXT,
    "verificationStatus" TEXT NOT NULL DEFAULT 'pending_review',
    "verificationBasis" TEXT,
    "submittedBy" TEXT,
    "verifiedAt" TIMESTAMP(3),
    "verifiedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TaskEvidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeliveryAuditEvent" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "actorId" TEXT,
    "previousStatus" TEXT,
    "newStatus" TEXT,
    "action" TEXT NOT NULL,
    "reason" TEXT,
    "metadata" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeliveryAuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DeliveryTracker_ownerId_key" ON "DeliveryTracker"("ownerId");

-- CreateIndex
CREATE INDEX "DeliveryPhase_trackerId_phaseOrder_idx" ON "DeliveryPhase"("trackerId", "phaseOrder");

-- CreateIndex
CREATE UNIQUE INDEX "DeliveryPhase_trackerId_stableKey_key" ON "DeliveryPhase"("trackerId", "stableKey");

-- CreateIndex
CREATE UNIQUE INDEX "DeliveryPhase_trackerId_phaseOrder_key" ON "DeliveryPhase"("trackerId", "phaseOrder");

-- CreateIndex
CREATE INDEX "DeliveryTask_phaseId_status_idx" ON "DeliveryTask"("phaseId", "status");

-- CreateIndex
CREATE INDEX "DeliveryTask_phaseId_verificationStatus_idx" ON "DeliveryTask"("phaseId", "verificationStatus");

-- CreateIndex
CREATE UNIQUE INDEX "DeliveryTask_phaseId_stableKey_key" ON "DeliveryTask"("phaseId", "stableKey");

-- CreateIndex
CREATE UNIQUE INDEX "DeliveryTask_phaseId_taskOrder_key" ON "DeliveryTask"("phaseId", "taskOrder");

-- CreateIndex
CREATE INDEX "TaskEvidence_taskId_createdAt_idx" ON "TaskEvidence"("taskId", "createdAt");

-- CreateIndex
CREATE INDEX "TaskEvidence_verificationStatus_idx" ON "TaskEvidence"("verificationStatus");

-- CreateIndex
CREATE INDEX "DeliveryAuditEvent_taskId_createdAt_idx" ON "DeliveryAuditEvent"("taskId", "createdAt");

-- CreateIndex
CREATE INDEX "DeliveryAuditEvent_actorId_createdAt_idx" ON "DeliveryAuditEvent"("actorId", "createdAt");

-- AddForeignKey
ALTER TABLE "DeliveryTracker" ADD CONSTRAINT "DeliveryTracker_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeliveryPhase" ADD CONSTRAINT "DeliveryPhase_trackerId_fkey" FOREIGN KEY ("trackerId") REFERENCES "DeliveryTracker"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeliveryTask" ADD CONSTRAINT "DeliveryTask_phaseId_fkey" FOREIGN KEY ("phaseId") REFERENCES "DeliveryPhase"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeliveryTask" ADD CONSTRAINT "DeliveryTask_verifiedBy_fkey" FOREIGN KEY ("verifiedBy") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskEvidence" ADD CONSTRAINT "TaskEvidence_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "DeliveryTask"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskEvidence" ADD CONSTRAINT "TaskEvidence_submittedBy_fkey" FOREIGN KEY ("submittedBy") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskEvidence" ADD CONSTRAINT "TaskEvidence_verifiedBy_fkey" FOREIGN KEY ("verifiedBy") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeliveryAuditEvent" ADD CONSTRAINT "DeliveryAuditEvent_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "DeliveryTask"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeliveryAuditEvent" ADD CONSTRAINT "DeliveryAuditEvent_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
