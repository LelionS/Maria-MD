// plugins.js
const fs = require('fs');
const path = require('path');
const pino = require('pino');
const chalk = require('chalk');
const NodeCache = require('node-cache');
const readline = require('readline');
const qrcode = require('qrcode-terminal');

const { default: makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, jidDecode, proto, makeCacheableSignalKeyStore, downloadContentFromMessage } = require("@whiskeysockets/baileys");
const { makeInMemoryStore } = require("@naanzitos/baileys-make-in-memory-store"); // ✅ fixed store

const { smsg } = require('./Gallery/lib/myfunc'); // your helper functions
const { writeExifImg, writeExifVid, imageToWebp, videoToWebp } = require('./Gallery/lib/exif');

// -------------------- CONFIG --------------------
const store = makeInMemoryStore({ logger: pino().child({ level: 'silent' }) });
const msgRetryCounterCache = new NodeCache(); // Retry message cache

// Read owner info
let owner = JSON.parse(fs.readFileSync('./Gallery/database/owner.json'));

// Readline for pairing code (optional)
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const question = (text) => new Promise(resolve => rl.question(text, resolve));

// -------------------- START BOT --------------------
async function startMaria() {
    const { version } = await fetchLatestBaileysVersion();
    const { state, saveCreds } = await useMultiFileAuthState('./session');

    const Maria = makeWASocket({
        logger: pino({ level: 'silent' }),
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "fatal" }).child({ level: "fatal" })),
        },
        msgRetryCounterCache
    });

    // Bind store to listen for updates
    store.bind(Maria.ev);

    // -------------------- CONNECTION HANDLER --------------------
    Maria.ev.on("connection.update", (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.log(chalk.yellow("Scan this QR code with WhatsApp:"));
            qrcode.generate(qr, { small: true });
        }

        if (connection === "open") console.log(chalk.green("✅ Maria is connected!"));

        if (connection === "close") {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== 401;
            console.log("Connection closed. Reconnecting?", shouldReconnect);
            if (shouldReconnect) startMaria();
        }
    });

    // Save creds
    Maria.ev.on("creds.update", saveCreds);

    // -------------------- MESSAGE HANDLER --------------------
    Maria.ev.on("messages.upsert", async (chatUpdate) => {
        try {
            const mek = chatUpdate.messages[0];
            if (!mek.message) return;
            mek.message = Object.keys(mek.message)[0] === 'ephemeralMessage' ? mek.message.ephemeralMessage.message : mek.message;

            const m = smsg(Maria, mek, store);
            require("./Heart")(Maria, m, chatUpdate, store);
        } catch (err) {
            console.log("Error handling message:", err);
        }
    });

    // -------------------- HELPER FUNCTIONS --------------------
    Maria.decodeJid = (jid) => {
        if (!jid) return jid;
        if (/:\d+@/gi.test(jid)) {
            let decode = jidDecode(jid) || {};
            return decode.user && decode.server ? decode.user + '@' + decode.server : jid;
        } else return jid;
    };

    Maria.sendText = (jid, text, quoted = '', options = {}) =>
        Maria.sendMessage(jid, { text, ...options }, { quoted, ...options });

    Maria.sendImageAsSticker = async (jid, path, quoted, options = {}) => {
        let buff = Buffer.isBuffer(path)
            ? path
            : /^data:.*?\/.*?;base64,/i.test(path)
                ? Buffer.from(path.split`,`[1], 'base64')
                : /^https?:\/\//.test(path)
                    ? await (await fetch(path)).arrayBuffer()
                    : fs.existsSync(path)
                        ? fs.readFileSync(path)
                        : Buffer.alloc(0);

        let buffer = (options.packname || options.author) ? await writeExifImg(buff, options) : await imageToWebp(buff);

        await Maria.sendMessage(jid, { sticker: { url: buffer }, ...options }, { quoted });
        return buffer;
    };

    Maria.sendVideoAsSticker = async (jid, path, quoted, options = {}) => {
        let buff = Buffer.isBuffer(path)
            ? path
            : /^data:.*?\/.*?;base64,/i.test(path)
                ? Buffer.from(path.split`,`[1], 'base64')
                : /^https?:\/\//.test(path)
                    ? await (await fetch(path)).arrayBuffer()
                    : fs.existsSync(path)
                        ? fs.readFileSync(path)
                        : Buffer.alloc(0);

        let buffer = (options.packname || options.author) ? await writeExifVid(buff, options) : await videoToWebp(buff);

        await Maria.sendMessage(jid, { sticker: { url: buffer }, ...options }, { quoted });
        return buffer;
    };

    Maria.downloadAndSaveMediaMessage = async (message, filename, attachExtension = true) => {
        let quoted = message.msg ? message.msg : message;
        let mime = (message.msg || message).mimetype || '';
        let messageType = message.mtype ? message.mtype.replace(/Message/gi, '') : mime.split('/')[0];
        const stream = await downloadContentFromMessage(quoted, messageType);
        let buffer = Buffer.from([]);
        for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);

        let type = await import('file-type').then(m => m.fileTypeFromBuffer(buffer));
        let trueFileName = attachExtension ? filename + '.' + type.ext : filename;

        fs.writeFileSync(trueFileName, buffer);
        return trueFileName;
    };

    return Maria;
}

// Start bot
startMaria().catch(console.error);

// Watch for updates
let file = require.resolve(__filename);
fs.watchFile(file, () => {
    fs.unwatchFile(file);
    console.log(chalk.redBright(`Updated ${__filename}`));
    delete require.cache[file];
    require(file);
});
