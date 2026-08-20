import Groq from "groq-sdk";

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

/**
 * Transcribes audio using Groq Whisper.
 * @param {Buffer} audioBuffer - Raw audio file buffer.
 * @param {string} mimeType - Audio mime type (e.g. 'audio/wav', 'audio/webm').
 * @returns {Promise<string>} Transcribed text.
 */
export async function transcribeAudio(audioBuffer, mimeType = "audio/wav") {
    // Convert Node buffer into a File object for Groq SDK
    const audioFile = new File([audioBuffer], "speech.wav", { type: mimeType });

    const response = await groq.audio.transcriptions.create({
        file: audioFile,
        model: "whisper-large-v3-turbo",
        response_format: "json",
    });

    return response.text;
}

/**
 * Generates spoken audio using Canopy TTS (Orpheus), with Deepgram Aura fallback.
 * @param {string} text - Text to synthesize.
 * @param {string} voice - Voice model (e.g., 'hannah', 'austin', 'troy').
 * @returns {Promise<Buffer>} Audio WAV buffer.
 */
export async function generateSpeech(text, voice = "hannah") {
    try {
        const response = await groq.audio.speech.create({
            model: "canopylabs/orpheus-v1-english",
            voice: voice,
            input: text,
            response_format: "wav", // Orpheus only supports wav, not mp3
        });

        const arrayBuffer = await response.arrayBuffer();
        return Buffer.from(arrayBuffer);
    } catch (groqError) {
        console.warn("Canopy TTS failed; trying Deepgram fallback:", groqError.message);
        return generateSpeechWithDeepgram(text);
    }
}

/**
 * Generates WAV audio with Deepgram Aura when Canopy TTS is unavailable.
 * @param {string} text - Text to synthesize.
 * @returns {Promise<Buffer>} Audio WAV buffer.
 */
async function generateSpeechWithDeepgram(text) {
    if (!process.env.DEEPGRAM_API_KEY) {
        throw new Error("DEEPGRAM_API_KEY is required for the TTS fallback");
    }

    const response = await fetch(
        "https://api.deepgram.com/v1/speak?model=aura-asteria-en&encoding=linear16&sample_rate=24000&container=wav",
        {
            method: "POST",
            headers: {
                Authorization: `Token ${process.env.DEEPGRAM_API_KEY}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify({ text }),
        },
    );

    if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(`Deepgram TTS failed (${response.status}): ${errorBody}`);
    }

    return Buffer.from(await response.arrayBuffer());
}