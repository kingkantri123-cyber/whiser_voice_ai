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
 * Generates spoken audio from text using Groq TTS (Orpheus).
 * @param {string} text - Text to synthesize.
 * @param {string} voice - Voice model (e.g., 'hannah', 'austin', 'troy').
 * @returns {Promise<Buffer>} Audio WAV buffer.
 */
export async function generateSpeech(text, voice = "hannah") {
    const response = await groq.audio.speech.create({
        model: "canopylabs/orpheus-v1-english",
        voice: voice,
        input: text,
        response_format: "wav", // Orpheus only supports wav, not mp3
    });

    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
}