const path = require("path");
const fs = require("fs");
const { joinVoiceChannel, createAudioPlayer, AudioPlayerStatus, VoiceConnectionStatus } = require("@discordjs/voice");
const { clearIdleDisconnect, playNext } = require("./music");

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
      try {
        const info = await play.video_basic_info(source);
        itemType = "youtube";
        itemSource = source;
        itemTitle = info.video_details.title;
      } catch (e) {
        console.error("YouTube lookup failed:", e);
        return message.reply("❌ Error accessing that YouTube video. It may be geo-blocked or invalid.");
      }
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
