ALTER TABLE "Court" ADD COLUMN "gamingHourlyRateMinor" INTEGER;
-- The precise creation tariff must never shadow subsequent pricing-rule edits.
CREATE FUNCTION gaming_pricing_changed() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE cid text;
BEGIN
 cid:=CASE WHEN TG_OP='DELETE' THEN OLD."courtId" ELSE NEW."courtId" END;
 IF TG_OP<>'INSERT' OR (SELECT COUNT(*) FROM "PricingRule" WHERE "courtId"=cid)>1 THEN
   UPDATE "Court" SET "gamingHourlyRateMinor"=NULL WHERE id=cid AND "gamingHourlyRateMinor" IS NOT NULL;
 END IF;
 RETURN NULL;
END $$;
CREATE TRIGGER gaming_pricing_changed AFTER INSERT OR UPDATE OF "priceAmount",currency,"daysOfWeek","startTime","endTime",priority OR DELETE ON "PricingRule" FOR EACH ROW EXECUTE FUNCTION gaming_pricing_changed();
-- Explicit precision preserves all historical hundredth-based amounts.
ALTER TABLE "Payment" ADD COLUMN "moneyScale" INTEGER NOT NULL DEFAULT 100;
ALTER TABLE "CashShift" ADD COLUMN "moneyScale" INTEGER NOT NULL DEFAULT 100;
ALTER TABLE "CashHandover" ADD COLUMN "moneyScale" INTEGER NOT NULL DEFAULT 100;
-- AlterTable
ALTER TABLE "Court" ADD COLUMN     "gamingRoomId" TEXT;

-- AlterTable
ALTER TABLE "Payment" ADD COLUMN     "gamingOrderId" TEXT,
ALTER COLUMN "bookingId" DROP NOT NULL;

-- CreateTable
CREATE TABLE "GamingRoom" (
    "id" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "floorId" TEXT NOT NULL,
    "occupancy" TEXT NOT NULL DEFAULT 'independent',
    "bookableCourtId" TEXT,

    CONSTRAINT "GamingRoom_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UsageSession" (
    "id" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "unitId" TEXT NOT NULL,
    "bookingId" TEXT,
    "orderId" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'running',
    "startedAt" TIMESTAMP(3) NOT NULL,
    "endedAt" TIMESTAMP(3),
    "expectedEnd" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "policy" JSONB NOT NULL,
    "createdById" TEXT NOT NULL,

    CONSTRAINT "UsageSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UsageSegment" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "unitId" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "endedAt" TIMESTAMP(3),
    "hourlyRateMinor" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "rateSnapshot" JSONB NOT NULL,

    CONSTRAINT "UsageSegment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ResourceOccupancy" (
    "id" TEXT NOT NULL,
    "resourceId" TEXT NOT NULL,
    "bookingId" TEXT,
    "sessionId" TEXT,
    "blockId" TEXT,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3),
    "running" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "ResourceOccupancy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GamingOrder" (
    "id" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'open',
    "version" INTEGER NOT NULL DEFAULT 1,
    "customerId" TEXT,
    "guestName" TEXT,
    "totalMinor" INTEGER NOT NULL DEFAULT 0,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GamingOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GamingOrderLine" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "sourceId" TEXT,
    "nameAr" TEXT NOT NULL,
    "nameEn" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unitPriceMinor" INTEGER NOT NULL,
    "amountMinor" INTEGER NOT NULL,
    "returnedQuantity" INTEGER NOT NULL DEFAULT 0,
    "snapshot" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GamingOrderLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GamingPaymentAllocation" (
    "id" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "lineId" TEXT NOT NULL,
    "amountMinor" INTEGER NOT NULL,

    CONSTRAINT "GamingPaymentAllocation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GamingProduct" (
    "id" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "nameAr" TEXT NOT NULL,
    "nameEn" TEXT NOT NULL,
    "category" TEXT NOT NULL DEFAULT 'other',
    "sku" TEXT,
    "priceMinor" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "stockTracked" BOOLEAN NOT NULL DEFAULT false,
    "availableQuantity" INTEGER NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "GamingProduct_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GamingStockMovement" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "delta" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "orderLineId" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GamingStockMovement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GamingCommand" (
    "id" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "requestKey" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "response" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GamingCommand_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReceiptDocument" (
    "id" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "paymentId" TEXT,
    "number" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "originalId" TEXT,
    "snapshot" JSONB NOT NULL,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReceiptDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReceiptSettings" (
    "venueId" TEXT NOT NULL,
    "widthMm" INTEGER NOT NULL DEFAULT 80,
    "language" TEXT NOT NULL DEFAULT 'bilingual',
    "header" TEXT NOT NULL DEFAULT '',
    "footer" TEXT NOT NULL DEFAULT '',
    "copies" INTEGER NOT NULL DEFAULT 1,
    "autoPrint" BOOLEAN NOT NULL DEFAULT false,
    "nextNumber" INTEGER NOT NULL DEFAULT 1,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "ReceiptSettings_pkey" PRIMARY KEY ("venueId")
);

-- CreateTable
CREATE TABLE "GamingPrintJob" (
    "id" TEXT NOT NULL,
    "receiptId" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "terminalId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GamingPrintJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GamingOutbox" (
    "id" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deliveredAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "GamingOutbox_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "GamingRoom_bookableCourtId_key" ON "GamingRoom"("bookableCourtId");

-- CreateIndex
CREATE INDEX "GamingRoom_venueId_idx" ON "GamingRoom"("venueId");

-- CreateIndex
CREATE UNIQUE INDEX "UsageSession_bookingId_key" ON "UsageSession"("bookingId");

-- CreateIndex
CREATE INDEX "UsageSession_venueId_state_idx" ON "UsageSession"("venueId", "state");

-- CreateIndex
CREATE INDEX "UsageSession_unitId_startedAt_idx" ON "UsageSession"("unitId", "startedAt");

-- CreateIndex
CREATE INDEX "UsageSession_orderId_idx" ON "UsageSession"("orderId");

-- CreateIndex
CREATE INDEX "UsageSegment_sessionId_startedAt_idx" ON "UsageSegment"("sessionId", "startedAt");

-- CreateIndex
CREATE INDEX "ResourceOccupancy_bookingId_idx" ON "ResourceOccupancy"("bookingId");

-- CreateIndex
CREATE INDEX "ResourceOccupancy_sessionId_idx" ON "ResourceOccupancy"("sessionId");

-- CreateIndex
CREATE INDEX "ResourceOccupancy_blockId_idx" ON "ResourceOccupancy"("blockId");

-- CreateIndex
CREATE INDEX "ResourceOccupancy_resourceId_startsAt_idx" ON "ResourceOccupancy"("resourceId", "startsAt");

-- CreateIndex
CREATE INDEX "GamingOrder_venueId_state_createdAt_idx" ON "GamingOrder"("venueId", "state", "createdAt");

-- CreateIndex
CREATE INDEX "GamingOrderLine_orderId_createdAt_idx" ON "GamingOrderLine"("orderId", "createdAt");

-- CreateIndex
CREATE INDEX "GamingPaymentAllocation_lineId_idx" ON "GamingPaymentAllocation"("lineId");

-- CreateIndex
CREATE UNIQUE INDEX "GamingPaymentAllocation_paymentId_lineId_key" ON "GamingPaymentAllocation"("paymentId", "lineId");

-- CreateIndex
CREATE INDEX "GamingProduct_venueId_active_category_idx" ON "GamingProduct"("venueId", "active", "category");

-- CreateIndex
CREATE INDEX "GamingStockMovement_productId_createdAt_idx" ON "GamingStockMovement"("productId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "GamingCommand_venueId_actorId_requestKey_key" ON "GamingCommand"("venueId", "actorId", "requestKey");

-- CreateIndex
CREATE UNIQUE INDEX "ReceiptDocument_paymentId_key" ON "ReceiptDocument"("paymentId");

-- CreateIndex
CREATE INDEX "ReceiptDocument_orderId_issuedAt_idx" ON "ReceiptDocument"("orderId", "issuedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ReceiptDocument_venueId_number_key" ON "ReceiptDocument"("venueId", "number");

-- CreateIndex
CREATE INDEX "GamingPrintJob_receiptId_idx" ON "GamingPrintJob"("receiptId");

-- CreateIndex
CREATE INDEX "GamingOutbox_deliveredAt_createdAt_idx" ON "GamingOutbox"("deliveredAt", "createdAt");

-- AddForeignKey
ALTER TABLE "Court" ADD CONSTRAINT "Court_gamingRoomId_fkey" FOREIGN KEY ("gamingRoomId") REFERENCES "GamingRoom"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_gamingOrderId_fkey" FOREIGN KEY ("gamingOrderId") REFERENCES "GamingOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GamingRoom" ADD CONSTRAINT "GamingRoom_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "Venue"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GamingRoom" ADD CONSTRAINT "GamingRoom_bookableCourtId_fkey" FOREIGN KEY ("bookableCourtId") REFERENCES "Court"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UsageSession" ADD CONSTRAINT "UsageSession_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "Venue"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UsageSession" ADD CONSTRAINT "UsageSession_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "Court"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UsageSession" ADD CONSTRAINT "UsageSession_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UsageSession" ADD CONSTRAINT "UsageSession_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "GamingOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UsageSegment" ADD CONSTRAINT "UsageSegment_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "UsageSession"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UsageSegment" ADD CONSTRAINT "UsageSegment_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "Court"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ResourceOccupancy" ADD CONSTRAINT "ResourceOccupancy_resourceId_fkey" FOREIGN KEY ("resourceId") REFERENCES "Court"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ResourceOccupancy" ADD CONSTRAINT "ResourceOccupancy_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ResourceOccupancy" ADD CONSTRAINT "ResourceOccupancy_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "UsageSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GamingOrder" ADD CONSTRAINT "GamingOrder_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "Venue"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GamingOrderLine" ADD CONSTRAINT "GamingOrderLine_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "GamingOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GamingPaymentAllocation" ADD CONSTRAINT "GamingPaymentAllocation_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GamingPaymentAllocation" ADD CONSTRAINT "GamingPaymentAllocation_lineId_fkey" FOREIGN KEY ("lineId") REFERENCES "GamingOrderLine"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GamingProduct" ADD CONSTRAINT "GamingProduct_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "Venue"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GamingStockMovement" ADD CONSTRAINT "GamingStockMovement_productId_fkey" FOREIGN KEY ("productId") REFERENCES "GamingProduct"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReceiptDocument" ADD CONSTRAINT "ReceiptDocument_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "Venue"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReceiptDocument" ADD CONSTRAINT "ReceiptDocument_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "GamingOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReceiptDocument" ADD CONSTRAINT "ReceiptDocument_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReceiptSettings" ADD CONSTRAINT "ReceiptSettings_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "Venue"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GamingPrintJob" ADD CONSTRAINT "GamingPrintJob_receiptId_fkey" FOREIGN KEY ("receiptId") REFERENCES "ReceiptDocument"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Constraints not representable in Prisma. Unbounded ranges mean an unknown end,
-- never an artificial far-future timestamp in booking/reporting data.
ALTER TABLE "ResourceOccupancy" ADD COLUMN "occupiedRange" tsrange NOT NULL DEFAULT tsrange(NULL,NULL,'[)');
ALTER TABLE "ResourceOccupancy" ADD CONSTRAINT "ResourceOccupancy_one_source" CHECK (num_nonnulls("bookingId","sessionId","blockId") = 1);
ALTER TABLE "ResourceOccupancy" ADD CONSTRAINT "ResourceOccupancy_time" CHECK ("endsAt" IS NULL OR "endsAt" > "startsAt");
ALTER TABLE "ResourceOccupancy" ADD CONSTRAINT "ResourceOccupancy_range_excl" EXCLUDE USING gist ("resourceId" WITH =, "occupiedRange" WITH &&);
CREATE UNIQUE INDEX "ResourceOccupancy_running_unique" ON "ResourceOccupancy"("resourceId") WHERE "running";
CREATE UNIQUE INDEX "UsageSegment_open_unique" ON "UsageSegment"("sessionId") WHERE "endedAt" IS NULL;
ALTER TABLE "UsageSession" ADD CONSTRAINT "UsageSession_state_time" CHECK ("state" IN ('running','ended','voided') AND (("state"='running' AND "endedAt" IS NULL) OR ("state"<>'running' AND "endedAt">="startedAt")) AND ("expectedEnd" IS NULL OR "expectedEnd">"startedAt"));
ALTER TABLE "UsageSegment" ADD CONSTRAINT "UsageSegment_rate_time" CHECK ("hourlyRateMinor">=0 AND ("endedAt" IS NULL OR "endedAt">="startedAt"));
ALTER TABLE "GamingProduct" ADD CONSTRAINT "GamingProduct_amount_stock" CHECK ("priceMinor" BETWEEN 0 AND 10000000 AND "availableQuantity">=0);
ALTER TABLE "GamingOrderLine" ADD CONSTRAINT "GamingOrderLine_amount_quantity" CHECK ("quantity">0 AND "returnedQuantity" BETWEEN 0 AND "quantity" AND "unitPriceMinor">=0 AND "amountMinor">=0);
ALTER TABLE "GamingOrder" ADD CONSTRAINT "GamingOrder_total" CHECK ("totalMinor">=0 AND "state" IN ('open','settled','voided'));
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_has_source" CHECK ("bookingId" IS NOT NULL OR "gamingOrderId" IS NOT NULL);
ALTER TABLE "ReceiptSettings" ADD CONSTRAINT "ReceiptSettings_width" CHECK ("widthMm" IN (58,80) AND "copies" BETWEEN 1 AND 3 AND "language" IN ('ar','en','bilingual'));
ALTER TABLE "GamingPrintJob" ADD CONSTRAINT "GamingPrintJob_status" CHECK ("status" IN ('queued','sent','failed','unknown'));

CREATE FUNCTION gaming_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'IMMUTABLE_GAMING_RECORD' USING ERRCODE='23514'; END $$;
CREATE TRIGGER receipt_immutable BEFORE UPDATE OR DELETE ON "ReceiptDocument" FOR EACH ROW EXECUTE FUNCTION gaming_immutable();
CREATE TRIGGER stock_movement_immutable BEFORE UPDATE OR DELETE ON "GamingStockMovement" FOR EACH ROW EXECUTE FUNCTION gaming_immutable();
CREATE TRIGGER payment_allocation_immutable BEFORE UPDATE OR DELETE ON "GamingPaymentAllocation" FOR EACH ROW EXECUTE FUNCTION gaming_immutable();
CREATE TRIGGER gaming_command_immutable BEFORE UPDATE OR DELETE ON "GamingCommand" FOR EACH ROW EXECUTE FUNCTION gaming_immutable();
CREATE TRIGGER layout_revision_immutable BEFORE UPDATE OR DELETE ON "GamingLayoutRevision" FOR EACH ROW EXECUTE FUNCTION gaming_immutable();

CREATE FUNCTION gaming_resource_ids(unit text) RETURNS SETOF text LANGUAGE sql STABLE AS $$
 SELECT unit UNION SELECT c.id FROM "GamingRoom" r JOIN "Court" c ON c."gamingRoomId"=r.id
 WHERE r."bookableCourtId"=unit AND r.occupancy='exclusive'
$$;
CREATE FUNCTION gaming_occupancy_range() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW."occupiedRange" := tsrange(NEW."startsAt",NEW."endsAt",'[)'); RETURN NEW; END $$;
CREATE TRIGGER gaming_occupancy_range BEFORE INSERT OR UPDATE ON "ResourceOccupancy" FOR EACH ROW EXECUTE FUNCTION gaming_occupancy_range();

-- All writers, including public/fixed/import/offline, pass through these triggers.
-- A venue advisory lock also protects a room hierarchy changing during publication.
CREATE FUNCTION gaming_booking_occupancy() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW."venueId",91005));
 IF NOT EXISTS (SELECT 1 FROM "Court" WHERE id=NEW."courtId" AND "venueId"=NEW."venueId") THEN RAISE EXCEPTION 'RESOURCE_SCOPE_INVALID' USING ERRCODE='23514'; END IF;
 DELETE FROM "ResourceOccupancy" WHERE "bookingId"=NEW.id;
 IF NEW.status IN ('held','confirmed') AND NOT EXISTS (SELECT 1 FROM "UsageSession" WHERE "bookingId"=NEW.id AND state='running') THEN
 INSERT INTO "ResourceOccupancy" (id,"resourceId","bookingId","startsAt","endsAt",running)
 SELECT gen_random_uuid()::text,x,NEW.id,NEW."slotStart",NEW."slotEnd",false FROM gaming_resource_ids(NEW."courtId") x ORDER BY x;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER gaming_booking_occupancy AFTER INSERT OR UPDATE ON "Booking" FOR EACH ROW EXECUTE FUNCTION gaming_booking_occupancy();

CREATE FUNCTION gaming_session_occupancy() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW."venueId",91005));
 IF NOT EXISTS (SELECT 1 FROM "Court" WHERE id=NEW."unitId" AND "venueId"=NEW."venueId") OR NOT EXISTS (SELECT 1 FROM "GamingOrder" WHERE id=NEW."orderId" AND "venueId"=NEW."venueId") OR (NEW."bookingId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "Booking" WHERE id=NEW."bookingId" AND "venueId"=NEW."venueId")) THEN RAISE EXCEPTION 'RESOURCE_SCOPE_INVALID' USING ERRCODE='23514'; END IF;
 DELETE FROM "ResourceOccupancy" WHERE "sessionId"=NEW.id;
 IF NEW.state='running' THEN
 DELETE FROM "ResourceOccupancy" WHERE "bookingId"=NEW."bookingId";
 INSERT INTO "ResourceOccupancy" (id,"resourceId","sessionId","startsAt","endsAt",running)
 SELECT gen_random_uuid()::text,x,NEW.id,NEW."startedAt",NEW."expectedEnd",true FROM gaming_resource_ids(NEW."unitId") x ORDER BY x;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER gaming_session_occupancy AFTER INSERT OR UPDATE OF "state","unitId","expectedEnd" ON "UsageSession" FOR EACH ROW EXECUTE FUNCTION gaming_session_occupancy();

CREATE FUNCTION gaming_block_occupancy() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v text;
BEGIN
 v:=COALESCE(NEW."venueId",OLD."venueId");
 PERFORM pg_advisory_xact_lock(hashtextextended(v,91005));
 DELETE FROM "ResourceOccupancy" WHERE "blockId"=OLD.id;
 IF TG_OP<>'DELETE' THEN
 INSERT INTO "ResourceOccupancy" (id,"resourceId","blockId","startsAt","endsAt",running)
 SELECT gen_random_uuid()::text,x,NEW.id,NEW."startsAt",NEW."endsAt",false FROM (
 SELECT id AS x FROM "Court" WHERE "venueId"=v AND NEW."courtId" IS NULL
 UNION SELECT x FROM gaming_resource_ids(NEW."courtId") x WHERE NEW."courtId" IS NOT NULL) resources ORDER BY x;
 RETURN NEW;
 END IF;
 RETURN OLD;
END $$;
CREATE TRIGGER gaming_block_occupancy AFTER INSERT OR UPDATE OR DELETE ON "CalendarBlock" FOR EACH ROW EXECUTE FUNCTION gaming_block_occupancy();

-- Preflight: fail rather than discard conflicting legacy reservations/blocks.
INSERT INTO "ResourceOccupancy" (id,"resourceId","bookingId","startsAt","endsAt",running)
SELECT gen_random_uuid()::text,"courtId",id,"slotStart","slotEnd",false FROM "Booking" WHERE status IN ('held','confirmed');
INSERT INTO "ResourceOccupancy" (id,"resourceId","blockId","startsAt","endsAt",running)
SELECT gen_random_uuid()::text,c.id,b.id,b."startsAt",b."endsAt",false FROM "CalendarBlock" b JOIN "Court" c ON c."venueId"=b."venueId" AND (b."courtId" IS NULL OR b."courtId"=c.id);

ALTER TABLE "Venue" ADD COLUMN "gamingSessionsEnabled" boolean NOT NULL DEFAULT false, ADD COLUMN "gamingProductsEnabled" boolean NOT NULL DEFAULT false, ADD COLUMN "gamingReceiptsEnabled" boolean NOT NULL DEFAULT false, ADD COLUMN "gamingBillingPolicy" jsonb;

-- Moving a session uses its current segment's start for destination occupancy.
CREATE OR REPLACE FUNCTION gaming_session_occupancy() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE occupied_start timestamp; occupied_end timestamp;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW."venueId",91005));
 IF NOT EXISTS (SELECT 1 FROM "Court" WHERE id=NEW."unitId" AND "venueId"=NEW."venueId") OR NOT EXISTS (SELECT 1 FROM "GamingOrder" WHERE id=NEW."orderId" AND "venueId"=NEW."venueId") OR (NEW."bookingId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "Booking" WHERE id=NEW."bookingId" AND "venueId"=NEW."venueId")) THEN RAISE EXCEPTION 'RESOURCE_SCOPE_INVALID' USING ERRCODE='23514'; END IF;
 DELETE FROM "ResourceOccupancy" WHERE "sessionId"=NEW.id;
 IF NEW.state='running' THEN
 DELETE FROM "ResourceOccupancy" WHERE "bookingId"=NEW."bookingId";
 SELECT COALESCE(MAX("startedAt"),NEW."startedAt") INTO occupied_start FROM "UsageSegment" WHERE "sessionId"=NEW.id;
 occupied_end:=CASE WHEN NEW."expectedEnd">occupied_start THEN NEW."expectedEnd" ELSE NULL END;
 INSERT INTO "ResourceOccupancy" (id,"resourceId","sessionId","startsAt","endsAt",running)
 SELECT gen_random_uuid()::text,x,NEW.id,occupied_start,occupied_end,true FROM gaming_resource_ids(NEW."unitId") x ORDER BY x;
 END IF; RETURN NEW;
END $$;

CREATE FUNCTION gaming_rebuild_venue(v text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(v,91005));
 DELETE FROM "ResourceOccupancy" WHERE "resourceId" IN (SELECT id FROM "Court" WHERE "venueId"=v);
 INSERT INTO "ResourceOccupancy" (id,"resourceId","bookingId","startsAt","endsAt",running)
 SELECT gen_random_uuid()::text,x,b.id,b."slotStart",b."slotEnd",false FROM "Booking" b CROSS JOIN LATERAL gaming_resource_ids(b."courtId") x
 WHERE b."venueId"=v AND b.status IN ('held','confirmed') AND NOT EXISTS (SELECT 1 FROM "UsageSession" s WHERE s."bookingId"=b.id AND s.state='running') ORDER BY x;
 INSERT INTO "ResourceOccupancy" (id,"resourceId","sessionId","startsAt","endsAt",running)
 SELECT gen_random_uuid()::text,x,s.id,COALESCE((SELECT MAX("startedAt") FROM "UsageSegment" WHERE "sessionId"=s.id),s."startedAt"),CASE WHEN s."expectedEnd">COALESCE((SELECT MAX("startedAt") FROM "UsageSegment" WHERE "sessionId"=s.id),s."startedAt") THEN s."expectedEnd" ELSE NULL END,true FROM "UsageSession" s CROSS JOIN LATERAL gaming_resource_ids(s."unitId") x WHERE s."venueId"=v AND s.state='running' ORDER BY x;
 INSERT INTO "ResourceOccupancy" (id,"resourceId","blockId","startsAt","endsAt",running)
 SELECT gen_random_uuid()::text,c.id,b.id,b."startsAt",b."endsAt",false FROM "CalendarBlock" b JOIN "Court" c ON c."venueId"=b."venueId" AND (b."courtId" IS NULL OR c.id IN (SELECT gaming_resource_ids(b."courtId"))) WHERE b."venueId"=v ORDER BY c.id;
END $$;
CREATE FUNCTION gaming_hierarchy_changed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_TABLE_NAME='Court' THEN
 IF NEW."gamingRoomId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "GamingRoom" WHERE id=NEW."gamingRoomId" AND "venueId"=NEW."venueId") THEN RAISE EXCEPTION 'RESOURCE_SCOPE_INVALID' USING ERRCODE='23514'; END IF;
 END IF;
 IF TG_TABLE_NAME='GamingRoom' THEN
 IF NEW."bookableCourtId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "Court" WHERE id=NEW."bookableCourtId" AND "venueId"=NEW."venueId" AND "gamingRoomId" IS DISTINCT FROM NEW.id) THEN RAISE EXCEPTION 'RESOURCE_SCOPE_INVALID' USING ERRCODE='23514'; END IF;
 END IF;
 PERFORM gaming_rebuild_venue(NEW."venueId"); RETURN NEW;
END $$;
CREATE TRIGGER gaming_room_hierarchy AFTER INSERT OR UPDATE OF occupancy,"bookableCourtId" ON "GamingRoom" FOR EACH ROW EXECUTE FUNCTION gaming_hierarchy_changed();
CREATE TRIGGER gaming_court_hierarchy AFTER UPDATE OF "gamingRoomId" ON "Court" FOR EACH ROW WHEN (OLD."gamingRoomId" IS DISTINCT FROM NEW."gamingRoomId") EXECUTE FUNCTION gaming_hierarchy_changed();

ALTER TABLE "GamingOrder" ADD COLUMN "moneyScale" INTEGER NOT NULL DEFAULT 100;
ALTER TABLE "Payment" ADD CONSTRAINT payment_money_scale CHECK ("moneyScale" IN (1,10,100,1000,10000));
ALTER TABLE "GamingOrder" ADD CONSTRAINT order_money_scale CHECK ("moneyScale" IN (1,10,100,1000,10000));
ALTER TABLE "CashShift" ADD CONSTRAINT shift_money_scale CHECK ("moneyScale" IN (1,10,100,1000,10000));
ALTER TABLE "CashHandover" ADD CONSTRAINT handover_money_scale CHECK ("moneyScale" IN (1,10,100,1000,10000));
CREATE FUNCTION gaming_payment_integrity() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p "Payment"; total bigint;
BEGIN
 IF TG_TABLE_NAME='Payment' THEN SELECT * INTO p FROM "Payment" WHERE id=NEW.id;
 ELSE SELECT * INTO p FROM "Payment" WHERE id=NEW."paymentId"; END IF;
 IF p."gamingOrderId" IS NOT NULL THEN
   SELECT COALESCE(SUM("amountMinor"),0) INTO total FROM "GamingPaymentAllocation" WHERE "paymentId"=p.id;
   IF total*p."moneyScale"<>(SELECT p.amount::bigint*o."moneyScale" FROM "GamingOrder" o WHERE o.id=p."gamingOrderId") OR EXISTS (SELECT 1 FROM "GamingPaymentAllocation" a JOIN "GamingOrderLine" l ON l.id=a."lineId" WHERE a."paymentId"=p.id AND l."orderId"<>p."gamingOrderId") OR NOT EXISTS (SELECT 1 FROM "GamingOrder" o WHERE o.id=p."gamingOrderId" AND o.currency=p.currency AND (p."bookingId" IS NULL OR o."venueId"=(SELECT "venueId" FROM "Booking" WHERE id=p."bookingId"))) THEN RAISE EXCEPTION 'PAYMENT_ALLOCATION_MISMATCH' USING ERRCODE='23514'; END IF;
 END IF; RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER gaming_payment_integrity AFTER INSERT OR UPDATE ON "Payment" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION gaming_payment_integrity();
CREATE CONSTRAINT TRIGGER gaming_allocation_integrity AFTER INSERT ON "GamingPaymentAllocation" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION gaming_payment_integrity();
CREATE FUNCTION gaming_segment_integrity() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE sid text; s "UsageSession"; cnt int; opens int; first_start timestamp; last_end timestamp;
BEGIN
 IF TG_TABLE_NAME='UsageSession' THEN sid:=NEW.id; ELSE sid:=NEW."sessionId"; END IF;
 SELECT * INTO s FROM "UsageSession" WHERE id=sid;
 SELECT COUNT(*),COUNT(*) FILTER (WHERE "endedAt" IS NULL),MIN("startedAt"),MAX("endedAt") INTO cnt,opens,first_start,last_end FROM "UsageSegment" WHERE "sessionId"=sid;
 IF cnt=0 OR first_start<>s."startedAt" OR (s.state='running' AND opens<>1) OR (s.state<>'running' AND (opens<>0 OR last_end<>s."endedAt")) OR EXISTS (SELECT 1 FROM (SELECT "startedAt",LAG("endedAt") OVER (ORDER BY "startedAt",id) previous_end,ROW_NUMBER() OVER (ORDER BY "startedAt",id) n FROM "UsageSegment" WHERE "sessionId"=sid) q WHERE n>1 AND previous_end IS DISTINCT FROM "startedAt") THEN RAISE EXCEPTION 'SESSION_SEGMENTS_INVALID' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER gaming_session_segments AFTER INSERT OR UPDATE ON "UsageSession" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION gaming_segment_integrity();
CREATE CONSTRAINT TRIGGER gaming_segment_continuity AFTER INSERT OR UPDATE ON "UsageSegment" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION gaming_segment_integrity();

ALTER TABLE "Court" ADD COLUMN "gamingPublished" boolean NOT NULL DEFAULT true;

ALTER TABLE "Notification" ADD COLUMN "dedupKey" text;
CREATE UNIQUE INDEX "Notification_dedupKey_key" ON "Notification"("dedupKey");

ALTER TABLE "Payment" ADD COLUMN "gamingReversesPaymentId" text REFERENCES "Payment"(id) ON DELETE RESTRICT;
CREATE INDEX "Payment_gamingReversesPaymentId_idx" ON "Payment"("gamingReversesPaymentId");

CREATE FUNCTION gaming_booking_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW."venueId",91005));
 IF NOT EXISTS (SELECT 1 FROM "Court" WHERE id=NEW."courtId" AND "venueId"=NEW."venueId") THEN RAISE EXCEPTION 'RESOURCE_SCOPE_INVALID' USING ERRCODE='23514'; END IF;
 IF NEW.status IN ('held','confirmed') THEN
  IF EXISTS (SELECT 1 FROM "Court" c JOIN "SportCategory" sport ON sport.id=c."sportId" JOIN "Venue" v ON v.id=c."venueId" WHERE c.id=NEW."courtId" AND sport."activityKind" IN ('gaming-station','table-game') AND (NOT c."gamingPublished" OR v.status<>'active' OR v."approvedAt" IS NULL)) THEN RAISE EXCEPTION 'GAMING_NOT_APPROVED_OR_PUBLISHED' USING ERRCODE='23514'; END IF;
  IF EXISTS (SELECT 1 FROM gaming_resource_ids(NEW."courtId") x JOIN "ResourceOccupancy" o ON o."resourceId"=x JOIN "UsageSession" s ON s.id=o."sessionId" WHERE o.running AND s."expectedEnd"<=clock_timestamp() AT TIME ZONE 'UTC' AND NEW."slotEnd">clock_timestamp() AT TIME ZONE 'UTC' AND s."bookingId" IS DISTINCT FROM NEW.id) THEN RAISE EXCEPTION 'RESOURCE_IN_USE' USING ERRCODE='23P01'; END IF;
 END IF;
 IF TG_OP='UPDATE' AND EXISTS (SELECT 1 FROM "UsageSession" WHERE "bookingId"=OLD.id) AND (NEW."courtId" IS DISTINCT FROM OLD."courtId" OR NEW."slotStart" IS DISTINCT FROM OLD."slotStart" OR NEW."slotEnd" IS DISTINCT FROM OLD."slotEnd" OR NEW."totalAmount" IS DISTINCT FROM OLD."totalAmount" OR (NEW.status IN ('cancelled','no_show') AND NEW.status IS DISTINCT FROM OLD.status)) THEN RAISE EXCEPTION 'GAMING_ORDER_REQUIRED' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER gaming_booking_guard BEFORE INSERT OR UPDATE ON "Booking" FOR EACH ROW EXECUTE FUNCTION gaming_booking_guard();

-- Legacy financial writes must use the linked order allocation cycle after check-in.
CREATE FUNCTION gaming_booking_payment_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW."bookingId" IS NOT NULL AND EXISTS (SELECT 1 FROM "UsageSession" s WHERE s."bookingId"=NEW."bookingId" AND s."orderId" IS DISTINCT FROM NEW."gamingOrderId") THEN RAISE EXCEPTION 'BOOKING_LINKED_TO_SESSION' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER gaming_booking_payment_guard BEFORE INSERT OR UPDATE ON "Payment" FOR EACH ROW EXECUTE FUNCTION gaming_booking_payment_guard();

ALTER TABLE "GamingOrder" ADD COLUMN "guestPhone" text;

ALTER TABLE "ReceiptSettings" ADD COLUMN "logoPhotoId" text;

-- Optional receipts for existing sports bookings keep the original Payment and Booking.
ALTER TABLE "ReceiptDocument" ALTER COLUMN "orderId" DROP NOT NULL;
ALTER TABLE "ReceiptDocument" ADD COLUMN "bookingId" TEXT REFERENCES "Booking"(id) ON DELETE RESTRICT;
