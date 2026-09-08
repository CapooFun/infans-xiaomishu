export function createProactiveInteractionService() {
  return {
    peek: async () => ({ items: [] }),
    ack: async () => ({ ok: true }),
  };
}
