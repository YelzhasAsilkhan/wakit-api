import type { SupabaseClient } from "@supabase/supabase-js";
import { HTTPException } from "jsr:@hono/hono/http-exception";
import type { Database, OutgoingMessage, Template } from "../_shared/supabase.ts";

function normalizePhone(phone: string): string {
  return phone.replace(/\D/g, "");
}

export type StartConversationPayload = {
  organization_id: string;
  organization_address?: string;
  contact_phone: string;
  contact_name?: string;
  template: Template;
};

export type StartConversationResult = {
  conversation_id: string;
  message_id: string;
  contact_address: string;
};

async function resolveWhatsAppAccount(
  client: SupabaseClient<Database>,
  organizationId: string,
  organizationAddress?: string,
) {
  let query = client
    .from("organizations_addresses")
    .select("address, extra")
    .eq("organization_id", organizationId)
    .eq("service", "whatsapp")
    .eq("status", "connected");

  if (organizationAddress) {
    query = query.eq("address", organizationAddress);
  }

  const { data: accounts } = await query.limit(1).throwOnError();

  if (!accounts.length) {
    throw new HTTPException(404, {
      message: "No connected WhatsApp account found for this organization",
    });
  }

  return accounts[0];
}

async function ensureContact(
  client: SupabaseClient<Database>,
  organizationId: string,
  contactPhone: string,
  contactName?: string,
) {
  const { data: existingAddress } = await client
    .from("contacts_addresses")
    .select("contact_id, extra")
    .eq("organization_id", organizationId)
    .eq("address", contactPhone)
    .maybeSingle();

  if (existingAddress?.contact_id) {
    if (contactName) {
      await client
        .from("contacts")
        .update({ name: contactName })
        .eq("id", existingAddress.contact_id)
        .eq("organization_id", organizationId)
        .throwOnError();
    }
    return;
  }

  let contactId: string | null = null;

  if (contactName) {
    const { data: contact } = await client
      .from("contacts")
      .insert({
        organization_id: organizationId,
        name: contactName,
      })
      .select("id")
      .single()
      .throwOnError();

    contactId = contact.id;
  }

  await client
    .from("contacts_addresses")
    .upsert({
      organization_id: organizationId,
      address: contactPhone,
      service: "whatsapp",
      contact_id: contactId,
      status: "active",
      extra: contactName ? { name: contactName } : {},
    }, { onConflict: "organization_id,address" })
    .throwOnError();
}

export async function startConversation(
  client: SupabaseClient<Database>,
  payload: StartConversationPayload,
): Promise<StartConversationResult> {
  if (!payload.template?.name) {
    throw new HTTPException(400, { message: "template.name is required" });
  }

  if (!payload.template.language?.code) {
    throw new HTTPException(400, {
      message: "template.language.code is required",
    });
  }

  const contactPhone = normalizePhone(payload.contact_phone);

  if (!contactPhone) {
    throw new HTTPException(400, { message: "contact_phone is required" });
  }

  const account = await resolveWhatsAppAccount(
    client,
    payload.organization_id,
    payload.organization_address,
  );

  await ensureContact(
    client,
    payload.organization_id,
    contactPhone,
    payload.contact_name,
  );

  const content: OutgoingMessage = {
    version: "1",
    type: "data",
    kind: "template",
    data: {
      name: payload.template.name,
      language: {
        code: payload.template.language.code,
        policy: payload.template.language.policy ?? "deterministic",
      },
      components: payload.template.components,
    },
  };

  const { data: message } = await client
    .from("messages")
    .insert({
      organization_id: payload.organization_id,
      organization_address: account.address,
      contact_address: contactPhone,
      service: "whatsapp",
      direction: "outgoing",
      content,
    })
    .select("id, conversation_id")
    .single()
    .throwOnError();

  return {
    conversation_id: message.conversation_id,
    message_id: message.id,
    contact_address: contactPhone,
  };
}
