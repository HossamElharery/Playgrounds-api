-- What a registered device's app build can do. 'native-call-ui' = the Android build that shows
-- a full-screen incoming-call screen from a data-only push. Older builds have none, so they keep
-- getting the ordinary notification push.
ALTER TABLE "DeviceToken" ADD COLUMN "capabilities" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
