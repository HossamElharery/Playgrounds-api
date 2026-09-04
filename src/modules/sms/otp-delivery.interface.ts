export const OTP_DELIVERY = 'OTP_DELIVERY';

export interface OtpDelivery {
  send(target: string, code: string): Promise<void>;
}
