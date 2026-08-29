// @livekit/agents-plugin-openai's generic TTS class hardcodes
// `response_format: "pcm"`, which OpenAI itself supports but Groq's Orpheus
// endpoint rejects ("response_format must be one of [wav]") -- so Orpheus
// needs its own thin TTS adapter instead of borrowing the openai plugin's.
// Mirrors that plugin's own TTS/ChunkedStream shape (see its tts.js) so
// AgentSession can use it identically.
import { tts, AudioByteStream, shortuuid } from "@livekit/agents";
import Groq from "groq-sdk";

const DEFAULT_SAMPLE_RATE = 24000;
const NUM_CHANNELS = 1;

// Minimal canonical-WAV reader: scans chunks for "fmt " (sample rate/channels)
// and "data" (PCM payload) rather than assuming a fixed 44-byte header.
function parseWav(arrayBuffer) {
  const view = new DataView(arrayBuffer);
  let offset = 12; // skip "RIFF"<size>"WAVE"
  let sampleRate = DEFAULT_SAMPLE_RATE;
  let numChannels = NUM_CHANNELS;
  let dataOffset = -1;
  let dataLength = 0;

  while (offset + 8 <= view.byteLength) {
    const id = String.fromCharCode(
      view.getUint8(offset), view.getUint8(offset + 1), view.getUint8(offset + 2), view.getUint8(offset + 3),
    );
    const size = view.getUint32(offset + 4, true);
    if (id === "fmt ") {
      numChannels = view.getUint16(offset + 10, true);
      sampleRate = view.getUint32(offset + 12, true);
    } else if (id === "data") {
      dataOffset = offset + 8;
      dataLength = size;
      break;
    }
    offset += 8 + size + (size % 2);
  }
  if (dataOffset === -1) {
    dataOffset = 44;
    dataLength = view.byteLength - 44;
  }
  return { sampleRate, numChannels, pcm: arrayBuffer.slice(dataOffset, dataOffset + dataLength) };
}

export class OrpheusTTS extends tts.TTS {
  label = "groq.OrpheusTTS";

  constructor({ model = "canopylabs/orpheus-v1-english", voice = "hannah", apiKey } = {}) {
    super(DEFAULT_SAMPLE_RATE, NUM_CHANNELS, { streaming: false });
    this._model = model;
    this.voice = voice;
    this.client = new Groq({ apiKey: apiKey || process.env.GROQ_API_KEY });
  }

  get model() {
    return this._model;
  }

  get provider() {
    return "groq";
  }

  synthesize(text, connOptions, abortSignal) {
    return new OrpheusChunkedStream(this, text, connOptions, abortSignal);
  }

  stream() {
    throw new Error("Streaming is not supported on Groq Orpheus TTS");
  }

  async close() {}
}

class OrpheusChunkedStream extends tts.ChunkedStream {
  label = "groq.OrpheusChunkedStream";

  constructor(ttsInstance, text, connOptions, abortSignal) {
    super(text, ttsInstance, connOptions, abortSignal);
    this.ttsInstance = ttsInstance;
  }

  async run() {
    try {
      const response = await this.ttsInstance.client.audio.speech.create({
        model: this.ttsInstance.model,
        voice: this.ttsInstance.voice,
        input: this.inputText,
        response_format: "wav",
      });
      const arrayBuffer = await response.arrayBuffer();
      const { sampleRate, numChannels, pcm } = parseWav(arrayBuffer);

      const requestId = shortuuid();
      const byteStream = new AudioByteStream(sampleRate, numChannels);
      const frames = byteStream.write(pcm);

      let lastFrame;
      const sendLastFrame = (final) => {
        if (lastFrame) {
          this.queue.put({ requestId, segmentId: requestId, frame: lastFrame, final });
          lastFrame = undefined;
        }
      };
      for (const frame of frames) {
        sendLastFrame(false);
        lastFrame = frame;
      }
      sendLastFrame(true);
    } catch (error) {
      if (error?.name === "AbortError") return;
      throw error;
    } finally {
      this.queue.close();
    }
  }
}
