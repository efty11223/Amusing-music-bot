const path = require("path");
const fs = require("fs");
const { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus, VoiceConnectionStatus } = require("@discordjs/voice");
const { clearIdleDisconnect, createSeekAudioStream, playNext } = require("./music");

function parseTimestamp(value) {
  if (/^\d+$/.test(value)) {
    const seconds = Number(value);
    return Number.isSafeInteger(seconds) ? seconds : null;
  }

  const parts = value.split(":");
  if (parts.length !== 2 && parts.length !== 3) return null;
  if (!parts.every((part) => /^\d+$/.test(part))) return null;

  const numbers = parts.map(Number);
  if (!numbers.every(Number.isSafeInteger)) return null;

  const seconds = numbers[numbers.length - 1];
  const minutes = numbers.length === 2 ? numbers[0] : numbers[1];
  if (seconds > 59 || (numbers.length === 3 && minutes > 59)) return null;

  const totalSeconds = numbers.length === 2
    ? numbers[0] * 60 + seconds
    : numbers[0] * 3600 + minutes * 60 + seconds;
  return Number.isSafeInteger(totalSeconds) ? totalSeconds : null;
}

function formatTimestamp(totalSeconds) {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
    : `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function leaveGuildVoice(message, queues) {
  const guildId = message.guild.id;
  const playerObj = queues.get(guildId);

  if (!playerObj) {
    return message.reply("❌ I'm not in a voice channel right now.");
  }

  clearIdleDisconnect(playerObj);
  queues.delete(guildId);

  if (playerObj.player) {
    playerObj.player.stop();
  }

  if (playerObj.connection && playerObj.connection.state.status !== VoiceConnectionStatus.Destroyed) {
    playerObj.connection.destroy();
  }

  return message.reply("👋 Left the voice channel.");
}

async function handleCommand(message, queues, play) {
  if (message.author.bot) return;

  const prefix = process.env.PREFIX || "!";
  if (!message.content.startsWith(prefix)) return;

  const args = message.content.slice(prefix.length).trim().split(/ +/);
  const command = args.shift().toLowerCase();
  const source = args[0];
  const query = args.join(" ");

  if (command === "help") {
    return message.reply({
      embeds: [{
        color: 0xeea990,
        title: "Music Bot Commands",
        description: [
          `\`${prefix}play <song, URL, or file>\` - Play or queue music`,
          `\`${prefix}queue\` - Show the current queue`,
          `\`${prefix}pause\` - Pause playback`,
          `\`${prefix}resume\` - Resume playback`,
          `\`${prefix}seek <timestamp>\` - Jump to a time (seconds, \`MM:SS\`, or \`HH:MM:SS\`)`,
          `\`${prefix}skip\` / \`${prefix}next\` - Skip the current track`,
          `\`${prefix}stop\` - Stop playback and leave voice`,
          `\`${prefix}leave\` - Leave voice`,
          `\`${prefix}help\` - Show this command list`,
        ].join("\n"),
      }],
    });
  }

  if (command === "play") {
    if (!query) return message.reply("❌ Provide a filename, URL, or search query.");
    if (!message.member.voice.channel) return message.reply("❌ Join a voice channel first!");

    let itemType;
    let itemSource;
    let itemTitle;

    const isYouTubeUrl = /(?:youtube\.com|youtu\.be|youtube-nocookie\.com)/i.test(source);
    const isSoundCloudUrl = /soundcloud\.com/i.test(source);
    const sourceValidation = await play.validate(source).catch(() => null);

    if (isSoundCloudUrl || sourceValidation === "soundcloud" || sourceValidation === "soundcloud_track") {
      try {
        const info = await play.soundcloud(source);
        itemType = "soundcloud";
        itemSource = source;
        itemTitle = info.title;
      } catch (e) {
        console.error("SoundCloud lookup failed:", e);
        return message.reply("❌ Error accessing that SoundCloud track. It may be private or invalid.");
      }
    } else if (isYouTubeUrl || sourceValidation === "yt_video" || sourceValidation === "video") {
      itemType = "youtube";
      itemSource = source;
      itemTitle = source;
    } else {
      const filePath = path.resolve(__dirname, source);
      if (fs.existsSync(filePath)) {
        itemType = "local";
        itemSource = source;
        itemTitle = source;
      } else {
        try {
          message.channel.send(`:mag_right: Searching YouTube for: **${query}**...`);

          const searchResults = await play.search(query, { limit: 1 });
          if (searchResults.length === 0) {
            return message.reply("❌ Could not find any search results for that query. Try a specific URL.");
          }

          const result = searchResults[0];
          itemType = "youtube";
          itemSource = result.url;
          itemTitle = result.title;
        } catch (e) {
          console.error("YouTube search error:", e);
          return message.reply("❌ An unexpected error occurred during the YouTube search.");
        }
      }
    }

    const queueItem = { type: itemType, source: itemSource, title: itemTitle };

    if (itemType === "youtube" && isYouTubeUrl) {
      try {
        await message.suppressEmbeds(true);
      } catch (error) {
        console.error("Could not suppress the YouTube link preview:", error);
        await message.channel.send("⚠️ I couldn't hide the preview on your command message. Please give me the Manage Messages permission to hide it.");
      }
    }

    let playerObj = queues.get(message.guild.id);
    if (!playerObj) {
      const connection = joinVoiceChannel({
        channelId: message.member.voice.channel.id,
        guildId: message.guild.id,
        adapterCreator: message.guild.voiceAdapterCreator,
      });

      const player = createAudioPlayer();

      player.on("error", (error) => {
        console.error(`[Audio Player Error] Code: ${error.code} | Message: ${error.message}`);
        player.stop();
      });

      player.on(AudioPlayerStatus.Idle, async () => {
        if (!playerObj || queues.get(message.guild.id) !== playerObj) return;

        if (playerObj.isTransitioning) return;
        playerObj.isTransitioning = true;

        try {
          if (
            playerObj.streamFailure &&
            playerObj.currentItem &&
            playerObj.queue[0] &&
            playerObj.queue[0].source === playerObj.currentItem.source &&
            playerObj.streamFailure.source === playerObj.currentItem.source
          ) {
            const failedItem = playerObj.currentItem;
            failedItem.retryCount = (failedItem.retryCount || 0) + 1;
            const retryError = playerObj.streamFailure.error;
            playerObj.streamFailure = null;

            if (failedItem.retryCount <= 2) {
              console.error(
                `[${message.guild.id}] Stream interrupted; retrying ${failedItem.title} (${failedItem.retryCount}/2): ${retryError}`,
              );
              message.channel.send(
                `⚠️ Stream interrupted. Retrying **${failedItem.title}**...`,
              );
              await playNext(message.guild.id, message, queues);
              return;
            }

            console.error(
              `[${message.guild.id}] Stream retry limit reached for ${failedItem.title}: ${retryError}`,
            );
            playerObj.queue.shift();
            message.channel.send(
              `❌ Could not recover **${failedItem.title}** after 2 retries. Skipping...`,
            );
            await playNext(message.guild.id, message, queues);
            return;
          }

          if (playerObj.queue.length === 0) {
            if (playerObj.idleTimer) return;
            await playNext(message.guild.id, message, queues);
            return;
          }

          playerObj.queue.shift();
          await playNext(message.guild.id, message, queues);
        } finally {
          playerObj.isTransitioning = false;
        }
      });

      connection.subscribe(player);

      playerObj = { connection, player, queue: [], isTransitioning: false };
      queues.set(message.guild.id, playerObj);
    }

    playerObj.queue.push(queueItem);

    if (playerObj.player.state.status === AudioPlayerStatus.Idle) {
      playNext(message.guild.id, message, queues);
    } else {
      message.channel.send(`➕ Added to queue: **${itemTitle}**`);
    }

    return;
  }

  if (command === "queue") {
    const playerObj = queues.get(message.guild.id);
    if (!playerObj || playerObj.queue.length === 0) {
      return message.reply("❌ The queue is empty.");
    }

    const current = playerObj.player.state.status === AudioPlayerStatus.Playing ? "🎶 Currently playing" : "⏸ Paused";
    const upcoming = playerObj.queue
      .map((item, i) => `${i === 0 ? "▶ **[CURRENT]**" : `${i}.`} **${item.title}** (${item.type})`)
      .join("\n") || "Nothing else in queue.";

    return message.reply(`${current}\n${upcoming}`);
  }

  if (command === "pause") {
    const playerObj = queues.get(message.guild.id);
    if (!playerObj || !playerObj.player) {
      return message.reply("❌ Nothing is playing right now.");
    }

    if (playerObj.player.state.status === AudioPlayerStatus.Paused) {
      return message.reply("⏸ The music is already paused.");
    }

    playerObj.player.pause();
    return message.reply("⏸ Music paused.");
  }

  if (command === "resume") {
    const playerObj = queues.get(message.guild.id);
    if (!playerObj || !playerObj.player) {
      return message.reply("❌ Nothing is playing right now.");
    }

    if (playerObj.player.state.status !== AudioPlayerStatus.Paused) {
      return message.reply("▶ The music is already playing.");
    }

    playerObj.player.unpause();
    return message.reply("▶ Music resumed.");
  }

  if (command === "seek") {
    const targetSeconds = parseTimestamp(source || "");
    if (args.length !== 1 || targetSeconds === null) {
      return message.reply(`❌ Provide a timestamp as seconds, \`MM:SS\`, or \`HH:MM:SS\` (for example, \`${prefix}seek 1:45\`).`);
    }

    const guildId = message.guild.id;
    const playerObj = queues.get(guildId);
    const currentItem = playerObj && playerObj.queue[0];
    if (!playerObj || !playerObj.player || !currentItem ||
        (playerObj.player.state.status !== AudioPlayerStatus.Playing &&
         playerObj.player.state.status !== AudioPlayerStatus.Paused)) {
      return message.reply("❌ Nothing is currently playing.");
    }

    if (playerObj.isTransitioning) {
      return message.reply("❌ Please wait until the current track transition finishes.");
    }

    const seekRequest = (playerObj.seekRequest || 0) + 1;
    playerObj.seekRequest = seekRequest;

    try {
      const audioStream = await createSeekAudioStream(currentItem, targetSeconds);
      if (queues.get(guildId) !== playerObj ||
          playerObj.queue[0] !== currentItem ||
          playerObj.seekRequest !== seekRequest ||
          (playerObj.player.state.status !== AudioPlayerStatus.Playing &&
           playerObj.player.state.status !== AudioPlayerStatus.Paused)) {
        audioStream.stream.destroy();
        return message.reply("❌ The track changed before I could seek. Try again on the current track.");
      }

      const wasPaused = playerObj.player.state.status === AudioPlayerStatus.Paused;
      const resource = createAudioResource(audioStream.stream, {
        inputType: audioStream.type || "raw",
        inlineVolume: true
      });
      playerObj.player.play(resource);
      if (wasPaused) playerObj.player.pause();

      return message.reply(`⏩ Jumped to ${formatTimestamp(targetSeconds)}.`);
    } catch (error) {
      console.error("Error seeking in track:", error);
      return message.reply("❌ I couldn't seek in this track. Please try again or restart it.");
    }
  }

  if (command === "skip" || command === "next") {
    const playerObj = queues.get(message.guild.id);
    if (!playerObj || !playerObj.player || playerObj.queue.length === 0) {
      return message.reply("❌ There is nothing to skip.");
    }

    const skipped = playerObj.queue.shift();
    message.reply(`⏭ Skipped: **${skipped.title}**`);
    return playNext(message.guild.id, message, queues);
  }

  if (command === "stop") {
    const playerObj = queues.get(message.guild.id);
    if (!playerObj) {
      return message.reply("❌ Nothing is playing right now.");
    }

    clearIdleDisconnect(playerObj);
    queues.delete(message.guild.id);

    if (playerObj.player) {
      playerObj.player.stop();
    }

    if (playerObj.connection && playerObj.connection.state.status !== VoiceConnectionStatus.Destroyed) {
      playerObj.connection.destroy();
    }

    return message.reply("⏹ Stopped the music and left the voice channel.");
  }

  if (command === "leave") {
    return leaveGuildVoice(message, queues);
  }
}

module.exports = {
  handleCommand,
};
