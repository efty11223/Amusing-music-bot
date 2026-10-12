const { createAudioResource, AudioPlayerStatus } = require("@discordjs/voice");
const { spawn, spawnSync } = require("node:child_process");
const ffmpeg = require("ffmpeg-static");
const play = require("play-dl");
const path = require("path");
const fs = require("fs");

function resolveYtDlpPath() {
    if (process.env.YT_DLP_PATH && fs.existsSync(process.env.YT_DLP_PATH)) {
        return { command: process.env.YT_DLP_PATH, args: ['-f', 'bestaudio', '--no-playlist', '--quiet', '-o', '-', 'URL'] };
    }

    const candidates = [
        path.join(process.env.APPDATA || '', 'Python', 'Python314', 'Scripts', 'yt-dlp.exe'),
        path.join(process.env.APPDATA || '', 'Python', 'Python313', 'Scripts', 'yt-dlp.exe'),
        path.join(process.env.APPDATA || '', 'Python', 'Python312', 'Scripts', 'yt-dlp.exe'),
        path.join(process.env.APPDATA || '', 'Python', 'Python311', 'Scripts', 'yt-dlp.exe'),
        path.join(process.env.APPDATA || '', 'Python', 'Python310', 'Scripts', 'yt-dlp.exe'),
        path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Python', 'Python314', 'Scripts', 'yt-dlp.exe'),
        path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Python', 'Python313', 'Scripts', 'yt-dlp.exe'),
        path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Python', 'Python312', 'Scripts', 'yt-dlp.exe')
    ];

    const actualPath = candidates.find((candidate) => candidate && fs.existsSync(candidate));
    if (actualPath) {
        return { command: actualPath, args: ['-f', 'bestaudio', '--no-playlist', '--quiet', '-o', '-', 'URL'] };
    }

    const pythonFallbacks = process.platform === 'win32' ? ['py', 'python', 'python3'] : ['python3', 'python'];
    for (const python of pythonFallbacks) {
        try {
            const probe = spawnSync(python, ['-m', 'yt_dlp', '--version'], { stdio: 'ignore' });
            if (probe.status === 0) {
                return { command: python, args: ['-m', 'yt_dlp', '-f', 'bestaudio', '--no-playlist', '--quiet', '-o', '-', 'URL'] };
            }
        } catch (err) {
            // Ignore and keep trying.
        }
    }

    return null;
}

function createYoutubeAudioStream(url) {
    return new Promise((resolve, reject) => {
        const ytDlpConfig = resolveYtDlpPath();
        if (!ytDlpConfig) {
            return reject(new Error('yt-dlp was not found. Install it with: py -m pip install yt-dlp'));
        }

        const ytDlp = spawn(ytDlpConfig.command, ytDlpConfig.args.map((arg) => (arg === 'URL' ? url : arg)), {
            stdio: ['ignore', 'pipe', 'pipe'],
            shell: false
        });

        let ytDlpError = '';
        ytDlp.stderr.on('data', (chunk) => {
            ytDlpError += chunk.toString();
        });

        ytDlp.on('error', (err) => reject(new Error(`Failed to start yt-dlp: ${err.message}`)));

        const ffmpegProcess = spawn(ffmpeg, ['-i', 'pipe:0', '-f', 's16le', '-ar', '48000', '-ac', '2', 'pipe:1'], {
            stdio: ['pipe', 'pipe', 'pipe'],
            shell: false
        });

        let ffmpegError = '';
        ffmpegProcess.stderr.on('data', (chunk) => {
            ffmpegError += chunk.toString();
        });

        ffmpegProcess.stdin.on('error', (err) => {
            if (err.code !== 'EPIPE') {
                console.error(`ffmpeg input stream error: ${err.message}`);
            }
        });

        ffmpegProcess.on('error', (err) => reject(new Error(`Failed to start ffmpeg: ${err.message}`)));

        ytDlp.stdout.pipe(ffmpegProcess.stdin);

        ytDlp.on('close', (code) => {
            if (code !== 0) {
                reject(new Error(`yt-dlp failed while resolving YouTube audio: ${ytDlpError || 'unknown yt-dlp error'}`));
            }
        });

        ffmpegProcess.on('close', (code) => {
            if (ytDlp.exitCode === null && !ytDlp.killed) {
                ytDlp.kill();
            }
            if (code !== 0 && !ffmpegError.includes('Output file')) {
                reject(new Error(`ffmpeg failed while converting YouTube audio: ${ffmpegError || 'unknown ffmpeg error'}`));
            }
        });

        resolve(ffmpegProcess.stdout);
    });
}

async function playNext(guildId, message, queues) {
    const playerObj = queues.get(guildId);
    if (!playerObj) return;

    if (playerObj.queue.length === 0) {
        console.log(`[${guildId}] Queue finished. Disconnecting.`);
        if (playerObj.connection && !playerObj.connection.destroyed) {
            playerObj.player.stop();
            playerObj.connection.destroy();
        }
        queues.delete(guildId);
        if (message && message.channel) {
            message.channel.send("✅ Queue finished! Disconnected.");
        }
        return;
    }

    const nextItem = playerObj.queue[0];
    let resource;

    if (!nextItem || !nextItem.source) {
        console.error(`[${guildId}] Invalid song object retrieved. Skipping.`);
        if (message && message.channel) {
            message.channel.send("❌ Error: Malformed song data encountered, skipping...");
        }
        return playNext(guildId, message, queues);
    }

    try {
        if (nextItem.type === 'local') {
            const filePath = path.resolve(__dirname, nextItem.source);
            resource = createAudioResource(filePath);

        } else if (nextItem.type === 'youtube') {
            const youtubeStream = await createYoutubeAudioStream(nextItem.source);
            resource = createAudioResource(youtubeStream, {
                inputType: 'raw',
                inlineVolume: true
            });

        } else if (nextItem.type === 'soundcloud') {
            const yt_info = await play.stream(nextItem.source, {
                discordPlayerCompatibility: true
            });

            resource = createAudioResource(yt_info.stream, {
                inputType: yt_info.type,
                inlineVolume: true
            });
        }

        playerObj.player.play(resource);
        if (message && message.channel) {
            message.channel.send(`🎶 Now playing: **${nextItem.title}** (${nextItem.type})`);
        }
    } catch (err) {
        console.error("Error playing item:", err);
        playerObj.queue.shift();
        if (message && message.channel) {
            message.channel.send(`❌ Error playing **${nextItem.title}**, skipping...`);
        }
        playNext(guildId, message, queues);
    }
}

module.exports = {
    createYoutubeAudioStream,
    playNext,
    resolveYtDlpPath,
};
