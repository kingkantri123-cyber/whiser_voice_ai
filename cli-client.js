import fs from "fs";
import path from "path";
import os from "os";
import readline from "readline";
import { spawn, execSync } from "child_process";

const SERVER_URL = process.env.SERVER_URL || "http://localhost:3000";
const TEMP_AUDIO_PATH = path.join(os.tmpdir(), "user_input.wav");
const RESPONSE_AUDIO_PATH = path.join(os.tmpdir(), "agent_response.wav");

/**
 * Plays audio file using OS native media players.
 */
function playAudio(filePath) {
    const platform = os.platform();
    try {
        if (platform === "darwin") {
            execSync(`afplay "${filePath}"`);
        } else if (platform === "win32") {
            // Use Windows Media Player COM object for reliable background playback
            const normalizedPath = filePath.replace(/\\/g, "/");
            const psCommand = `
        $wm = New-Object -ComObject WMPlayer.OCX;
        $wm.URL = '${normalizedPath}';
        $wm.controls.play();
        Start-Sleep -m 300;
        while ($wm.playState -eq 3 -or $wm.playState -eq 6 -or $wm.playState -eq 9) {
          Start-Sleep -m 100
        }
      `.replace(/\n/g, " ");

            execSync(`powershell -c "${psCommand}"`, { stdio: "ignore" });
        } else {
            execSync(`aplay "${filePath}" || paplay "${filePath}" || ffplay -nodisp -autoexit "${filePath}"`);
        }
    } catch (e) {
        console.log("  (Could not play response audio)");
    }
}

/**
 * Starts recording audio from system microphone.
 */
function startRecording() {
    const platform = os.platform();
    if (platform === "darwin") {
        // Built-in native macOS audio recorder
        return spawn("afrecord", ["-f", "WAVE", "-c", "1", "-r", "16000", TEMP_AUDIO_PATH]);
    } else if (platform === "win32") {
        // Requires SoX or FFmpeg on Windows
        return spawn("sox", ["-t", "waveaudio", "default", TEMP_AUDIO_PATH]);
    } else {
        // Built-in Linux ALSA recorder
        return spawn("arecord", ["-f", "S16_LE", "-r", "16000", "-c", "1", TEMP_AUDIO_PATH]);
    }
}

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
});

const prompt = (query) => new Promise((resolve) => rl.question(query, resolve));

async function main() {
    console.log("==========================================");
    console.log("    Terminal Voice Ordering Client       ");
    console.log("==========================================");

    // 1. Initialize session
    const sessionRes = await fetch(`${SERVER_URL}/api/session`, { method: "POST" });
    if (!sessionRes.ok) {
        console.error("Failed to connect to server. Ensure server.js is running.");
        process.exit(1);
    }
    const { sessionId } = await sessionRes.json();
    console.log(`Session initialized: ${sessionId}`);

    let sessionActive = true;

    while (sessionActive) {
        await prompt("\n👉 Press [ENTER] to START speaking...");

        console.log("🎙️  Recording... Press [ENTER] to STOP.");
        const recProcess = startRecording();

        await prompt(""); // Wait for enter key to stop recording
        recProcess.kill("SIGINT");

        // Wait briefly for audio file write completion
        await new Promise((r) => setTimeout(r, 300));

        if (!fs.existsSync(TEMP_AUDIO_PATH) || fs.statSync(TEMP_AUDIO_PATH).size === 0) {
            console.log("❌ Audio recording was empty. Please try speaking again.");
            continue;
        }

        console.log("⚡ Processing turn via Groq & Gemini...");

        // 2. Send recorded WAV file to server
        const audioBuffer = fs.readFileSync(TEMP_AUDIO_PATH);
        const blob = new Blob([audioBuffer], { type: "audio/wav" });
        const formData = new FormData();
        formData.append("sessionId", sessionId);
        formData.append("audio", blob, "user_input.wav");

        try {
            const res = await fetch(`${SERVER_URL}/api/voice-chat`, {
                method: "POST",
                body: formData,
            });

            if (!res.ok) {
                const errData = await res.json();
                console.error("Server error:", errData);
                continue;
            }

            const data = await res.json();

            console.log(`\n👤 You: "${data.userText}"`);
            console.log(`🤖 Agent: "${data.replyText}"`);

            // 3. Play response audio
            if (data.audioBase64) {
                const responseAudioBuf = Buffer.from(data.audioBase64, "base64");
                fs.writeFileSync(RESPONSE_AUDIO_PATH, responseAudioBuf);
                playAudio(RESPONSE_AUDIO_PATH);
            }

            // 4. Check if order was completed or call was ended
            if (data.cart && data.cart.placed) {
                console.log("\n==========================================");
                console.log("🎉 ORDER PLACED SUCCESSFULLY!");
                console.log(`Total: $${data.cart.total}`);
                console.log("Items in Order:", JSON.stringify(data.cart.lines, null, 2));
                console.log("==========================================");
                sessionActive = false;
            } else if (data.sessionStatus === "ended") {
                console.log("\nCall ended.");
                sessionActive = false;
            }
        } catch (err) {
            console.error("Failed to process turn:", err.message);
        }
    }

    rl.close();
    process.exit(0);
}

main();