-- A documented start of a cash shift: who took the drawer over and what they counted.
CREATE TABLE "CashHandover" (
    "id" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "drawerUserId" TEXT,
    "openedByUserId" TEXT NOT NULL,
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expectedFloat" INTEGER NOT NULL DEFAULT 0,
    "countedFloat" INTEGER NOT NULL DEFAULT 0,
    "difference" INTEGER NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'EGP',
    "note" TEXT,
    "shiftId" TEXT,

    CONSTRAINT "CashHandover_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CashHandover_shiftId_key" ON "CashHandover"("shiftId");
CREATE INDEX "CashHandover_venueId_drawerUserId_shiftId_idx" ON "CashHandover"("venueId", "drawerUserId", "shiftId");
CREATE INDEX "CashHandover_venueId_openedAt_idx" ON "CashHandover"("venueId", "openedAt");

ALTER TABLE "CashHandover" ADD CONSTRAINT "CashHandover_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "Venue"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CashHandover" ADD CONSTRAINT "CashHandover_shiftId_fkey" FOREIGN KEY ("shiftId") REFERENCES "CashShift"("id") ON DELETE SET NULL ON UPDATE CASCADE;
