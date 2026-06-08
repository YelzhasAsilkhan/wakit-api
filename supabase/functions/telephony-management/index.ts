import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { Context, Hono } from "@hono/hono";
import { cors } from "jsr:@hono/hono/cors";
import { HTTPException } from "jsr:@hono/hono/http-exception";
import * as log from "../_shared/logger.ts";
import {
  ApiKeyRow,
  createApiClient,
  createClient,
  type MessageInsert,
} from "../_shared/supabase.ts";
import { normalizePhone } from "../_shared/telephony.ts";
import { type User } from "@supabase/supabase-js";

type ConnectPayload = {
  organization_id: string;
  account_sid: string;
  auth_token: string;
  phone_number: string;
  phone_number_sid?: string;
};

type CallPayload = {
  organization_id: string;
  organization_address?: string;
  contact_phone: string;
  twiml?: string;
};

type AppEnv = {
  Variables: {
    supabase: ReturnType<typeof createClient>;
    user: User;
    token: string;
    apiKey: ApiKeyRow;
  };
};

const app = new Hono<AppEnv>();

app.use("*", cors());

app.use("*", async (c, next) => {
  const token = c.req.header("Authorization")?.replace("Bearer ", "");

  if (!token) {
    throw new HTTPException(401, { message: "Missing authorization token" });
  }

  c.set("token", token);

  if (token.startsWith("eyJ")) {
    const client = createClient(c.req.raw);
    const { data: { user }, error } = await client.auth.getUser();

    if (error || !user) {
      throw new HTTPException(401, { message: "Invalid JWT", cause: error });
    }

    c.set("user", user);
    c.set("supabase", client);
    await next();
    return;
  }

  const client = createApiClient(c.req.raw);
  const { data: apiKey, error } = await client
    .from("api_keys")
    .select()
    .eq("key", token)
    .maybeSingle();

  if (error || !apiKey) {
    throw new HTTPException(401, { message: "Invalid API key", cause: error });
  }

  c.set("apiKey", apiKey);
  c.set("supabase", client);
  await next();
});

function requireRoles(roles: Array<"member" | "admin" | "owner">) {
  return async (c: Context<AppEnv>, next: () => Promise<void>) => {
    const client = c.get("supabase");
    const body = await c.req.raw.clone().json().catch(() => ({}));
    const organization_id = body.organization_id as string | undefined;
    const user = c.get("user");

    if (!organization_id) {
      throw new HTTPException(400, { message: "organization_id is required" });
    }

    if (user) {
      const { error: agentError, data: agent } = await client
        .from("agents")
        .select("organization_id")
        .eq("user_id", user.id)
        .eq("organization_id", organization_id)
        .in("extra->>role", roles)
        .maybeSingle();

      if (agentError || !agent) {
        throw new HTTPException(403, {
          message: `User not authorized for organization ${organization_id}`,
          cause: agentError,
        });
      }

      await next();
      return;
    }

    const apiKey = c.get("apiKey")!;

    if (
      organization_id !== apiKey.organization_id || !roles.includes(apiKey.role)
    ) {
      throw new HTTPException(403, {
        message: `API key not authorized for organization ${organization_id}`,
      });
    }

    await next();
  };
}

app.post("/telephony-management/connect", requireRoles(["admin", "owner"]), async (c) => {
  const body = await c.req.json<ConnectPayload>();
  const client = c.get("supabase");
  const phoneNumber = body.phone_number.startsWith("+")
    ? body.phone_number
    : `+${normalizePhone(body.phone_number)}`;
  const address = body.phone_number_sid ?? normalizePhone(phoneNumber);

  await client
    .from("organizations_addresses")
    .upsert({
      organization_id: body.organization_id,
      service: "telephony",
      address,
      status: "connected",
      extra: {
        account_sid: body.account_sid,
        auth_token: body.auth_token,
        phone_number: phoneNumber,
      },
    }, { onConflict: "organization_id,address" })
    .throwOnError();

  log.info("Telephony account connected", {
    organization_id: body.organization_id,
    address,
  });

  return c.json({ status: "connected", address, phone_number: phoneNumber });
});

app.delete(
  "/telephony-management/connect",
  requireRoles(["admin", "owner"]),
  async (c) => {
    const body = await c.req.json<
      { organization_id: string; organization_address: string }
    >();
    const client = c.get("supabase");

    await client
      .from("organizations_addresses")
      .update({ status: "disconnected" })
      .eq("organization_id", body.organization_id)
      .eq("address", body.organization_address)
      .eq("service", "telephony")
      .throwOnError();

    return c.json({ status: "disconnected" });
  },
);

app.post("/telephony-management/call", requireRoles(["member", "admin", "owner"]), async (c) => {
  const body = await c.req.json<CallPayload>();
  const client = c.get("supabase");
  const contactPhone = normalizePhone(body.contact_phone);

  let query = client
    .from("organizations_addresses")
    .select("address, extra")
    .eq("organization_id", body.organization_id)
    .eq("service", "telephony")
    .eq("status", "connected");

  if (body.organization_address) {
    query = query.eq("address", body.organization_address);
  }

  const { data: accounts } = await query.limit(1).throwOnError();

  if (!accounts.length) {
    throw new HTTPException(404, { message: "No connected telephony account" });
  }

  const account = accounts[0];
  const message: MessageInsert = {
    organization_id: body.organization_id,
    organization_address: account.address,
    contact_address: contactPhone,
    service: "telephony",
    direction: "outgoing",
    content: {
      version: "1",
      type: "data",
      kind: "call",
      data: {
        action: "dial",
        direction: "outbound",
        twiml: body.twiml,
      },
    },
  };

  const { data: inserted } = await client
    .from("messages")
    .insert(message)
    .select("id")
    .single()
    .throwOnError();

  return c.json({ status: "queued", message_id: inserted.id });
});

app.get("/telephony-management/accounts", async (c) => {
  const orgId = c.req.query("organization_id");

  if (!orgId) {
    throw new HTTPException(400, { message: "organization_id is required" });
  }

  const client = c.get("supabase");
  const { data: accounts } = await client
    .from("organizations_addresses")
    .select("address, status, extra")
    .eq("organization_id", orgId)
    .eq("service", "telephony")
    .throwOnError();

  return c.json({
    accounts: accounts.map((a) => ({
      address: a.address,
      status: a.status,
      phone_number: (a.extra as { phone_number?: string })?.phone_number,
      account_sid: (a.extra as { account_sid?: string })?.account_sid,
    })),
  });
});

Deno.serve(app.fetch);
