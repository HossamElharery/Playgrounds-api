-- Smart plugs that power gaming-station screens (Shelly outbound WebSocket).
ALTER TABLE "Venue" ADD COLUMN "gamingDeviceToken" TEXT;
CREATE UNIQUE INDEX "Venue_gamingDeviceToken_key" ON "Venue"("gamingDeviceToken");

CREATE TABLE "GamingDevice" (
    "id" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'shelly',
    "externalId" TEXT NOT NULL,
    "model" TEXT,
    "firmware" TEXT,
    "name" TEXT,
    "unitId" TEXT,
    "channel" INTEGER NOT NULL DEFAULT 0,
    "settings" JSONB NOT NULL,
    "online" BOOLEAN NOT NULL DEFAULT false,
    "lastSeenAt" TIMESTAMP(3),
    "output" BOOLEAN,
    "powerW" DOUBLE PRECISION,
    "authError" BOOLEAN NOT NULL DEFAULT false,
    "appliedKey" TEXT,
    "overrideOn" BOOLEAN,
    "overrideUntil" TIMESTAMP(3),
    "overrideBy" TEXT,
    "configuredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "GamingDevice_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "GamingDevice_provider_externalId_key" ON "GamingDevice"("provider", "externalId");
CREATE INDEX "GamingDevice_venueId_idx" ON "GamingDevice"("venueId");
CREATE INDEX "GamingDevice_unitId_idx" ON "GamingDevice"("unitId");
ALTER TABLE "GamingDevice" ADD CONSTRAINT "GamingDevice_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "Venue"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "GamingDevice" ADD CONSTRAINT "GamingDevice_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "Court"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "GamingDeviceLog" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "detail" JSONB,
    "actorId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "GamingDeviceLog_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "GamingDeviceLog_deviceId_createdAt_idx" ON "GamingDeviceLog"("deviceId", "createdAt");
CREATE INDEX "GamingDeviceLog_venueId_createdAt_idx" ON "GamingDeviceLog"("venueId", "createdAt");
ALTER TABLE "GamingDeviceLog" ADD CONSTRAINT "GamingDeviceLog_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "GamingDevice"("id") ON DELETE CASCADE ON UPDATE CASCADE;
