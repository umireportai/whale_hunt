export function providerStatus(): { available: false; reason: string } {
  return {
    available: false,
    reason:
      process.env.NANSEN_API_KEY
        ? 'A Nansen key is configured but live mode is opt-in. Set DATA_MODE=live only after reviewing the provider credit budget and attribution requirements.'
        : 'Live challenges need a Nansen API key and verified collection setup. Synthetic practice is ready to play; no provider requests are sent.',
  };
}
