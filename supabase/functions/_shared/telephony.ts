/** Normalize phone numbers to digits-only (E.164 without +). */
export function normalizePhone(phone: string): string {
  return phone.replace(/\D/g, "");
}

export type TelephonyAccountExtra = {
  account_sid?: string;
  auth_token?: string;
  phone_number?: string;
};

export type CallMessageData = {
  action?: "dial";
  direction?: "inbound" | "outbound";
  status?: string;
  duration_seconds?: number | null;
  from?: string;
  to?: string;
  twiml?: string;
};

export function defaultOutboundTwiml(to: string): string {
  const escaped = to.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<Response><Dial>${escaped}</Dial></Response>`;
}

export function twilioStatusToMessageStatus(
  callStatus: string,
): Record<string, string> {
  switch (callStatus) {
    case "queued":
    case "ringing":
      return { pending: new Date().toISOString() };
    case "in-progress":
      return { delivered: new Date().toISOString() };
    case "completed":
      return { read: new Date().toISOString() };
    default:
      return { failed: new Date().toISOString() };
  }
}
