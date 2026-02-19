import Twilio from "twilio";
import { config } from "../config";

const client = Twilio(config.twilio.accountSid, config.twilio.authToken);

// Send a WhatsApp message back to the user via Twilio
export async function sendWhatsAppMessage(
  to: string,
  body: string,
): Promise<string> {
  const message = await client.messages.create({
    from: config.twilio.whatsappNumber,
    to,
    body,
  });

  console.log(`[twilio] Sent message ${message.sid} to ${to}`);
  return message.sid;
}

// Extract phone number from Twilio WhatsApp format
// "whatsapp:+1234567890" -> "+1234567890"
export function extractPhone(twilioFrom: string): string {
  return twilioFrom.replace("whatsapp:", "");
}

// Format phone to Twilio WhatsApp format
// "+1234567890" -> "whatsapp:+1234567890"
export function toWhatsAppFormat(phone: string): string {
  if (phone.startsWith("whatsapp:")) return phone;
  return `whatsapp:${phone}`;
}

// Validate Twilio webhook signature
export function validateTwilioSignature(
  url: string,
  params: Record<string, string>,
  signature: string,
): boolean {
  return Twilio.validateRequest(
    config.twilio.authToken,
    signature,
    url,
    params,
  );
}
