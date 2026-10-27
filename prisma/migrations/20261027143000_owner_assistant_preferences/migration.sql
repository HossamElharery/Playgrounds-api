CREATE TABLE "OwnerAssistantPreference" (
    "userId" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "voiceEnabled" BOOLEAN NOT NULL DEFAULT false,
    "autoSendAfterSpeech" BOOLEAN NOT NULL DEFAULT true,
    "continueAfterReply" BOOLEAN NOT NULL DEFAULT true,
    "allowVoiceConfirmations" BOOLEAN NOT NULL DEFAULT false,
    "voice" VARCHAR(12) NOT NULL DEFAULT 'female',
    "speechRate" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OwnerAssistantPreference_pkey" PRIMARY KEY ("userId", "venueId")
);

CREATE INDEX "OwnerAssistantPreference_venueId_idx" ON "OwnerAssistantPreference"("venueId");

ALTER TABLE "OwnerAssistantPreference"
ADD CONSTRAINT "OwnerAssistantPreference_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "OwnerAssistantPreference"
ADD CONSTRAINT "OwnerAssistantPreference_venueId_fkey"
FOREIGN KEY ("venueId") REFERENCES "Venue"("id") ON DELETE CASCADE ON UPDATE CASCADE;
