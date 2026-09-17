export const OTP_DELIVERY = 'OTP_DELIVERY';

export interface OtpDelivery {
  send(target: string, code: string): Promise<void>;
  /** Providers such as Twilio Verify validate the code remotely. */
  verify?(target: string, code: string): Promise<boolean>;
}
