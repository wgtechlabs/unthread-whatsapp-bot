const ticketStatusTemplates = {
  ticket_closed: true,
  ticket_on_hold: true,
  ticket_in_progress: true,
  ticket_resumed: true,
} as const;

export type StatusTemplateKey = keyof typeof ticketStatusTemplates;

export function resolveStatusTemplateKey(
  newStatus: string,
  previousStatus?: string,
): StatusTemplateKey | null {
  const status = newStatus.toLowerCase().replace(/-/g, "_");
  const prevStatus = previousStatus?.toLowerCase().replace(/-/g, "_") ?? "";

  switch (status) {
    case "closed":
    case "resolved":
      return "ticket_closed";
    case "on_hold":
    case "waiting":
      return "ticket_on_hold";
    case "open":
      return prevStatus === "on_hold" || prevStatus === "waiting" ? "ticket_resumed" : null;
    case "in_progress":
      return prevStatus === "on_hold" || prevStatus === "waiting"
        ? "ticket_resumed"
        : "ticket_in_progress";
    default:
      return null;
  }
}
