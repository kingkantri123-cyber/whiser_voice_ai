import ffmpeg from "fluent-ffmpeg";
import ffmpegPath from "ffmpeg-static";
import { PassThrough } from "stream";

ffmpeg.setFfmpegPath(ffmpegPath);

/**
 * Runs an incoming audio buffer through ffmpeg to normalize it before it
 * reaches Whisper. This is the backend counterpart to the getUserMedia
 * constraints on the client -- it doesn't assume the browser honored those
 * constraints, and it applies things the browser can't do at all.
 *
 * Stages:
 *  1. highpass -- cuts low-frequency rumble (AC hum, desk vibration, handling
 *     noise) that noiseSuppression on the client may not fully catch.
 *  2. loudnorm -- normalizes loudness to a consistent target (EBU R128-ish),
 *     so a caller who's quiet/far from the mic and one who's loud/close both
 *     transcribe consistently. autoGainControl on the client is per-device and
 *     inconsistent; this guarantees the same normalization every time.
 *  3. silenceremove (x2, with areverse in between) -- trims leading and
 *     trailing dead air. Whisper is known to hallucinate short phrases on
 *     silence-only segments, so trimming reduces junk transcriptions.
 *  4. downmix to mono, resample to 16kHz -- Whisper's native input format;
 *     sending anything higher just wastes upload bandwidth and gets
 *     resampled server-side anyway.
 *
 * @param {Buffer} inputBuffer - raw audio buffer from the client upload
 * @returns {Promise<Buffer>} processed WAV buffer, 16kHz mono PCM
 */
export function preprocessAudio(inputBuffer) {
  return new Promise((resolve, reject) => {
    const input = new PassThrough();
    input.end(inputBuffer);

    const chunks = [];
    const output = new PassThrough();
    output.on("data", (chunk) => chunks.push(chunk));
    output.on("end", () => resolve(Buffer.concat(chunks)));
    output.on("error", reject);

    ffmpeg(input)
      .audioFilters([
        "highpass=f=80",
        "loudnorm=I=-16:TP=-1.5:LRA=11",
        "silenceremove=start_periods=1:start_silence=0.1:start_threshold=-45dB",
        "areverse",
        "silenceremove=start_periods=1:start_silence=0.1:start_threshold=-45dB",
        "areverse",
      ])
      .audioChannels(1)
      .audioFrequency(16000)
      .format("wav")
      .on("error", (err) =>
        reject(new Error(`ffmpeg processing failed: ${err.message}`))
      )
      .pipe(output, { end: true });
  });
}
