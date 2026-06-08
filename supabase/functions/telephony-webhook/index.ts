import * as log from "../_shared/logger.ts";
import {
  createUnsecureClient,
  type MessageInsert,
} from "../_shared/supabase.ts";
import {
  normalizePhone,
  twilioStatusToMessageStatus,
  type CallMessageData,
} from "../_shared/telephony.ts";

const DEFAULT_AUTH_TOKEN = Deno.env.get("TWILIO_AUTH_TOKEN") ?? "";

function parseTwilioForm(body: string): Record<string, string> {
  const params = new URLSearchParams(body);
  const result: Record<string, string> = {};

  for (const [key, value] of params.entries()) {
    result[key] = value;
  }

  return result;
}

Deno.serve(async (request) => {
  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const body = await request.text();
  const params = parseTwilioForm(body);
  const callSid = params.CallSid;
  const from = params.From;
  const to = params.To;
  const callStatus = params.CallStatus ?? "unknown";
  const callDuration = params.CallDuration
    ? Number(params.CallDuration)
    : null;

  if (!callSid || !from || !to) {
    log.warn("Twilio webhook missing required fields", params);
    return new Response("Bad Request", { status: 400 });
  }

  const client = createUnsecureClient();
  const toDigits = normalizePhone(to);

  const { data: accounts } = await client
    .from("organizations_addresses")
    .select()
    .eq("service", "telephony")
    .eq("status", "connected")
    .throwOnError();

  const account = accounts.find((row) => {
    const phone = (row.extra as { phone_number?: string })?.phone_number ?? "";
    return row.address === to ||
      phone === to ||
      normalizePhone(phone) === toDigits;
  });

  if (!account) {
    log.warn("No telephony account found for To number", { to });
    return twimlResponse(
      "<Response><Say>Number not configured.</Say></Response>",
    );
  }

  const contactAddress = normalizePhone(from);
  const callContent: CallMessageData = {
    direction: "inbound",
    status: callStatus,
    duration_seconds: callDuration,
    from,
    to,
  };

  const message: MessageInsert = {
    organization_id: account.organization_id,
    organization_address: account.address,
    contact_address: contactAddress,
    service: "telephony",
    direction: "incoming",
    external_id: callSid,
    content: {
      version: "1",
      type: "data",
      kind: "call",
      data: callContent,
    },
    status: twilioStatusToMessageStatus(callStatus),
  };

  const { data: existing } = await client
    .from("messages")
    .select("id")
    .eq("external_id", callSid)
    .maybeSingle();

  if (existing) {
    await client
      .from("messages")
      .update({
        content: message.content,
        status: message.status,
      })
      .eq("id", existing.id)
      .throwOnError();
  } else {
    await client.from("messages").insert(message).throwOnError();
  }

  log.info("Processed telephony webhook", {
    callSid,
    callStatus,
    organization_id: account.organization_id,
  });

  if (callStatus === "ringing" || callStatus === "queued") {
    return twimlResponse(
      "<Response><Say>Please hold while we connect you.</Say></Response>",
    );
  }

  return new Response("", { status: 200 });
});

function twimlResponse(twiml: string): Response {
  return new Response(twiml, {
    status: 200,
    headers: { "Content-Type": "text/xml" },
  });
}
