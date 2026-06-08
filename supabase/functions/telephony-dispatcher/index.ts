import * as log from "../_shared/logger.ts";
import {
  createUnsecureClient,
  type MessageRow,
  type WebhookPayload,
} from "../_shared/supabase.ts";
import {
  defaultOutboundTwiml,
  type CallMessageData,
  type TelephonyAccountExtra,
} from "../_shared/telephony.ts";

const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const DEFAULT_AUTH_TOKEN = Deno.env.get("TWILIO_AUTH_TOKEN") ?? "";
const FUNCTIONS_URL = Deno.env.get("SUPABASE_URL")?.replace(
  /\.supabase\.co$/,
  ".functions.supabase.co",
) ?? "";

Deno.serve(async (req) => {
  const authHeader = req.headers.get("Authorization");
  const token = authHeader?.replace("Bearer ", "");

  if (token !== SERVICE_ROLE_KEY) {
    return new Response("Unauthorized", { status: 401 });
  }

  const client = createUnsecureClient();
  const message = ((await req.json()) as WebhookPayload<MessageRow>).record!;

  if (message.direction !== "outgoing") {
    return new Response("ok");
  }

  if (message.content.kind !== "call") {
    throw new Error(
      `Telephony dispatcher only supports call messages, got kind=${message.content.kind}`,
    );
  }

  if (!message.contact_address) {
    throw new Error(`Message ${message.id} is missing contact_address`);
  }

  const { data: account } = await client
    .from("organizations_addresses")
    .select("extra")
    .eq("organization_id", message.organization_id)
    .eq("address", message.organization_address)
    .single()
    .throwOnError();

  const extra = account.extra as TelephonyAccountExtra;
  const accountSid = extra.account_sid;
  const authToken = extra.auth_token || DEFAULT_AUTH_TOKEN;
  const fromNumber = extra.phone_number;

  if (!accountSid || !authToken || !fromNumber) {
    throw new Error("Telephony account is missing account_sid, auth_token, or phone_number");
  }

  const callData = message.content.data as CallMessageData;
  const twiml = callData.twiml ?? defaultOutboundTwiml(message.contact_address);
  const statusCallback = FUNCTIONS_URL
    ? `${FUNCTIONS_URL}/telephony-webhook`
    : undefined;

  const form = new URLSearchParams({
    To: message.contact_address.startsWith("+")
      ? message.contact_address
      : `+${message.contact_address}`,
    From: fromNumber.startsWith("+") ? fromNumber : `+${fromNumber}`,
    Twiml: twiml,
  });

  if (statusCallback) {
    form.set("StatusCallback", statusCallback);
    form.set("StatusCallbackMethod", "POST");
  }

  const response = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Calls.json`,
    {
      method: "POST",
      headers: {
        Authorization: "Basic " + btoa(`${accountSid}:${authToken}`),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: form.toString(),
    },
  );

  if (!response.ok) {
    const errorBody = await response.text();
    log.error("Twilio call failed", { message_id: message.id, errorBody });

    await client
      .from("messages")
      .update({
        status: {
          failed: new Date().toISOString(),
          errors: [errorBody],
        },
      })
      .eq("id", message.id)
      .throwOnError();

    throw new Error(`Twilio call failed: ${errorBody}`);
  }

  const result = await response.json();

  await client
    .from("messages")
    .update({
      external_id: result.sid,
      status: { accepted: new Date().toISOString() },
    })
    .eq("id", message.id)
    .throwOnError();

  log.info("Outbound call initiated", {
    message_id: message.id,
    call_sid: result.sid,
  });

  return new Response("ok");
});
