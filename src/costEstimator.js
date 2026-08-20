import pricing from "./data/pricing.json" with { type: "json" };

function money(value) {
  return value == null ? null : Math.round(value * 1000000) / 1000000;
}

export function estimateCost(summary, rates = pricing) {
  const stt = rates.stt.pricePerMinute == null ? null : money(summary.stt.audioMinutes * rates.stt.pricePerMinute);
  const llmInput = rates.llm.pricePerMillionInputTokens == null ? null : money(summary.llm.inputTokens / 1_000_000 * rates.llm.pricePerMillionInputTokens);
  const llmOutput = rates.llm.pricePerMillionOutputTokens == null ? null : money(summary.llm.outputTokens / 1_000_000 * rates.llm.pricePerMillionOutputTokens);
  const ttsCharacters = summary.tts.successfulCharacters ?? summary.tts.primaryCharacters;
  const tts = rates.tts.pricePerMillionCharacters == null ? null : money(ttsCharacters / 1_000_000 * rates.tts.pricePerMillionCharacters);
  const values = [stt, llmInput, llmOutput, tts];
  return {
    stt,
    llm: llmInput == null || llmOutput == null ? null : money(llmInput + llmOutput),
    tts,
    total: values.some((value) => value == null) ? null : money(values.reduce((sum, value) => sum + value, 0)),
    rates,
  };
}

export function scaleEstimate(dailyCost, days) {
  return dailyCost == null ? null : money(dailyCost * days);
}

export function aggregateUsage(calls) {
  const events = calls.flatMap((call) => call.usage?.events || []);
  const sum = (items, field) => items.reduce((total, item) => total + (Number(item[field]) || 0), 0);
  const stt = events.filter((event) => event.type === "stt");
  const llm = events.filter((event) => event.type === "llm");
  const tts = events.filter((event) => event.type === "tts");
  const primary = tts.filter((event) => event.role === "primary TTS" && event.status === "success");
  const fallback = tts.filter((event) => event.role === "fallback TTS" && event.status === "success");
  const audioSeconds = sum(stt, "audioSeconds");

  return {
    stt: { requests: stt.length, audioSeconds, audioMinutes: audioSeconds / 60, audioHours: audioSeconds / 3600 },
    llm: {
      requests: llm.length,
      inputTokens: sum(llm, "inputTokens"),
      outputTokens: sum(llm, "outputTokens"),
      totalTokens: sum(llm, "totalTokens"),
    },
    tts: {
      primaryRequests: primary.length,
      primaryCharacters: sum(primary, "charactersSent"),
      fallbackRequests: fallback.length,
      fallbackCharacters: sum(fallback, "charactersSent"),
      successfulCharacters: sum([...primary, ...fallback], "charactersSent"),
    },
  };
}
